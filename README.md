# dsh-plugin-python

给 DeepSeek Harness（DSH）增加一个模型可调用的 `python` 工具：用 Harness **自带的 Python 运行时**执行代码，无需安装任何东西。

运行环境：Python 3.12.14，捆绑 numpy 2.3.5 / pandas 3.0.1 / python-docx / python-pptx / openpyxl / Pillow / lxml / XlsxWriter。

| 能力 | 状态 |
| --- | --- |
| 执行代码、返回 stdout | ✅ `[exit code: 0]` |
| 中文 / UTF-8 输出 | ✅ 强制 `PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8` |
| 非零退出 + stderr 分离 | ✅ `[exit code: 1]` + traceback |
| `args` / `stdin` | ✅ `sys.argv[1:]`、`sys.stdin` |
| `workdir`（相对路径按会话工作区解析） | ✅ |
| `files` 多文件（辅助模块 / 数据 / 子目录） | ✅ `import helpers`、`Path(__file__).parent` |
| `timeoutMs` 超时终止 | ✅ `[timed out after 1500 ms]` |
| 临时目录清理 | ✅ 抛错路径也不泄漏 |
| 越界路径拦截（`files` / `workdir` 的 `../`） | ✅ 拒绝 |

## 文件与安装

> **首次安装**：先在本目录运行 `install.ps1`（Windows）或 `node install.mjs`（macOS/Linux）。
> 脚本按当前目录自动生成 `cordis.patch.yml`（已 `.gitignore`），不写死任何盘符。

### 缺少环境怎么办（默认自动安装）

