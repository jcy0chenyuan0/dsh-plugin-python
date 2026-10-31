/**
 * dsh-plugin-python — the model-facing `python` tool.
 *
 * Runs Python source with the runtime the Harness already ships
 * (`<DSH_HOME>/dsh-runtimes/<runtime>/dependencies/python`), so a session gets
 * numpy, pandas, python-docx, python-pptx, openpyxl, Pillow, lxml and
 * XlsxWriter without installing anything.
 *
 * Each call writes its snippet to a temporary directory, spawns it through the
 * `subprocess` seam under the calling session's resolved sandbox policy, and
 * returns exit facts plus captured stdout/stderr. In a confining mode the argv
 * is wrapped by `ctx.sandbox.confine` before spawning; when confinement is
 * required but no sandbox provider is mounted, the call fails closed instead of
 * running unconfined.
 *
 * ## Why this module imports nothing from the Harness
 *
 * A plugin mounted by absolute path out of a workspace has no reachable
 * `node_modules`, so `import { defineTool } from "@deepseek-ai/dsh-tools"`
 * fails at import time with a `failed to import` entry error whose cause the
 * loader does not print. Declaring those packages as real dependencies is
 * worse: `dsh-tools` pulls in `@deepseek-ai/cordis`, so a second copy would
 * register a second tools registry inside the process.
 *
 * This plugin therefore depends on nothing but Node built-ins and the `ctx` it
 * is handed. Tool definitions are registered as raw JSON Schema, which is the
 * exact wire dialect the registry enforces:
 *
 * - parameters and output objects carry object-level `required: [...]` arrays
 *   (author-facing per-property `required: true` belongs to `defineTool`
 *   input, not to raw registration);
 * - `oneOf` nodes take no sibling keywords.
 *
 * @module dsh-plugin-python
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { scheduleBootstrap } from "./bootstrap.js";

/** Cordis plugin identity. */
export const name = "plugin-python";

/** Services this plugin requires before the Loader activates it. */
export const inject = ["tools", "subprocess"];

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_GRACE_MS = 3_000;
const DEFAULT_MAX_OUTPUT_BYTES = 200_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Force UTF-8 on both sides: the bundled Windows interpreter defaults to cp936 otherwise. */
const ENV_OVERRIDES = {
	PYTHONIOENCODING: "utf-8",
	PYTHONUTF8: "1",
	PYTHONUNBUFFERED: "1",
	PYTHONDONTWRITEBYTECODE: "1"
};

/** Documented configuration keys, with defaults. Config is validated in `apply`. */
export const CONFIG_DEFAULTS = {
	timeoutMs: DEFAULT_TIMEOUT_MS,
	graceMs: DEFAULT_GRACE_MS,
	maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
	keepScript: false
};

/** The Harness home that owns installed runtime payloads. */
function harnessHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/** The interpreter inside one runtime payload directory, per platform. */
function payloadInterpreter(root) {
	return process.platform === "win32"
		? join(root, "dependencies", "python", "python.exe")
		: join(root, "dependencies", "python", "bin", "python3");
}

/**
 * Locate the interpreter of a runtime payload that matches this platform and
 * architecture. Payloads are discovered through their own `runtime.json`
 * manifest, so an installation that carries its payload elsewhere still
 * resolves, and a machine with no payload returns `undefined` (the caller then
 * falls back to a `python` on PATH).
 * @returns The interpreter path and recorded version, or undefined.
 */
async function bundledPython() {
	const directory = process.env.DSH_RUNTIMES ?? join(harnessHome(), "dsh-runtimes");
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return undefined;
	}
	const candidates = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const root = join(directory, entry.name);
		let manifest;
		try {
			manifest = JSON.parse(await readFile(join(root, "runtime.json"), "utf8"));
		} catch {
			manifest = undefined;
		}
		if (manifest?.platform !== undefined && manifest.platform !== process.platform) continue;
		if (manifest?.arch !== undefined && manifest.arch !== process.arch) continue;
		const interpreter = payloadInterpreter(root);
		if (!existsSync(interpreter)) continue;
		candidates.push({
			interpreter,
			...(typeof manifest.python === "string" ? { version: manifest.python } : {})
		});
	}
	candidates.sort((left, right) => left.interpreter.localeCompare(right.interpreter));
	return candidates[0];
}

