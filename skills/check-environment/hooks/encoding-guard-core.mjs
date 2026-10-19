// guard-core.mjs — shared logic for every encoding-guard adapter.
//
// Adapters:
//   encoding-guard.mjs   Claude Code / Cursor / Codex  (stdin/stdout JSON hooks)
//   opencode-plugin.js   opencode                      (tool.execute.before/after)
//
// Why a shared core: the two used to be independent copies that drifted apart
// (the published one had lost `chcp 65001` and had no loop detection). One
// core means a fix lands everywhere.
//
// Zero dependencies, plain Node ESM.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// UTF-8 GUARD
// ---------------------------------------------------------------------------
// Two layers are required on zh-CN Windows:
//   1. `chcp 65001` flips the console code page, so UTF-8 bytes written by
//      external programs (node/git/tsc/vite) are not decoded as GBK.
//   2. `$OutputEncoding` / `[Console]::OutputEncoding` fixes PowerShell's own
//      echo.
// Setting only #2 (as the old published build did) still garbles node/git
// output. The guard MUST be the first statement in the command.
export const GUARD =
  "chcp 65001 >$null 2>&1; " +
  "$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
  "[Console]::InputEncoding=[System.Text.Encoding]::UTF8; ";

export const AUTO_START = "<!-- AUTO-RULES-START -->";
export const AUTO_END = "<!-- AUTO-RULES-END -->";

// ---------------------------------------------------------------------------
// LOOP DETECTION THRESHOLDS
// ---------------------------------------------------------------------------
// 同一条命令在窗口内重复执行次数（E2E 调试重跑合法场景在此阈值内）
export const LOOP_CMD_REPEAT = 8;
// 时间窗口（毫秒）
export const LOOP_WINDOW_MS = 5 * 60 * 1000;
// 连续失败次数
export const LOOP_FAIL_STREAK = 3;
// 输出相似度阈值（Jaccard，0~1）
export const LOOP_SIMILARITY_THRESHOLD = 0.8;
// 方法切换无进展：窗口内不同命令连续失败次数
export const LOOP_METHOD_SWITCH_FAIL = 3;

// ---------------------------------------------------------------------------
// PATHS
// ---------------------------------------------------------------------------
// opencode keeps its own instruction file (`check-environment.md`) and a
// dedicated issues log. Other agents share `~/.config/check-environment/`.
export function resolvePaths(agent = "auto") {
  const home = os.homedir();
  const opencodeDir = path.join(home, ".config", "opencode");
  const sharedDir = path.join(home, ".config", "check-environment");
  const hasOpencode = fs.existsSync(opencodeDir);
  const useOpencode = agent === "opencode" || (agent === "auto" && hasOpencode);
  const dir = useOpencode ? opencodeDir : sharedDir;
  return {
    agent: useOpencode ? "opencode" : "shared",
    dir,
    issues: path.join(
      dir,
      useOpencode ? "check-environment-issues.md" : "issues.md"
    ),
    state: path.join(dir, "encoding-guard-state.json"),
    loopState: path.join(dir, "encoding-guard-loop.json"),
    // Auto-absorb only works where we know the standard's location.
    standard: useOpencode ? path.join(opencodeDir, "check-environment.md") : null,
  };
}

