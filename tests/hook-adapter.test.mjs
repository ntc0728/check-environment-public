import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(__dirname, "../skills/check-environment/hooks/encoding-guard.mjs");

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
assert.equal(r.code, 0, "claude pre must exit 0");
let parsed = JSON.parse(r.out);
assert.ok(parsed.hookSpecificOutput.updatedInput.command.startsWith("chcp 65001"));
assert.equal(parsed.hookSpecificOutput.permissionDecision, "allow");

r = run("cursor", pre);
assert.ok(JSON.parse(r.out).updated_input.command.startsWith("chcp 65001"));

r = run("codex", pre);
assert.ok(JSON.parse(r.out).updatedInput.command.startsWith("chcp 65001"));

// already-guarded command must pass through untouched (no rewrite output)
r = run("claude", {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "chcp 65001 >$null 2>&1; Get-ChildItem" },
});
assert.equal(r.out, "", "already-guarded command must NOT be rewritten");

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
assert.equal(r.out, "", "POSIX command must NOT be guarded");

// post event: clean output -> no loop error, exit 0
r = run("claude", {
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command: "echo hi" },
  tool_response: "hi",
});
assert.equal(r.code, 0, "clean post must exit 0");

console.log("hook-adapter: all assertions passed");