/** Model-facing capability text; mirrors the house style of the shell tools. */
const DESCRIPTION = [
	"Execute Python 3 source and return its stdout/stderr. The interpreter is the runtime bundled with the Harness, which already provides numpy, pandas, python-docx, python-pptx, openpyxl, Pillow, lxml and XlsxWriter; there is no need to install packages or create a virtual environment for those.",
	"Each call is a fresh interpreter: `code` is written to `main.py` in a temporary run directory and executed once, so define everything a run needs inside that snippet. Pass `files` to place helper modules, data files, or assets beside it: import helpers by bare module name, and resolve data with `Path(__file__).parent` because the process working directory stays the session workspace. Write files through normal Python APIs when a run must leave artifacts behind.",
	"`workdir` defaults to the session workspace; a relative path resolves against it, and a path escaping the session workspace is rejected. Unicode and Chinese text are safe in both directions — the process is forced to UTF-8.",
	"Non-zero exits are reported as `[exit code: N]`; stderr is returned separately. Long output is truncated and the complete stream is spilled to a file whose path is reported when available. Pass `timeoutMs` to bound a slow run; on expiry the process is terminated."
].join("\n\n");

/**
 * Read one collected stream into canonical JSON.
 * @param reader - Offset-based non-consuming reader for that stream.
 * @returns Captured text, its lossy flag, and the spill path when one exists.
 */
function readStream(reader) {
	const read = reader.readFrom(0);
	return {
		text: read.text,
		truncated: read.lossy,
		...(read.spillPath !== undefined ? { spillPath: read.spillPath } : {})
	};
}

/**
 * One completed execution, in the shape the output schema enforces.
 * @param fields - Exit facts and captured streams.
 * @returns The canonical tool value.
 */
function completed(fields) {
	return {
		exitCode: fields.exitCode,
		signal: fields.signal,
		timedOut: fields.timedOut,
		aborted: fields.aborted,
		timeoutMs: fields.timeoutMs,
		elapsedMs: fields.elapsedMs,
		stdout: fields.stdout,
		stderr: fields.stderr,
		...(fields.python !== undefined ? { python: fields.python } : {}),
		...(fields.scriptPath !== undefined ? { scriptPath: fields.scriptPath } : {}),
		...(fields.sandbox !== undefined ? { sandbox: fields.sandbox } : {})
	};
}

/** The empty result of a call that never reached a running process. */
function unfinished(timeoutMs, startedAt, extra = {}) {
	return completed({
		exitCode: null,
		signal: null,
		timedOut: false,
		aborted: true,
		timeoutMs,
		elapsedMs: Date.now() - startedAt,
		stdout: { text: "", truncated: false },
		stderr: { text: "", truncated: false },
		...extra
	});
}

/** Render one result as the model-facing text block. */
function renderResult(value) {
	const sections = [];
	if (value.stdout.text.length > 0) sections.push(value.stdout.text.replace(/\n+$/u, ""));
	if (value.stderr.text.length > 0) sections.push(`[stderr]\n${value.stderr.text.replace(/\n+$/u, "")}`);
	sections.push(value.aborted
		? "[aborted]"
		: value.timedOut
			? `[timed out after ${value.timeoutMs} ms]`
			: `[exit code: ${value.exitCode ?? "null"}]`);
	const notes = [];
	if (value.stdout.truncated) notes.push(`stdout truncated${value.stdout.spillPath !== undefined ? `, full stream: ${value.stdout.spillPath}` : ""}`);
	if (value.stderr.truncated) notes.push(`stderr truncated${value.stderr.spillPath !== undefined ? `, full stream: ${value.stderr.spillPath}` : ""}`);
	if (value.sandbox !== undefined) notes.push(`sandbox: ${value.sandbox.mode}`);
	if (value.scriptPath !== undefined) notes.push(`script kept: ${value.scriptPath}`);
	if (notes.length > 0) sections.push(notes.join(" · "));
	return [{
		type: "text",
		text: sections.join("\n")
	}];
}

