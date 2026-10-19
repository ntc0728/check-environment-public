import { spawnSync } from "node:child_process";
import path from "node:path";

const HOOK = path.resolve(
  "skills/check-environment/hooks/encoding-guard.mjs"
);

function run(format, payload, shell = "") {
  const r = spawnSync(process.execPath, [HOOK, `--format=${format}`], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, SHELL: shell },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const pre = {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "Get-ChildItem" },
};

let r = run("claude", pre);
console.log("claude pre code:", r.code);
const parsed = JSON.parse(r.out);
const cmd = parsed.hookSpecificOutput.updatedInput.command;
console.log("  injected guard:", cmd.startsWith("chcp 65001"));
console.log("  decision:", parsed.hookSpecificOutput.permissionDecision);

r = run("cursor", pre);
console.log("cursor pre:", JSON.parse(r.out).updated_input.command.startsWith("chcp 65001"));

r = run("codex", pre);
console.log("codex pre:", JSON.parse(r.out).updatedInput.command.startsWith("chcp 65001"));

// already-guarded command must pass through untouched
r = run("claude", {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "chcp 65001 >$null 2>&1; Get-ChildItem" },
});
console.log("idempotent (no rewrite):", r.out === "");

// posix command must pass through untouched
r = run(
  "claude",
  {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls -la" },
  },
  "/bin/bash"
);
console.log("posix untouched:", r.out === "");

// post event: clean output -> no loop error
r = run("claude", {
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command: "echo hi" },
  tool_response: "hi",
});
console.log("post clean code:", r.code);
