# check-environment — 问题日志 / 经验沉淀

> 本文件是「自我完善闭环」的沉淀地。每次遇到规则未覆盖的乱码/报错场景，
> 追加一条（日期 + Command + Observed + Root cause + Fix + 是否已更新标准）。
> 它是**机器本地**文件（被 .gitignore 忽略），不随技能分发——通用修复应归纳进 SKILL.md。
>
> **plugin 自动追加**（opencode 用户）：encoding-guard 插件在 `tool.execute.after`
> 检测到 `\uFFFD` 时自动写入乱码案例。agent 仍需补 Root cause / Fix / 标准更新。

## 2026-08-14 — 基线：已确认根因（Windows 中文环境）

1. **PowerShell 自身输出中文乱码**：PS 5.1 默认 `OutputEncoding=GB2312` → GBK 字节按 UTF-8 解码 → `\uFFFD`。
   - Fix：命令首条 `$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;`（之前无输出）。
2. **命令内联中文字面量不可靠**：PS→node/python 边界引号与字节被破坏。
   - Fix：node `\uXXXX` 转义；PS `[char]0x4E2D`；中文走环境变量。
3. **PS `Get-Content` 读文件必乱码**（含 `-Encoding UTF8`、含守卫）。
   - Fix：内置 Read 工具 / `node readFileSync(...,'utf8')`；GBK 用 `TextDecoder('gbk')`。
4. **包管理器由 lockfile 决定**：`pnpm-lock.yaml` → `pnpm`，勿用 `npm` 跑 pnpm 项目。
5. **npx 联网拉新**：优先本地 `node_modules/.bin`（`pnpm exec`），缺失才 `npx --no-install`。
6. **PowerShell 执行策略 RemoteSigned**：.ps1 统一 `-NoProfile -ExecutionPolicy Bypass -File`。
7. **node 24 直接跑 TS**（type stripping），TS 专属语法报错再 `pnpm dlx tsx`。
8. **UTF-8 守卫必须是命令首条、之前无输出**。

## 2026-08-14 — 新案例

### PS 5.1 向 node 传内联 JSON 引号被剥（`--grant '{json}'` 失效）
- **Command**: `node setup.mjs --grant '{"apiKeys":{"zhipu":"sk"}}'`
- **Observed**: `Invalid JSON for --grant: Expected property name or '}' in JSON at position 1`（argv 只剩 `{apiKeys:...}`，引号全丢）
- **Root cause**: PowerShell 5.1 向原生程序传参时，内联双引号被剥掉，JSON 结构破坏（与中文字面量同源：PS→程序边界）。
- **Fix**: 新增 `--grant-file <path.json>`（JSON 放文件里传）；`--grant` 失败时错误提示指引用文件方式。
- **Standard updated?**: yes（SKILL.md §1 + README 环境检测节 + setup.mjs 错误提示）

### `Set-Content -Encoding UTF8` 写出的文件带 BOM，JSON.parse 拒收
- **Command**: `Set-Content -LiteralPath patch.json -Value '{"a":1}' -Encoding UTF8`
- **Observed**: `Unexpected token '﻿' ... is not valid JSON`（UTF-8 BOM `\uFEFF` 在字符串首位）
- **Root cause**: PS 5.1 的 `-Encoding UTF8` 写 BOM；node JSON.parse 不剥 BOM 直接报错。
- **Fix**: setup.mjs 读文件后 `if (raw.charCodeAt(0)===0xfeff) raw=raw.slice(1)`；写测试文件用 node `writeFileSync(...,'utf8')`（无 BOM）。
- **Standard updated?**: yes（SKILL.md §5 文件读取补"勿用 PS -Encoding UTF8 写文件"）

<!-- 新条目从此往下追加 -->