// ---------------------------------------------------------------------------
// GARBLING CLASSIFICATION (feeds the issues log + auto-absorb)
// ---------------------------------------------------------------------------
export const CATEGORIES = {
  bash_chain: {
    label: "bash 风格 && / ||（PS 5.1 不支持）",
    rootCause:
      "命令含 `&&` / `||`，但 shell 是 Windows PowerShell 5.1（不支持管道链运算符），直接抛 ParserError，错误文本里的中文又被乱码。",
    fix: "把 shell 设为 PowerShell 7（pwsh，原生支持 && / || 且默认 UTF-8）；若必须留在 5.1，改用 `cmd1; if ($?) { cmd2 }`。",
    rule:
      "**bash 链运算符**：shell 必须是 PowerShell 7（pwsh）。PowerShell 5.1 不支持 `&&`/`||`，会 ParserError 且中文乱码；不要用 `cd X && git ...` 这类写法依赖 5.1。",
  },
  read_via_ps: {
    label: "用 PS Get-Content / type / cat 读文件",
    rootCause:
      "PS `Get-Content`（含 `-Encoding UTF8`）经 agent 捕获层仍被按 GBK 解码，全乱码。",
    fix: "用内置 Read 工具，或 `node -e \"console.log(require('fs').readFileSync(p,'utf8'))\"`；GBK 旧文件用 `TextDecoder('gbk')`。",
    rule:
      "**读文件**：禁用 `Get-Content`/`type`/`cat`（捕获层必乱码）。用内置 Read 工具或 node `readFileSync(path,'utf8')`；GBK 旧文件用 `TextDecoder('gbk')`。",
  },
  inline_nonascii: {
    label: "命令内联非 ASCII（中文）字面量",
    rootCause:
      "命令字符串里的原始中文（如 `node -e \"...中文...\"`、`git commit -m \"中文\"`）在 shell→子程序边界被破坏。",
    fix: "node 用 `\\uXXXX` 转义；或经环境变量传递；git commit 消息写入临时文件用 `-F file`。",
    rule:
      "**命令内联中文不可靠**：node 用 `\\uXXXX` 转义，或经 `$env:MSG=...` 传参；git 提交信息写临时文件后用 `git commit -F file`，不要 `-m \"中文\"`。",
  },
  ps_echo_cn: {
    label: "PS Write-Output / Write-Host / echo 输出中文",
    rootCause: "PowerShell 自身打印中文用 GB2312，被按 UTF-8 解码成 U+FFFD。",
    fix: "命令首条自行前置 `chcp 65001` + `$OutputEncoding=UTF8`；仍乱码时改用 node 输出或环境变量传中文。",
    rule:
      "**PS 自身打印中文**：命令首条自行前置 `chcp 65001` + `$OutputEncoding=UTF8` 守卫；若仍乱码，改用 node 输出中文或经环境变量传参，避免 `Write-Host \"中文\"`。",
  },
  external_or_capture: {
    label: "外部程序输出（node/git/build）经控制台代码页乱码",
    rootCause:
      "外部程序写 UTF-8 到继承的 stdout，但控制台代码页为 CP936，捕获层按 GBK 解码 -> U+FFFD。",
    fix: "命令首条自行加 `chcp 65001` 翻转代码页为 UTF-8；确认 shell 是 PowerShell 7。",
    rule:
      "**外部程序输出**：守卫（命令首条自行前置）含 `chcp 65001` 翻转控制台代码页为 UTF-8，配套 `$OutputEncoding=UTF8`。若仍有 U+FFFD，确认 shell 是 PowerShell 7 且未用 `Get-Content` 读文件。",
  },
};

