---
name: check-environment
description: >
  Detect and configure the machine's development environment before running commands.
  Use this skill at the start of every session to prevent encoding garbled text (U+FFFD),
  PowerShell 5.1 compatibility issues, file operation pitfalls on Windows, and missing tools.
  Covers: UTF-8 encoding guards, PowerShell 7 shell detection, package manager lockfile matching,
  line-ending (CRLF/LF) handling, temp directory paths, BOM-free file writing, and loop detection.
  Automatically runs `setup.mjs --check` to detect tools, report missing ones with fallbacks,
  and request user permission before installing.
  The optional encoding-guard hook additionally watches for repetition loops (same command x8,
  consecutive failures, output similarity) and halts with a report.
  Safe on macOS/Linux (skips Windows-specific rules).
metadata:
  short-description: Environment detection and encoding safeguards for Windows/macOS/Linux
---

# check-environment

> **适用平台**：Windows（PowerShell 5.1/7、git-bash）。macOS/Linux 用户也安全（无编码乱码问题，仅跳过编码章节）。
> **前置依赖**：node（唯一硬依赖，用于 `setup.mjs`）。
> **安装**：见 `README.md`（自动检测，无需手动配置）。

## 1. 环境检测与权限协议（每次会话开始）

**检测是自动的，不要求用户填任何配置。** 开始工作前运行一次：

```
node scripts/setup.mjs --check     # JSON，给 agent 读
node scripts/setup.mjs --report    # 人读版（给用户看的摘要）
```

`--check` 输出四块关键信息：

1. **`tools`** — 每个工具的实际状态：`found`（是否存在）+ `onPath`（是否在 PATH）+ `via`（怎么发现的）+ `path` + `version`。
2. **`unrecognized`** — 无法识别/不可用的工具或命令，每项带：`label` + `impact`（影响）+ `required`（是否必需）+ `fallback`（降级方案）+ `permission`（若要装它的操作）。
3. **`availableOffPath`** — **装了但不在 PATH** 的工具（含 `path` 与 `via`）。agent 可直接用绝对路径，或向用户申请把它加进 PATH。
4. **`permissionRequests`** — 需要**向用户申请权限**的动作清单（如安装缺失工具、启用 registry 覆盖）。

**工具发现顺序（五级，避免误报"缺失"）**：
① 配置覆盖（`config.nodePath`，用户授权过）→ ② PATH → ③ 环境变量指向的目录（`NVM_HOME`/`NVM_DIR`/`FNM_DIR`/`VOLTA_HOME`/`PNPM_HOME`/`NODE_HOME`/`PYTHON_HOME`/`BUN_INSTALL` 等）→ ④ 版本管理器/包管理器目录（nvm/fnm/volta/scoop）→ ⑤ 常见安装位置（Program Files、`.bun/bin`、`~/.cargo/bin` 等）。**用户工具装在非默认位置时不会误报缺失**；被识别的会进 `availableOffPath`，agent 直接用它或提示用户加 PATH。node 若经版本管理器/自定义路径发现，其同目录的 npm/yarn/pnpm/bun 也会一并被发现；`python` 缺失时自动尝试 `python3`/`py` 别名。

**agent 行为协议（强制）**：

- **先检测再动手**：任何可能依赖工具的命令执行前，先看 `tools` 快照确认存在。
- **有权限才装**：需要缺失的必填工具（node/git）时，**向用户明确申请权限**（做什么 + 影响 + 一条安装命令）；用户同意才执行。
- **拒绝必须提示**：用户拒绝授权时，**必须**给用户一条清晰的「无法识别」提示，列出不可用的工具/命令 + 降级方案，然后走 fallback——**绝不默默换命令也不告知**。
  ```
  示例（rg 缺失被拒）：
  提示用户：本机未安装 ripgrep(rg)，无法执行快速全文搜索。
  将改用内置搜索 / findstr / Select-String 替代（稍慢但功能等价）。
  ```
- **不打扰**：可选工具（rg/python/pwsh 等）缺失且任务不依赖时，不申请权限，直接降级并在结果中注明。
- **用户主动授权的覆盖**（如"我用自定义 node 路径"）由 agent 记录：
  ```
  node scripts/setup.mjs --grant nodePath=C:\custom\node.exe
  node scripts/setup.mjs --grant '{ "npmRegistry": "https://registry.npmmirror.com" }'
  node scripts/setup.mjs --revoke     # 清除全部覆盖
  ```
  配置文件 `~/.config/check-environment/config.json`（gitignore），仅存用户明确授权的覆盖，非必需。

