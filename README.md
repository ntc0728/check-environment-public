# check-environment — Agent 技能：环境探测与编码防乱码

给 AI 代理（Claude Code / Cursor / opencode / Codex / Windsurf / Copilot）用的环境感知技能。

- **探测环境**：工具版本、项目 lockfile（决定包管理器）、npm registry、shell 类型
- **一次选对命令**：按 lockfile 决定 pnpm/npm/yarn/bun，优先本地 `.bin`，避免「先试默认→报错→换」的浪费
- **根治 Windows 中文乱码**：UTF-8 守卫、中文字面量转义、文件读取防乱码
- **权限协议**：自动检测环境 → 缺失工具向用户申请权限 → 拒绝则明确提示「哪些工具/命令不可用」+ 降级方案
- **自我完善闭环**：遇到新乱码/新报错自动沉淀进问题日志，技能越用越准
- **循环检测（可选钩子）**：同命令重复、连续失败、输出高度相似时中断并报告

## 快速开始

```bash
# 1. 放到 agent 的 skills 目录（以 ~/.claude/skills 为例）
cp -r skills/check-environment ~/.claude/skills/

# 2. 检测环境（自动，无需输入）
node ~/.claude/skills/check-environment/scripts/setup.mjs --report

# 3. 可选：装多平台乱码守卫钩子
node ~/.claude/skills/check-environment/hooks/install.mjs
```

对 **opencode**：技能放 `~/.config/opencode/skills/`；推荐同时安装配套插件（见下）。

> **钩子是优化项，不是前提条件。** 无论是否安装，agent 都应自己把 UTF-8 守卫写在命令首条。
> 钩子检测到已存在的守卫会幂等跳过，不会重复注入。

## 环境检测与权限协议（非"配置向导"）

检测是**全自动**的，不要求用户填任何配置。agent 开始工作前跑一次：

```bash
node scripts/setup.mjs --check     # JSON（agent 读）：tools + unrecognized + permissionRequests
node scripts/setup.mjs --report    # 人读摘要
```

工作方式（协议）：

1. **自动检测**本机有哪些工具、哪些无法识别（`unrecognized` 带影响/降级/申请权限信息）。
2. 需要缺失的**必填工具**（node/git）时，agent **向用户申请权限**（做什么 + 影响 + 安装命令），同意才装。
3. **用户拒绝 → agent 必须明确提示**哪些工具/命令不可用 + 降级方案，再走 fallback，绝不默默换命令。
4. 可选工具缺失且任务不依赖 → 直接降级，不打扰。
5. 用户**主动授权**的覆盖（自定义 node 路径、registry 等）由 agent 记录到本地配置：

```bash
node scripts/setup.mjs --grant nodePath=C:\custom\node.exe
node scripts/setup.mjs --grant '{ "npmRegistry": "https://registry.npmmirror.com" }'
node scripts/setup.mjs --status     # 查看（密钥脱敏）
node scripts/setup.mjs --revoke     # 清除
```

> 本地配置 `~/.config/check-environment/config.json` 只存用户明确授权的覆盖，非必需、不入库。

## 可选钩子：encoding-guard（自动守卫，多平台）

在命令执行前注入 UTF-8 守卫，执行后检测乱码特征（`\uFFFD`）写入问题日志，并做循环检测。

**支持所有主流 agent**（同一份核心脚本 + 各平台决策格式）：

| 平台 | 机制 | 安装 |
|------|------|------|
| **Claude Code** | PreToolUse/PostToolUse 钩子 | `node hooks/install.mjs` |
| **Cursor** | preToolUse/postToolUse 钩子 | `node hooks/install.mjs` |
| **Codex CLI** | PreToolUse/PostToolUse + feature flag | `node hooks/install.mjs`（自动开 `codex_hooks=true`）|
| **opencode** | JS 插件（函数钩子 API） | `node hooks/install.mjs` |

**一键安装**（检测已装的 agent，幂等合并，不覆盖现有 hooks）：

```bash
node hooks/install.mjs                  # 装到所有检测到的 agent
node hooks/install.mjs --list           # 查看各 agent 状态
node hooks/install.mjs --only claude    # 只装某个（claude/cursor/codex/opencode）
node hooks/install.mjs --dry-run        # 预演不改动
node hooks/install.mjs --uninstall      # 卸载我们加进去的钩子
```

**核心脚本独立可用**（可作为任意钩子系统的手动注册目标）：