export function classify(command) {
  const cmd = String(command || "");
  if (/\b(Get-Content|type)\b/i.test(cmd)) return "read_via_ps";
  if (/cat\b/.test(cmd) && !/git\s+cat-file/i.test(cmd)) return "read_via_ps";
  if (/[^\x00-\x7F]/.test(cmd)) return "inline_nonascii";
  if (/(?:^|[\s;(])&&(?:\s|$)|(?:^|[\s;(])\|\|(?:\s|$)/.test(cmd))
    return "bash_chain";
  if (/\b(Write-Output|Write-Host|echo)\b/i.test(cmd)) return "ps_echo_cn";
  return "external_or_capture";
}

// ---------------------------------------------------------------------------
// GUARD INJECTION
// ---------------------------------------------------------------------------
export function isPosixShell(shell) {
  const s = String(shell || "").toLowerCase();
  return /(bash|zsh|sh)$/.test(s) || /git.*bash/.test(s);
}

// The guard is PowerShell syntax. Skip when:
//   - the command already carries it (idempotent),
//   - it is a `-File` script invocation (guard would land inside the script's
//     argv, not the interpreter),
//   - the active shell is POSIX.
export function shouldInjectGuard(cmd, shell) {
  if (typeof cmd !== "string" || !cmd) return false;
  if (isPosixShell(shell)) return false;
  if (cmd.trimStart().startsWith("$OutputEncoding")) return false;
  if (cmd.trimStart().startsWith("chcp 65001")) return false;
  if (/\$OutputEncoding\s*=.{0,80}/.test(cmd)) return false;
  if (/(powershell|pwsh)\b.*\s-File\b/.test(cmd)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------
function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function saveJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch {
    /* never break the agent over bookkeeping */
  }
}

export function ensureAutoRulesSection(standard) {
  if (!standard) return;
  let md;
  try {
    md = fs.readFileSync(standard, "utf8");
  } catch {
    return;
  }
  if (md.includes(AUTO_START)) return;
  const block =
    "\n\n## 自动沉淀规则（由 encoding-guard 插件维护，勿手动编辑）\n" +
    AUTO_START +
    "\n" +
    AUTO_END +
    "\n";
  try {
    fs.writeFileSync(standard, md + block, "utf8");
  } catch {}
}

function appendRuleToStandard(standard, cat) {
  const c = CATEGORIES[cat];
  if (!c || !standard) return;
  let md;
  try {
    md = fs.readFileSync(standard, "utf8");
  } catch {
    return;
  }
  const marker = `<!-- RULE:${cat} -->`;
  if (md.includes(marker)) return;
  const line = `${marker}\n- ${c.rule}\n`;
  if (!md.includes(AUTO_START)) {
    ensureAutoRulesSection(standard);
    try {
      md = fs.readFileSync(standard, "utf8");
    } catch {
      return;
    }
  }
  const start = md.indexOf(AUTO_START);
  if (start === -1) return;
  const insertAt = start + AUTO_START.length;
  try {
    fs.writeFileSync(
      standard,
      md.slice(0, insertAt) + "\n" + line + md.slice(insertAt),
      "utf8"
    );
  } catch {}
}

function logAnalyzedEntry(paths, cat, command) {
  const c = CATEGORIES[cat];
  if (!c) return;
  const date = new Date().toISOString().slice(0, 10);
  const entry =
    `\n## ${date} — ${c.label}\n\n` +
    `- **示例命令**: \`${String(command).slice(0, 200).replace(/`/g, "'")}\`\n` +
    `- **Observed**: 输出含 U+FFFD 替换符\n` +
    `- **Root cause**: ${c.rootCause}\n` +
    `- **Fix**: ${c.fix}\n` +
    `- **Standard updated?**: ${cat}\n`;
  try {
    fs.mkdirSync(path.dirname(paths.issues), { recursive: true });
    fs.appendFileSync(paths.issues, entry, "utf8");
  } catch {}
}

// Called once per garbled output. Writes ONE analyzed entry per category and,
// the first time a category is seen, appends its rule to the standard.
export function recordGarbling(command, output, paths) {
  if (typeof output !== "string" || !output.includes("\uFFFD")) return null;
  const cat = classify(command);
  const state = loadJson(paths.state, { categories: {}, absorbed: [] });
  if (!state.categories) state.categories = {};
  if (!Array.isArray(state.absorbed)) state.absorbed = [];
  const rec = state.categories[cat] || {
    count: 0,
    firstSeen: null,
    lastLogged: null,
  };
  const isNew = rec.count === 0;
  rec.count += 1;
  if (!rec.firstSeen) rec.firstSeen = new Date().toISOString().slice(0, 10);
  state.categories[cat] = rec;

  if (isNew) {
    logAnalyzedEntry(paths, cat, command);
    if (!state.absorbed.includes(cat)) {
      appendRuleToStandard(paths.standard, cat);
      state.absorbed.push(cat);
    }
  }
  rec.lastLogged = new Date().toISOString().slice(0, 10);
  saveJson(paths.state, state);
  return cat;
}

// ---------------------------------------------------------------------------
// LOOP DETECTION
// ---------------------------------------------------------------------------
// CLI adapters are short-lived processes, so they persist the window to disk.
// The opencode plugin lives for the whole session and can stay in memory.
function hashWords(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
  );
}
function jaccard(a, b) {
  const x = hashWords(a);
  const y = hashWords(b);
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  const union = new Set([...x, ...y]).size;
  return union === 0 ? 0 : inter / union;
}