/** The stream shape both captured streams share. */
const STREAM_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		text: {
			type: "string"
		},
		truncated: {
			type: "boolean"
		},
		spillPath: {
			type: "string",
			description: "File holding the complete stream when it was truncated."
		}
	},
	required: ["text", "truncated"]
};

/**
 * Compile the declared tool into one registration object.
 * @param hooks - The resolved runtime hooks the execute body closes over.
 * @returns A raw tool definition in the enforced JSON Schema dialect.
 */
function pythonTool(hooks) {
	return {
		name: "python",
		description: DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				code: {
					type: "string",
					description: "Python source to execute as one script. Imports, function and class definitions, and the top-level statements that drive them all belong in this string."
				},
				description: {
					type: "string",
					description: "Clear, concise description of what this code does in active voice, 5-10 words (shown in the UI). Examples: \"Aggregate the CSV into monthly totals\"; \"Render the deck to PDF\"."
				},
				files: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							path: {
								type: "string",
								description: "Path relative to the run directory, for example \"helpers.py\" or \"data/rows.csv\"."
							},
							content: {
								type: "string",
								description: "Full text of that file."
							}
						},
						required: ["path", "content"]
					},
					description: "Extra files written into the temporary run directory beside main.py. Subdirectories are created. Import them as modules by bare name (the script directory is on sys.path), and read data files through Path(__file__).parent — the process working directory stays the session workspace."
				},
				workdir: {
					type: "string",
					description: "Working directory for this run. Defaults to the session workspace; a relative path is resolved against it, and a path that escapes the session workspace is rejected."
				},
				args: {
					type: "array",
					items: {
						type: "string"
					},
					description: "Additional command-line arguments passed to the script after its path (available as sys.argv[1:])."
				},
				stdin: {
					type: "string",
					description: "Text piped to the process on stdin. Omit it and stdin reads as empty."
				},
				timeoutMs: {
					type: "number",
					description: "Timeout in milliseconds. On expiry the process is terminated and the result reports the timeout instead of an exit code."
				}
			},
			required: ["code", "description"]
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					exitCode: {
						oneOf: [{ type: "integer" }, { type: "null" }]
					},
					signal: {
						oneOf: [{ type: "string" }, { type: "null" }]
					},
					timedOut: {
						type: "boolean"
					},
					aborted: {
						type: "boolean"
					},
					timeoutMs: {
						type: "number"
					},
					elapsedMs: {
						type: "number"
					},
					stdout: STREAM_SCHEMA,
					stderr: STREAM_SCHEMA,
					python: {
						type: "string",
						description: "Interpreter actually executed."
					},
					scriptPath: {
						type: "string",
						description: "Temporary script retained because keepScript is enabled."
					},
					sandbox: {
						type: "object",
						additionalProperties: false,
						properties: {
							mode: {
								type: "string"
							},
							enforcement: {
								type: "string"
							}
						},
						required: ["mode"]
					}
				},
				required: ["exitCode", "signal", "timedOut", "aborted", "timeoutMs", "elapsedMs", "stdout", "stderr"]
			},
			render: (_args, value) => renderResult(value)
		},
		async execute(args, exec) {
			return await hooks.run(args, exec);
		},
		presentCall: (args) => ({
			card: "terminal",
			title: typeof args.description === "string" && args.description.length > 0 ? args.description : "python",
			description: typeof args.code === "string" ? args.code.split("\n")[0].slice(0, 120) : "python",
			...(typeof args.workdir === "string" ? { cwd: args.workdir } : {})
		})
	};
}

/** Reject a config value that is not a usable finite number in range. */
function requireNumber(name, value, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
	if (!Number.isFinite(value) || value < min || value > max) throw new Error(`python: ${name} must be a finite number between ${min} and ${max}`);
	return value;
}

/** Reject a config value that is not a non-empty string. */
function requireText(name, value) {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`python: ${name} must be a non-empty string`);
	return value;
}

