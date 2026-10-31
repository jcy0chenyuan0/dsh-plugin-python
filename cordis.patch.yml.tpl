# dsh-plugin-python 的 profile 补丁层模板
# 由 install.ps1 / install.mjs 生成同目录的 cordis.patch.yml（已 .gitignore）。
#
# id 与历史上手工挂载用的 `plugin-python-4` 保持一致：同一个 id 会被 loader
# 视为已存在而不重复插入。
- insert:
    - id: plugin-python-4
      name: '{{LIB}}'