// Failure signals. Deliberately narrow: a validation script printing
// "PASS: FAIL (expected)" or "Some tests FAILED" must NOT count as an error.
const ERROR_PATTERNS = [
  /ParserError/i,
  /U\+FFFD/,
  /\uFFFD/,
  /at\s+(?:.*\.ps1|.*\.js|.*\.ts):\d+:/, // PS/Node stack trace
  // line-start FAIL/FAILED/ERROR/Exception, or FAILED right after a
  // non-space non-colon char. Mid-line "FAIL" descriptions are ignored.
  /^(?:FAIL(?:ED)?[=: \-]|ERROR[=: ]|(?<![\s:])FAILED\b|Exception\b|error[=: ])/m,
  /npm\s+ERR!/,
];

export function looksLikeError(text) {
  if (typeof text !== "string") return false;
  return ERROR_PATTERNS.some((p) => p.test(text));
}

export function createLoopDetector({ persistPath = null } = {}) {
  let callLog = [];
  let failStreak = [];
  if (persistPath) {
    const s = loadJson(persistPath, null);
    if (s && Array.isArray(s.callLog)) callLog = s.callLog;
    if (s && Array.isArray(s.failStreak)) failStreak = s.failStreak;
  }

  function prune() {
    const now = Date.now();
    callLog = callLog.filter((c) => now - c.ts <= LOOP_WINDOW_MS);
    failStreak = failStreak.filter((f) => now - f.ts <= LOOP_WINDOW_MS);
  }
  function save() {
    if (!persistPath) return;
    saveJson(persistPath, {
      callLog: callLog.slice(-60),
      failStreak: failStreak.slice(-20),
    });
  }

  // Pre-execution rules. Returns a human-readable reason or null.
  // `cmd` is the command about to run (not yet logged).
  function checkBefore(cmd) {
    prune();
    if (cmd) {
      const same = callLog.filter((c) => c.cmd === cmd).length;
      if (same + 1 >= LOOP_CMD_REPEAT) {
        return {
          reason: "重复执行同一条命令",
          detail: `"${String(cmd).slice(0, 120)}" 已执行 ${same + 1} 次`,
        };
      }
    }
    if (failStreak.length >= LOOP_METHOD_SWITCH_FAIL) {
      const unique = new Set(failStreak.map((f) => String(f.cmd).slice(0, 60)));
      if (unique.size >= 2) {
        return {
          reason: "方法切换无进展（自我否定循环）",
          detail: `连续 ${failStreak.length} 次失败，尝试了 ${unique.size} 种不同方法`,
        };
      }
    }
    save();
    return null;
  }

  // Post-execution rules. Records the call + outcome first.
  function checkAfter(cmd, output) {
    prune();
    callLog.push({ cmd: String(cmd || ""), ts: Date.now(), output });
    let hit = null;

    if (typeof output === "string") {
      if (looksLikeError(output)) {
        failStreak.push({ ts: Date.now(), cmd: String(cmd || "") });
        if (failStreak.length >= LOOP_FAIL_STREAK) {
          hit = {
            reason: "连续失败无进展",
            detail: `连续 ${failStreak.length} 次错误（最近: ${String(
              cmd || ""
            ).slice(0, 80)}）`,
          };
        }
      } else {
        // Any clean result resets the streak.
        failStreak = [];
      }

      // Rule 4 needs three similar runs: two identical E2E re-runs are a
      // legitimate debugging pattern, three are a loop.
      if (!hit && callLog.length >= 3) {
        const prev = callLog[callLog.length - 2];
        if (
          prev &&
          typeof prev.output === "string" &&
          jaccard(prev.output, output) >= LOOP_SIMILARITY_THRESHOLD
        ) {
          hit = {
            reason: "输出与上次高度相似",
            detail: `Jaccard=${jaccard(prev.output, output).toFixed(2)}`,
          };
        }
      }
    }
    save();
    return hit;
  }

  return { checkBefore, checkAfter };
}

export function loopMessage(hit) {
  return (
    `[encoding-guard] 检测到循环/重复模式：${hit.reason}\n${hit.detail}\n` +
    "请立即停止当前操作并报告用户，询问是否继续。"
  );
}