安装时 `install.ps1` **默认静默安装**缺失环境；只想检查时加 `-CheckOnly`：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
# 只检查、不安装：
powershell -ExecutionPolicy Bypass -File .\install.ps1 -CheckOnly
```

插件加载时也会在后台运行 `bootstrap.ps1 -AutoInstall -Quiet`（6 小时内不重复），不阻塞 DSH 启动；首次装完可能需要重试工具。

- **Python**：优先用 DSH 自带运行时（`dsh-runtimes\*\dependencies\python\python.exe`）；没有则 `winget install Python.Python.3.12 --scope user`。
- 也可以设置 `DSH_PYTHON` 或插件配置里的 `pythonPath` 指向任意 Python 3.11+。
- 关闭自动安装：patch 的 `config` 里设 `autoInstall: false`，或设置环境变量 `DSH_BOOTSTRAP=0`。


| 文件 | 作用 |
| --- | --- |
| `lib/python.js` | Host 侧插件：注册 `python` 工具 |
| `cordis.patch.yml.tpl` | bundle 补丁层模板；install 脚本生成 `cordis.patch.yml` |
| `package.json` | 包元数据（`type: module`，无任何运行时依赖）+ `dsh.bundle` 声明 |

本包是**可安装的 DSH bundle**，因此在 GUI 的「设置 → 插件」里可见、可整体启用/停用：

```powershell
plugin_manager install_bundle  file:<本目录的绝对路径>
# 装完 profile 的 package.json 里会同时出现：
#   dsh.profile.bundles: ["...", "dsh-plugin-python"]
#   dependencies:        {"dsh-plugin-python": "file:<本目录的绝对路径>"}
# 卸载：GUI 插件页移除，或 plugin_manager remove_bundle dsh-plugin-python
```

> 机制：pnpm 会把本包**复制**到 `<profile>/node_modules/dsh-plugin-python`，而
> `cordis.patch.yml` 里挂的是**工作区绝对路径**的 `lib/python.js`，所以改插件代码
> 只需重启 DSH 即可生效（ESM 按 URL 缓存，不会热替换已激活的 fiber）；
> 只有改了 `cordis.patch.yml`（挂载参数）才需要重新 `install_bundle` 刷新那份副本。
>
> 为什么不能只写 `cordis.patch.yml` 里的 `insert`：那样确实能挂载，但**不会出现在
> GUI 的插件页**（那一页列的是已安装的 bundle/inventory）。bundle 化之后两种能力都有。

## 工具参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `code` | ✅ | 要执行的 Python 源码（写入 `main.py`） |
| `description` | ✅ | 5–10 词的动作描述（UI 展示） |
| `files` | | `[{ path, content }]`，写入运行目录；用 `import 名字` 导入模块，用 `Path(__file__).parent` 读数据文件 |
| `workdir` | | 进程工作目录，默认会话工作区；相对路径按会话工作区解析，越界（`..` 或工作区外的绝对路径）会被拒绝 |
| `args` | | 追加的命令行参数 |
| `stdin` | | 管道输入文本 |
| `timeoutMs` | | 超时毫秒数，到期终止进程 |

> 注意：进程工作目录是**会话工作区**，不是脚本目录。`files` 里的数据文件要用 `Path(__file__).parent` 解析；要留下产物则直接写工作区路径。

## 配置项（条目 `config`）

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `pythonPath` | 自动 | 指定解释器；默认按 `runtime.json` 找捆绑运行时，找不到才回退 PATH 上的 `python` |
| `cwd` | 会话工作区 | 默认工作目录 |
| `timeoutMs` | `120000` | 默认超时 |
| `graceMs` | `3000` | 终止宽限期 |
| `maxOutputBytes` | `200000` | 单流收集上限，超出部分落盘并给出 `spillPath` |
| `keepScript` | `false` | 保留临时脚本并回报 `scriptPath` |

## 设计要点

1. **零宿主依赖**：模块只 `import` Node 内置模块，不导入任何 `@deepseek-ai/*`。原因是工作区里的插件没有可达的 `node_modules`，而把 `dsh-tools` 作为真依赖安装会连带装入**第二份 `cordis`**（等于进程里出现第二个工具注册表）。
2. **原始 JSON Schema 方言**：直接向 `ctx.tools.register` 传定义（不走 `defineTool`），对象层用 `required: [...]` 数组，`oneOf` 节点不挂同级关键字。
3. **沙箱合规**：每次调用 `ctx.sandboxPolicy.resolve({ session })`；非 `danger-full-access` 时用 `ctx.sandbox.confine(argv, policy)` 包一层再 spawn；需要隔离却没有沙箱提供者时 **fail closed**，绝不静默不隔离。
4. **进程与输出**：`ctx.subprocess.spawn` + collect 模式，`terminate()` 处理超时，`readFrom(0)` 读流，超限自动落盘。
5. **清理**：`mkdtemp` 之后的所有步骤都在 `try/finally` 内，任何异常都会删除临时目录（这条是被测试抓出来的真实 bug）。

## 验证记录

**离线真机测试**：`.tooling/test-python-plugin.mjs` —— 因为插件零依赖，可以用普通 Node 直接加载，并把 `ctx` 打桩后用**真实子进程**跑全部路径：

```
PASS  basic + unicode              PASS  args + stdin
PASS  multi-file import + data     PASS  timeout terminates
PASS  exit code + stderr           PASS  path escape rejected
PASS  workdir inside honoured      PASS  workdir escape rejected
PASS  temp dirs cleaned
9/9 passed
```

**线上验证**（运行中的 DSH）：`plugin-python-4` = enabled + active（`plugin-python` / `plugin-python-2` / `plugin-python-3` 已停用）；
`files` 多文件调用返回 `live after move: moved-to-python_hk` / `data: k,v | x,1`，`[exit code: 0]`。

> ⚠️ **改动生效时机**：运行中的 fiber 按 URL 缓存旧模块，改文件内容不会换来新实现。2026-10-06 给 `workdir` 加上越界拦截后，正是按 §4 坑③ 做的热替换（新 id `plugin-python-4` + 停用 `plugin-python-3`），**免重启即时生效**：重挂后线上 `workdir: "../.."` 立即被拒绝，而工作区内的 `workdir` 仍照常可用。

---

# DSH 插件怎么写（依据安装包内官方文档整理）

来源：`@deepseek-ai/cordis-plugin-loader/README.md`、`@deepseek-ai/dsh-tools/README.md`。

## 1. 插件模块形态

```js
export const name = "plugin-python";            // 身份
export const inject = ["tools", "subprocess"];  // 激活前必须就绪的服务
export const Config = z.object({ ... });        // @deepseek-ai/schemastery（可选）
export function apply(ctx, config) { ... }      // 挂载逻辑，产物由 fiber 托管
```

`ctx.get("x")` 取**可选**服务（自行判空）；`inject` 里的服务在 `ctx.x` 上必然存在。

## 2. Loader 条目选项

| 字段 | 说明 |
| --- | --- |
| `id` | 稳定标识，用于 resolve / update / remove |
| `name` | loader 导入的模块 specifier（包名、相对路径或绝对路径） |
| `config` | 传给 `apply` 的配置 |
| `group` | 该条目是组，`config` 是子条目列表 |
| `disabled` | 停用条目 |
| `inject` | 为条目追加必需服务 |

## 3. 注册工具

```js
ctx.tools.register(defineTool({
  name: "read_file",
  description: "Read a file from disk.",
  parameters: { path: { type: "string", required: true, description: "Absolute file path" } },
  output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
  async execute(args, exec) { return readFile(args.path, { encoding: "utf8", signal: exec.signal }); }
}));
```

- 参数 DSL：`string / number / integer / boolean / null / array / object / json / oneOf`，`required: true` 写在**属性上**。
- `output.schema` 是**值**的 schema，`render` 返回内容块；注册即生效，schema 自动进系统提示。
- `presentCall` / `presentResult` 只给 Host 侧消费者；**内置 Web 客户端不消费它们**，卡片由客户端从原始调用参数推导。
- 策略扩展点：`tools/pre-execute`、`ctx.tools.guard()`、`tools/execute`、`tools/post-execute`、`tools/result`。

## 4. ⚠️ 三个实测坑

**① 工作区插件没有 `node_modules`。** 写 `import { defineTool } from "@deepseek-ai/dsh-tools"` 会在导入阶段失败，而 loader 只报一句 `failed to import`（真实原因是 `ERR_MODULE_NOT_FOUND`）。三条路：不导入宿主包直接注册原始定义（本插件采用）；用 `createRequire(<resources>/app.asar/dsh/package.json)` 复用宿主模块实例；或作为 profile bundle 正规安装。

**② 两套 schema 方言。** 参数用属性级 `required: true`；**原始 JSON Schema** 的对象要在对象层写 `required: [...]`，写成属性级会报 `JsonSchemaError: ... required is not supported on type "string"`。另外 `additionalProperties` 只接受布尔值。

**③ 改完代码（或搬了目录）不会自动生效。** ESM 模块按 URL 缓存：替换文件内容后重挂条目，fiber 拿到的还是旧模块（现象：条目 `active` 但工具 schema 依旧是旧的）。两种办法：重启 DSH；或换一个**新的条目 id**（新 id → 新 fiber → 新 URL 导入），并把旧 id 用 `disabled: true` 停掉——本插件三次迁移（换实现、搬进 `python_hk`、加 `workdir` 守卫）都是这样热替换的，现用 id 为 `plugin-python-4`。

## 5. 起进程：subprocess + sandbox

```js
const policy = ctx.get("sandboxPolicy")?.resolve({ session: exec.agent.session });
let argv = [pythonPath, scriptPath];
if (policy && policy.mode !== "danger-full-access") {
  const confined = await ctx.get("sandbox").confine(argv, policy, exec.signal);
  argv = confined.argv;                     // 必须换成 confine 返回的 argv
}
const handle = ctx.subprocess.spawn({
  argv, cwd, graceMs, signal: exec.signal,
  stdio: { stdin: "ignore", stdout: { maxBytes, spill: { maxBytes } }, stderr: { maxBytes, spill: { maxBytes } } },
  env: { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }
});
const outcome = await handle.done;                        // { exitCode, signal }
const text = handle.collected.stdout.readFrom(0).text;    // 非消费式、按偏移读取
```

## 6. Windows 上的 Python 细节

捆绑解释器的 `sys.stdout.encoding` 默认是 **gbk**（locale cp936），不设 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8` 时中文输出会乱码。

## 7. 工具链

| 工具 | 用途 |
| --- | --- |
| `.tooling/test-python-plugin.mjs` | 打桩 `ctx` + 真实子进程的离线测试（9 项断言，含 `workdir` 越界拦截与合法放行） |

> `asar.mjs`（读取 Electron `app.asar` 的辅助脚本）已于 2026-10-06 随工作区清理删除；需要时从 `%TEMP%\dsh-workspace-cleanup-20261006-141447.zip` 取回。

---

## 可移植性 / 换机器安装

这个仓库**不包含本机绝对路径**：`cordis.patch.yml` 由安装脚本按当前目录生成（已 `.gitignore`）。

换一台机器：

1. `git clone` 本仓库到任意目录；
2. 运行 `powershell -ExecutionPolicy Bypass -File .\install.ps1`（Windows）或 `node install.mjs`（macOS/Linux）；
3. 在 DSH 里执行 `plugin_manager install_bundle  file:<本目录的绝对路径>`。

### 运行环境

- **Windows / macOS / Linux 均可**：插件只用 Node 内置模块。
- **Python**：默认按 `runtime.json` 找 DSH 自带运行时；找不到时回退 PATH 上的 `python`，也可在 patch 的 `config.pythonPath` 指定。
- 不额外安装任何 Python 包；捆绑运行时自带 numpy / pandas / python-docx / python-pptx / openpyxl / Pillow / lxml / XlsxWriter。