```bash
# 任何平台的手写 hooks 里注册：
node /path/to/hooks/encoding-guard.mjs --format=claude   # 或 cursor / codex
```

工作方式：

- **前置**（PreToolUse）：命令是 PowerShell 且**未带守卫**时，通过平台 `updatedInput`/`updated_input` 注入 UTF-8 守卫并放行；已带守卫（`chcp 65001` 或 `$OutputEncoding=`）直接透传；node/git-bash/posix 命令透传。**绝不破坏正常命令**（fail-open）。
- **后置**（PostToolUse）：扫描输出含 `\uFFFD` → 归类去重 → 追加到问题日志 → 该类别首次出现时把规则回写标准文件。
- **循环检测**：同命令重复 ≥8 次 / 5min、连续失败 ≥3 次、输出相似度 Jaccard ≥0.8 连续 3 次、3 种方法切换无进展 → 中断并报告。测试报告里的 `PASS: FAIL (expected)`、`Some tests FAILED` 等文本不会被误判为失败。
- 零依赖、纯 Node ESM、永不阻塞（正常路径 exit 0）。

> Codex 注意：PreToolUse 默认只覆盖 shell 命令；apply_patch/MCP 等暂不过钩子（官方限制）。旧版 Codex 可能忽略 `updatedInput` 改写（早期仅 deny），届时守卫不注入但命令照常执行——不影响使用。

## 目录结构

```
├── README.md
├── config.example.json
├── skills/check-environment/
│   ├── SKILL.md                  # 技能主文件（agent 加载的核心）
│   ├── hooks/                    # 自包含：复制整个目录即可用
│   │   ├── encoding-guard-core.mjs   # 共享核心（守卫/归类/循环检测/路径解析）
│   │   ├── encoding-guard.mjs        # Claude/Cursor/Codex stdin-stdout 适配器
│   │   ├── opencode-plugin.js        # opencode 插件适配器（安装为 encoding-guard.js）
│   │   └── install.mjs               # 多平台一键安装器（幂等合并）
│   └── scripts/
│       ├── setup.mjs             # 环境检测 + 权限协议（check/report/grant/revoke）
│       ├── probe.ps1             # 环境快照（Windows PowerShell）
│       └── probe.sh              # 环境快照（POSIX / git-bash）
└── tests/                        # 零依赖自测（node tests/*.test.mjs）
```

### 自测

```bash
node tests/guard-core.test.mjs     # 守卫注入 / 错误识别 / 循环检测 / 归类
node tests/hook-adapter.test.mjs   # claude/cursor/codex 三种决策格式的端到端行为
```

## 兼容性与平台

| 平台 | 编码章节 | 探测/配置 | 说明 |
|------|---------|----------|------|
| Windows + 中文 | ✅ 核心价值 | ✅ | 完整功能 |
| Windows + 英文 | 无乱码问题 | ✅ | 编码章节自动跳过 |
| macOS / Linux | 无乱码问题 | ✅ | 用 `probe.sh` / `setup.mjs`，钩子自动跳过 PowerShell 守卫 |

## 为什么这样做（背景）

Windows PowerShell 5.1 默认输出编码是 GB2312（CP 936）。AI 代理在 Windows 上跑命令时，
PowerShell 自身打印的中文（`Write-Output`/字符串插值）会发出 GBK 字节，被代理按 UTF-8 解码
成 `\uFFFD` 乱码；外部程序（node/git/tsc/vite）写出的 UTF-8 也会因控制台代码页是 CP936 被按
GBK 解码。这不是某个代理的 bug，而是**编码层不匹配**，必须在命令层根治：
`chcp 65001` 翻转代码页 + `$OutputEncoding=UTF8`，且守卫必须是命令首条（一旦发出过字节，编码就锁死）。

## 安全与隐私

- 分发版**不含任何密钥/绝对路径**，所有用户特定信息存本地 `config.json`
- 本地配置只存用户**主动授权**的覆盖（自定义路径/registry），`apiKeys` 支持但不强制，密钥只在本地文件（`.gitignore` 建议忽略）
- 建议把 `~/.config/check-environment/config.json` 加入全局 gitignore
- 钩子不联网、不读取命令以外内容；问题日志与状态文件只写本地

## 自我完善（贡献新经验）

任何用户遇到规则未覆盖的乱码/报错，按 SKILL.md §6 追加到 `~/.config/check-environment/issues.md`
并更新 SKILL.md。**鼓励把新案例通过 PR 回传给本仓库**，让技能对所有人变准。

## License

MIT