/** Reject malformed model arguments before anything is written or spawned. */
function validateCall(args) {
	if (typeof args.code !== "string" || args.code.trim().length === 0) throw new Error("invalid code: expected a non-empty string");
	if (typeof args.description !== "string" || args.description.trim().length === 0) throw new Error("invalid description: expected a non-empty string");
	if (args.files !== undefined) {
		if (!Array.isArray(args.files)) throw new Error("invalid files: expected an array of { path, content } entries");
		for (const entry of args.files) {
			if (typeof entry !== "object" || entry === null) throw new Error("invalid files: every entry must be an object with path and content");
			if (typeof entry.path !== "string" || entry.path.trim().length === 0) throw new Error("invalid files: every entry needs a non-empty relative path");
			if (typeof entry.content !== "string") throw new Error(`invalid files["${entry.path}"]: expected a string`);
		}
	}
	if (args.args !== undefined && (!Array.isArray(args.args) || args.args.some((value) => typeof value !== "string"))) throw new Error("invalid args: expected an array of strings");
	if (args.stdin !== undefined && typeof args.stdin !== "string") throw new Error("invalid stdin: expected a string");
	if (args.workdir !== undefined && (typeof args.workdir !== "string" || args.workdir.trim().length === 0)) throw new Error("invalid workdir: expected a non-empty string");
	if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`);
}

/**
 * Resolve the working directory for one call.
 *
 * The path is always resolved against the session workspace (falling back to the
 * configured `cwd`) and must stay inside it: a `..` escape, or an absolute path
 * outside that anchor, is rejected instead of being handed to the child as its
 * `cwd` — mirroring the guard the `files` entries already get.
 */
function resolveWorkdir(requested, exec, configured) {
	const sessionCwd = exec.agent?.session.header.cwd;
	const anchor = sessionCwd ?? configured;
	if (requested === undefined) return anchor ?? process.cwd();
	const resolved = anchor === undefined ? resolve(requested) : resolve(anchor, requested);
	if (anchor === undefined) return resolved;
	const inside = relative(anchor, resolved);
	if (inside.startsWith("..") || isAbsolute(inside)) throw new Error("invalid workdir: path escapes the session workspace");
	return resolved;
}

/**
 * Register the `python` tool.
 * @param ctx - Tool registry owner, with the subprocess seam available.
 * @param config - Interpreter, deadline, output and cleanup settings.
 */
export function apply(ctx, config = {}) {
	scheduleBootstrap(config);
	const timeoutLimit = requireNumber("timeoutMs", config.timeoutMs ?? DEFAULT_TIMEOUT_MS, { min: Number.MIN_VALUE, max: MAX_TIMER_DELAY_MS });
	const graceMs = requireNumber("graceMs", config.graceMs ?? DEFAULT_GRACE_MS);
	const maxOutputBytes = requireNumber("maxOutputBytes", config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, { min: Number.MIN_VALUE });
	const keepScript = config.keepScript === true;
	const configuredPython = config.pythonPath === undefined
		? (process.env.DSH_PYTHON || undefined)
		: requireText("pythonPath", config.pythonPath);
	const configuredCwd = config.cwd === undefined ? undefined : requireText("cwd", config.cwd);

	let discovered;
	/** Resolve the interpreter once, preferring the bundled payload. */
	const resolvePython = async (signal) => {
		if (configuredPython !== undefined) return { interpreter: await ctx.subprocess.resolveExecutable(configuredPython, ENV_OVERRIDES, signal) };
		discovered ??= await bundledPython();
		if (discovered !== undefined) return discovered;
		for (const candidate of (process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"])) {
			try {
				return { interpreter: await ctx.subprocess.resolveExecutable(candidate, ENV_OVERRIDES, signal) };
			} catch (error) {
				if (signal?.aborted) throw error;
			}
		}
		throw new Error("dsh-plugin-python: 找不到 Python，请安装 Python 3.11+，或在 config.pythonPath / DSH_PYTHON / DSH_PYTHON 指定解释器");
	};

	/**
	 * Run one call: materialize the script, resolve the sandbox policy, spawn,
	 * and collect.
	 * @param args - Validated model arguments.
	 * @param exec - Execution context carrying the agent, call id and signal.
	 * @returns The canonical result value.
	 */
	const run = async (args, exec) => {
		validateCall(args);
		const timeoutMs = args.timeoutMs ?? timeoutLimit;
		if (timeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`invalid timeoutMs: must be no greater than ${MAX_TIMER_DELAY_MS}`);
		const startedAt = Date.now();
		const python = await resolvePython(exec.signal);
		const workdir = resolveWorkdir(args.workdir, exec, configuredCwd);
		if (exec.signal.aborted) return unfinished(timeoutMs, startedAt, { python: python.interpreter });

		const directory = await mkdtemp(join(tmpdir(), "dsh-python-"));
		const scriptPath = join(directory, "main.py");
		try {
			await writeFile(scriptPath, args.code, "utf8");
			for (const file of args.files ?? []) {
				const target = resolve(directory, file.path);
				const inside = relative(directory, target);
				if (inside.startsWith("..") || isAbsolute(inside) || inside.length === 0) throw new Error(`invalid files["${file.path}"]: path escapes the run directory`);
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, file.content, "utf8");
			}
			let argv = [python.interpreter, scriptPath, ...(args.args ?? [])];
			let sandbox;
			const policy = ctx.get("sandboxPolicy")?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session });
			if (policy !== undefined && policy.mode !== "danger-full-access") {
				const confiner = ctx.get("sandbox");
				if (confiner === undefined) throw new Error(`python: this session runs in ${policy.mode} mode but no sandbox provider is mounted; refusing to run unconfined`);
				const confined = await confiner.confine(argv, {
					mode: policy.mode,
					workspaceRoot: policy.workspaceRoot,
					...(policy.sessionId !== undefined ? { sessionId: policy.sessionId } : {})
				}, exec.signal);
				argv = confined.argv;
				sandbox = {
					mode: policy.mode,
					enforcement: confined.enforcement
				};
			}

			/**
			 * Start the process. A provider refuses a pre-aborted signal
			 * synchronously, which is a cancellation rather than a failure.
			 */
			const handle = (() => {
				try {
					return ctx.subprocess.spawn({
						argv,
						cwd: workdir,
						stdio: {
							stdin: args.stdin !== undefined ? { data: args.stdin } : "ignore",
							stdout: {
								maxBytes: maxOutputBytes,
								spill: { maxBytes: maxOutputBytes * 8 }
							},
							stderr: {
								maxBytes: maxOutputBytes,
								spill: { maxBytes: maxOutputBytes * 8 }
							}
						},
						graceMs,
						signal: exec.signal,
						env: { ...ENV_OVERRIDES }
					});
				} catch (error) {
					if (exec.signal.aborted) return undefined;
					throw new Error(`python: failed to start ${python.interpreter}: ${String(error)}`);
				}
			})();
			if (handle === undefined) return unfinished(timeoutMs, startedAt, { python: python.interpreter, ...(keepScript ? { scriptPath } : {}), ...(sandbox !== undefined ? { sandbox } : {}) });

			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				try {
					handle.terminate();
				} catch {
					/* the provider already settled the process */
				}
			}, timeoutMs);
			let outcome;
			try {
				outcome = await handle.done;
			} finally {
				clearTimeout(timer);
			}
			const { stdout, stderr } = handle.collected;
			if (stdout === undefined || stderr === undefined) throw new Error("python: subprocess provider dropped a requested collect stream");
			return completed({
				exitCode: outcome.exitCode,
				signal: outcome.signal,
				timedOut,
				aborted: exec.signal.aborted,
				timeoutMs,
				elapsedMs: Date.now() - startedAt,
				stdout: readStream(stdout),
				stderr: readStream(stderr),
				python: python.interpreter,
				...(keepScript ? { scriptPath } : {}),
				...(sandbox !== undefined ? { sandbox } : {})
			});
		} finally {
			if (!keepScript) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
		}
	};

	ctx.tools.register(pythonTool({ run }));
}