## 2. 每次会话：快速探测（可选）

需要环境快照 / 判断项目用哪个包管理器时：
- Windows PowerShell：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/probe.ps1`
- git-bash / POSIX：`bash scripts/probe.sh`

输出 JSON，含：工具版本、lockfile（决定包管理器）、npm registry、shell 类型、编码状态。

## 3. 命令选择优先级（一次选对，别失败后重试）

1. **包管理器由 lockfile 决定**（probe 的 `project.lockfile`）：`pnpm-lock.yaml`→`pnpm`，`package-lock.json`→`npm`，`yarn.lock`→`yarn`，`bun.lock*`→`bun`。**不要**用 `npm` 去跑一个 pnpm 项目。
2. **优先项目本地 `node_modules/.bin`**：`pnpm exec vitest` / `pnpm run test`，避免 `npx` 联网拉新版本（除非 `npx --no-install` 且确认存在）。
3. 脚本运行器：`node script.mjs`；node 24+ 可直接 `node script.ts`（type stripping），TS 专属语法报错再 `pnpm dlx tsx`。
4. PowerShell 脚本（.ps1）在 Windows 上统一加 `-NoProfile -ExecutionPolicy Bypass -File`（执行策略 RemoteSigned 会拦）。
5. rg/fd 缺失时：文件搜索用内置工具/`Get-ChildItem`（Win）/`find`（POSIX），不要用会报错的 `rg`。

## 4. 编码守卫（Windows 专属，中文环境）

**根因（双层）**：
1. PowerShell 自身打印中文时 `[Console]::OutputEncoding` 默认 GB2312，GBK 字节被按 UTF-8 解码 → `\uFFFD`。
2. **外部程序（node/git/tsc/vite/gradle）** 写 UTF-8 到继承的 stdout，但控制台代码页是 CP936，捕获层按 GBK 解码 → 同样乱码。

所以**只设 `$OutputEncoding` 不够，必须同时 `chcp 65001` 翻转代码页**。

**硬性规则（所有 agent 一视同仁，不要假设有插件替你兜底）**：

1. **UTF-8 守卫必须是命令首条、之前无任何输出**：
   ```
   chcp 65001 >$null 2>&1; $OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Console]::InputEncoding=[System.Text.Encoding]::UTF8; <命令>
   ```
2. **命令内联中文字面量不可靠**（`echo "中文"`、`node -e "中文"`、`python -c "中文"` 都会在 PS→程序边界被破坏）。可靠写法：
   - node：用 `\uXXXX` 转义（如 `console.log('\u4E2D\u6587')`）
   - PowerShell：用 `[char]0x4E2D` 构造
   - 中文经环境变量传递（`$env:FOO='中文'; node -e "console.log(process.env.FOO)"`）
   - **git 提交信息中文**：写临时文件后用 `git commit -F file`，不要 `git commit -m "中文"`。
3. **python 输出**先设 `$env:PYTHONIOENCODING='utf-8'`。
4. 写中文文件用 node `writeFileSync(path, data, 'utf8')`，不用 PS `Set-Content`/`Out-File`（默认非 UTF-8 且可能加 BOM）。
5. **读文件禁用 PS `Get-Content`/`type`/`cat`**（经捕获层必乱码）。用内置 `Read` 工具或 `node -e "console.log(require('fs').readFileSync(p,'utf8'))"`；GBK 旧文件用 `TextDecoder('gbk')`。

> **关于可选的 `encoding-guard` 钩子（`hooks/install.mjs`）**
>
> 它会在命令执行前**幂等地**注入上面这条守卫，并在执行后把 U+FFFD 归类写进 issues log。opencode 端还会在新类别首次出现时把规则**回写标准文件**；Claude/Cursor/Codex 端只写问题日志，不自动回写标准（它们没有可定位的标准文件路径）。
>
> **但它可能没装、可能没生效、可能在非 bash 工具上不触发。** 因此：
> - **永远自己写守卫**（规则 1）。钩子检测到已存在守卫会直接跳过，不会重复注入。
> - **不要因为「可能装了钩子」就省略守卫**——这是本 skill 最容易踩的错误假设。
> - 钩子只是优化项，不是前提条件。

## 5. 文件读取防乱码（Windows 专属）

- **PS `Get-Content` 经工具捕获层必乱码**（即使 `-Encoding UTF8`、即使有守卫）→ 禁用。
- **PS `-Encoding UTF8` 写文件会加 BOM**，node JSON.parse / 其他工具可能拒收 → 写文件用 node `writeFileSync(path, data, 'utf8')`（无 BOM），不用 PS `Set-Content`/`Out-File`。
- 可靠读法：内置 `Read` 工具；或 `node -e "console.log(require('fs').readFileSync('<path>','utf8'))"`。
- GBK 旧文件：`node -e "console.log(new TextDecoder('gbk').decode(require('fs').readFileSync('<path>')))"`。
- git 输出天然 UTF-8，无需处理。
- **PS 向 node 传内联 JSON/含引号参数会被剥引号** → 用文件传参（`--grant-file`）而非内联。

## 5b. 文件操作陷阱（Windows/pwsh 实测）

### 1. 临时目录：`/tmp` 不存在
Windows 没有 `/tmp`。**绝对不要硬编码 `/tmp`**。
- pwsh 中用 `$env:TEMP`（通常 `C:\Users\<user>\AppData\Local\Temp`）。
- node 中用 `require('os').tmpdir()` 或 `import { tmpdir } from 'node:os'`。
- 拼接临时文件路径：`path.join(os.tmpdir(), 'xxx.json')`。

### 2. 换行符：CRLF vs LF
Windows 默认 CRLF（`\r\n`），Unix 默认 LF（`\n`）。**混合换行符是最常见的隐形 bug——CSS/JSON 等文件因 CRLF↔LF 翻转被 git 计为整文件变更。**

**写文件**：
- `writeFileSync(path, content, 'utf8')` — 写入 content 原样，不含 BOM。如需 CRLF，content 里用 `\r\n`；如需 LF，用 `\n`。
- `JSON.stringify()` 内部用 `\n` — 如果已有文件用 CRLF，JSON 输出会混用 LF，导致 `git diff` 每行都变。

**编辑已有文件时（强制流程）**：
1. 读取原始内容：`const raw = readFileSync(path, 'utf8')`
2. 检测换行符风格：`const isCRLF = raw.includes('\r\n')`
3. 规范化为 LF 处理：`const normalized = raw.replace(/\r\n/g, '\n')`
4. 处理 `normalized`（此时统一为 `\n`）
5. **写回时还原原始风格**：
   - 若 `isCRLF`：`output = normalized.replace(/\n/g, '\r\n')`
   - 若 LF：直接用 `normalized`
6. `writeFileSync(path, output, 'utf8')`

**绝对禁止**：无脑用 `\n` 替换原始 CRLF 文件——会导致整文件 git diff。也不要用 `replace(/\r\n/g, '\n')` 后直接写回（会把 CRLF 文件变成 LF）。

**生成新文件时**：明确选择 LF 或 CRLF，不要让平台默认值意外决定。`.git` 项目推荐 LF（git 会按 `.gitattributes` 转换）。

**读文件**：
- `readFileSync` 返回原始字节，可能含 `\r\n`。
- 比较/处理时先规范化：`content.replace(/\r\n/g, '\n')`。
- 检测 CRLF 用 `includes('\r\n')`，不要用 `includes('\n')`（`\n` 在 CRLF 文件中也存在）。

**Git 防线（`.gitattributes`）**：在项目根目录添加 `.gitattributes` 强制指定文件类型的换行符，防止 agent 意外翻转：
```
*.css  text eol=lf
*.json text eol=lf
*.ts   text eol=lf
*.tsx  text eol=lf
*.js   text eol=lf
*.md   text eol=lf
```
这样即使 agent 写入 LF，git checkout/commit 时也会自动规范化。但 `.gitattributes` 是兜底——**agent 编辑时仍须检测并保留原始换行符**，否则每次提交都会产生无意义 diff。

### 3. 编码：写文件不要用 PowerShell
- `Set-Content -Encoding UTF8` — ps 5.1 加 BOM；ps 7 也加 BOM（与 5.1 不同行为）。
- `Out-File -Encoding UTF8` — 5.1 加 BOM。
- **一律用** `writeFileSync(path, data, 'utf8')` — 无 BOM，UTF-8。
- 读取时若遇 BOM：`data.charCodeAt(0) === 0xFEFF ? data.slice(1) : data`。

### 4. 路径分隔符
- Windows 用 `\`，Unix 用 `/`。
- **一律用** `path.join()` 拼路径，不要硬编码分隔符。
- `__dirname` 在 ESM 不可用，用 `import.meta.dirname`（node 21+）或 `fileURLToPath(import.meta.url)`。

### 5. 文件读写与 bash 工具的关系
- **内置 Read 工具**直接读文件（无 PS 捕获层），安全。
- **内置 Write 工具**直接写文件，但可能受编辑器/插件影响——写完用 Read 验证。
- **bash 工具**内用 `node -e "..."` 读写文件时，走 PS 管道 → 可能被注入 CRLF。尽量用内置工具而非 bash 内联 node 代码。
- **编辑已有文件**优先用内置 Edit 工具（精确替换），不要用 bash 的 `cat >` 或 PS `Set-Content` 覆写。

## 6. 自我完善闭环（重要，本 skill 的生命力）

> 当环境/项目变化产生**规则未覆盖**的新乱码或新报错场景时，把修复沉淀回标准。

**触发条件**（任一）：
1. 输出含 `\uFFFD` / `?` 替换符乱码，且当前规则无法解释/修复。
2. 命令报错后换用另一方法才成功（说明标准里没记录该兼容性坑）。

**动作**：
1. 在 `~/.config/check-environment/issues.md` 追加条目（日期 + Command + Observed + Root cause + Fix + 标准是否已更新）。opencode 用户写到 `~/.config/opencode/check-environment-issues.md`。
2. 若可归纳为通用规则 → 更新本 SKILL.md 对应章节（第 8/9/10 节）。**日志记细节，标准记规则**，不重复冗长内容。
3. 同步常驻摘要（如果以 instructions 方式加载的 check-environment 摘要文件存在）→ 更新它。
4. 告知用户：发现了什么、更新了哪条规则。

> **自动化**：`encoding-guard` 钩子在 opencode 端已把上述「检测 `\uFFFD` → 归类 → 去重 → 写已分析条目 → 首次出现类别时回写标准」做成自动闭环，无需 agent 每轮手动执行；Claude/Cursor/Codex 端只自动做前半段（写问题日志）。agent 仍需补「报错后换方法成功」这类非乱码类经验。

**信号**：命令第二次尝试才成功 / 行为跨项目不一致 → 先跑 probe 对比 → 按流程沉淀。

## 7. 完成标准

环境已探测（或确认不需要）、命令按 lockfile/可用性一次选对、中文输出在守卫下、结果无 `\uFFFD`、代理工具已注明。

## 8. 循环/重复检测（encoding-guard 钩子自动）

> 仅在安装了 `hooks/install.mjs` 时生效。**没有钩子时，agent 自己必须遵守第 9/10 节。**

**检测规则**（任一触发即中断并报告用户）：

| 规则 | 阈值 | 说明 |
|------|------|------|
| 同命令重复 | ≥ 8 次 / 5min | 同一条命令重复执行（E2E 调试重跑合法场景在此阈值内） |
| 连续失败 | ≥ 3 次 | 输出含 ParserError / U+FFFD / 栈追踪 / `ERROR:`行首 连续出现 |
| 输出高度相似 | Jaccard ≥ 0.8，连续 ≥ 3 次 | 相邻三次输出词集相似度均超过 80%（排除 E2E 重跑等合法两连相似场景） |
| 方法切换无进展 | ≥ 3 种不同失败方法 / 5min | agent 在"A→失败→B→失败"自我否定循环中打转 |

**失败信号是严格匹配的**：测试报告里的 `PASS: FAIL (expected)`、`Some tests FAILED`、`[FAILED] 3 tests` **不会**被当成错误，避免误杀正常校验脚本输出。

**触发后行为**：
1. 钩子中断当前操作（opencode 抛错；CLI 适配器 exit 2 + stderr）
2. 向用户输出：`[encoding-guard] 检测到循环/重复模式：<原因>\n<详情>`
3. 等待用户确认是否继续

**阈值调整**：修改 `hooks/encoding-guard-core.mjs` 内的 `LOOP_CMD_REPEAT` / `LOOP_FAIL_STREAK` / `LOOP_SIMILARITY_THRESHOLD` / `LOOP_WINDOW_MS`，然后重跑 `hooks/install.mjs`。

## 9. 先验证再执行（铁律）

issues log 和 auto-rules 记录的是**过去某时刻**的观察结果。工具可能已被用户安装，环境可能已改变。**永远不要机械地跳过某条命令**。

**执行流程**：
1. **执行前检查依赖**：命令使用的工具是否存在（`Get-Command <tool> -All` 或 `which`）
2. **工具不在 PATH**：用绝对路径或用备选方案，而不是直接跳过
3. **log 记录"不可用"**：重新探测，确认是否真的仍然不可用再决定绕路
4. **不要因历史 log 就跳过**：环境是动态的，每次执行前都是新状态

## 10. 执行前推理（pre-flight reasoning）

agent 执行方法时**不能靠试错来判断可行性**——必须先推理再动手。

**决策流程**：
1. **识别工具/命令链**：方法 A 依赖工具 B、C；先确认 B、C 存在再执行 A
2. **未经验证的方法**：先用 `--help` / `--version` / `which` 做最小验证，确认用法匹配再正式执行
3. **依赖检查**：`node -e "require('pkg')"` / `python -c "import mod"` / `npx --yes <pkg> --version` 等轻量探测，不要直接跑完整命令
4. **区分"未知"与"已知失败"**：log 里记的是"某方法在特定条件下失败"，不是"该方法永远不可用"。遇到未知情况先推理，不要盲试

**换方法必须说明理由**：
- agent 换方法时不能随机尝试，必须说明**为什么上一个方法不行**以及**为什么新方法更可能成功**
- 同一个问题连续失败 2 次后，**必须先诊断根因**（读错误信息、查文档、跑最小 repro），再选择下一个方法
- 禁止"A→失败→B→失败→A→失败→C→失败"式的循环尝试

**示例**：
- ❌ `git log --oneline -20 && echo done`（没有检查 git 是否可用）
- ✅ `Get-Command git -ErrorAction SilentlyContinue && git log --oneline -20`
- ❌ 试方法A失败，直接试方法B
- ✅ 方法A失败 → 分析错误原因 → 确认是工具缺失 → 装工具或用备选方案

## 11. Edit 工具防错铁律

`Edit` 工具的 `oldString` 必须来自**当前本次 Read 的实际内容**，禁止复用历史对话中缓存的文本。

**触发原因**：`Read` 和 `Edit` 之间无原子性保证——文件可能被其他进程修改、换行符差异（LF↔CRLF）、编码问题，导致肉眼看不出差异但字节已不同。

**硬性规则**：
1. **Edit 前必须重新 Read**：每次调用 `Edit` 之前，对目标文件执行一次 `Read`，用返回内容作为 `oldString` 的唯一来源
2. **禁止跨会话复用 oldString**：上次对话 Read 的内容可能在本次已变，不能直接使用
3. **Edit 失败时立即重试**：若 `oldString not found`，先 `Read` 目标文件，用最新内容重新生成 `oldString` 后重试一次，最多一次重试，再失败则报告用户
4. **用长上下文保唯一**：`oldString` 至少包含前后各 2 行，避免多处匹配

**错误处理流程**：
```
Edit 返回 "Could not find oldString"
  → Read 目标文件（获取最新内容）
  → 用新内容重新生成 oldString
  → 重试 Edit 一次
  → 仍失败 → 报告用户，附当前文件片段
```

## 12. 子代理派发 brief（主代理 dispatch 时复制到 prompt）

> 子代理（Task 工具的 explore/general 等）不继承主会话的 instructions/skill，以下规则必须显式传递。

```
环境约束（必读）：
- 包管理器：按 lockfile 决定（pnpm-lock.yaml→pnpm，package-lock.json→npm），不用 npx 拉新
- 读文件：用内置 Read 工具，禁用 Get-Content / type / cat（捕获层必乱码）
- 写文件：用内置 Write 工具或 node writeFileSync(path,data,'utf8')，不用 Set-Content（加 BOM）
- 临时目录：Windows 无 /tmp，用 os.tmpdir() 或 $env:TEMP
- 换行符：编辑已有文件时检测 CRLF（raw.includes('\r\n')），写回时还原原始风格
- Edit 前：先 Read 目标文件，用返回内容作 oldString 唯一来源
- 中文：命令内联中文不可靠，node 用 \uXXXX 转义，git commit 消息用 -F file
- 编码守卫：PowerShell 命令首条加 chcp 65001 + $OutputEncoding=UTF8（不要假设有钩子）
```
