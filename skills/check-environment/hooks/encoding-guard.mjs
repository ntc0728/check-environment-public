#!/usr/bin/env node
// encoding-guard.mjs — stdin/stdout hook adapter for Claude Code / Cursor / Codex.
//
// One script, three agent families. `install.mjs` passes --format so the
// script emits each platform's expected decision JSON on stdout:
//
//   --format=claude   -> { hookSpecificOutput: { permissionDecision, updatedInput } }
//   --format=cursor   -> { permission: "allow", updated_input: { command } }
//   --format=codex    -> { permissionDecision: "allow", updatedInput: { command } }
//
// PRE  (PreToolUse / preToolUse / beforeShellExecution)
//      Read stdin JSON. If the command does not already carry the UTF-8 guard,
//      prepend it via the platform's input-rewrite field and ALLOW.
//      Fail-open: we never break a working command.
// POST (PostToolUse / postToolUse / afterShellExecution)
//      Scan tool output for U+FFFD and record it in the issues log
//      (one analyzed entry per category, deduped via state).
//
// Loop detection: the CLI adapters are short-lived processes, so the sliding
// window is persisted to disk. A detected loop is reported on stderr and the
// process exits 2 — agents that treat a non-zero hook exit as "stop" will
// halt; the message is always human-readable.
//
// Zero dependencies, plain Node ESM.

import fs from "node:fs";
import path from "node:path";
import {
  GUARD,
  resolvePaths,
  shouldInjectGuard,
  recordGarbling,
  createLoopDetector,
  ensureAutoRulesSection,
} from "./encoding-guard-core.mjs";

// --- input normalization ----------------------------------------------------

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parseInput(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Extract { command, output, event, tool } from any agent payload shape.
function extract(input) {
  const out = { command: null, output: null, event: "", tool: "" };
  if (!input || typeof input !== "object") return out;
  out.event = String(
    input.hook_event_name || input.hookEventName || input.event || ""
  );
  out.tool = String(input.tool_name || input.tool || "");

  const ti = input.tool_input || input.input || {};
  if (ti && typeof ti === "object" && typeof ti.command === "string") {
    out.command = ti.command;
  } else if (typeof input.command === "string") {
    out.command = input.command;
  }

  const o =
    input.tool_response ?? input.tool_output ?? input.output ?? input.result;
  if (typeof o === "string") out.output = o;
  else if (o && typeof o === "object") out.output = JSON.stringify(o);

  return out;
}

function isPreEvent(event) {
  return /^pre/i.test(event) || /^before/i.test(event);
}

// --- output builders --------------------------------------------------------

function preDecision(format, newCommand) {
  switch (format) {
    case "claude":
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { command: newCommand },
        },
      };
    case "cursor":
      return { permission: "allow", updated_input: { command: newCommand } };
    case "codex":
      // Recent Codex builds honor updatedInput rewrites; older ones ignore the
      // rewrite but still run the command — harmless.
      return {
        permissionDecision: "allow",
        updatedInput: { command: newCommand },
      };
    default:
      return null;
  }
}

// --- main -------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const fmtArg = argv.find((a) => a.startsWith("--format="));
  const format = fmtArg ? fmtArg.split("=")[1] : "claude";

  const raw = readStdin();
  if (!raw) process.exit(0);

  const input = parseInput(raw);
  if (!input) process.exit(0);

  const { command, output, event } = extract(input);
  const paths = resolvePaths("shared");
  const loop = createLoopDetector({ persistPath: paths.loopState });

  if (isPreEvent(event)) {
    if (command) {
      const hit = loop.checkBefore(command);
      if (hit) {
        // No standard "stop" decision exists across all three platforms, so
        // surface the message on stderr and exit non-zero.
        process.stderr.write(
          `[encoding-guard] 检测到循环/重复模式：${hit.reason}\n${hit.detail}\n` +
            "请立即停止当前操作并报告用户，询问是否继续。\n"
        );
        process.exit(2);
      }
    }
    if (command && shouldInjectGuard(command, process.env.SHELL)) {
      const decision = preDecision(format, GUARD + command);
      if (decision) process.stdout.write(JSON.stringify(decision));
    }
    process.exit(0);
  }

  // Post event.
  const hit = loop.checkAfter(command || "", output || null);
  if (hit) {
    process.stderr.write(
      `[encoding-guard] 检测到循环/重复模式：${hit.reason}\n${hit.detail}\n` +
        "请立即停止当前操作并报告用户，询问是否继续。\n"
    );
    process.exit(2);
  }
  if (output) {
    ensureAutoRulesSection(paths.standard);
    recordGarbling(command || "<unknown command>", output, paths);
  }
  process.exit(0);
}

main();
