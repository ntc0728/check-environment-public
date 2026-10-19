import assert from "node:assert/strict";
import {
  GUARD,
  shouldInjectGuard,
  looksLikeError,
  createLoopDetector,
  classify,
  resolvePaths,
} from "../skills/check-environment/hooks/encoding-guard-core.mjs";

// --- guard injection ---
assert.equal(shouldInjectGuard("Get-ChildItem", "C:\\pwsh\\pwsh.exe"), true);
assert.equal(shouldInjectGuard("node script.js", "/bin/bash"), false);
assert.equal(shouldInjectGuard("$OutputEncoding=[Text.Encoding]::UTF8; ls", "pwsh"), false);
assert.equal(shouldInjectGuard("pwsh -File build.ps1", "pwsh"), false);
assert.equal(shouldInjectGuard("", "pwsh"), false);
assert.ok(GUARD.includes("chcp 65001"), "guard must flip the code page");
assert.ok(GUARD.includes("$OutputEncoding"), "guard must set OutputEncoding");

// --- error detection (must not fire on test-report text) ---
const mustBeErrors = [
  "ParserError: Unexpected token",
  "output had \uFFFD in it",
  "    at Object.<anonymous> (C:\\x\\a.js:12:3)",
  "FAIL: expected 2 got 3",
  "FAILED assertion at line 5",
  "ERROR: disk full",
  "error: connection refused",
  "Exception in thread main",
  "npm ERR! code ELIFECYCLE",
];
const mustNotBeErrors = [
  "PASS: FAIL (expected)",
  "Some tests FAILED",
  "[FAILED] 3 tests",
  "test result: FAILED (1/3)",
  "all good",
];
for (const t of mustBeErrors) {
  assert.equal(looksLikeError(t), true, `should be error: ${t}`);
}
for (const t of mustNotBeErrors) {
  assert.equal(looksLikeError(t), false, `should NOT be error: ${t}`);
}

// --- loop: same command repeated ---
{
  const d = createLoopDetector();
  let hit = null;
  for (let i = 1; i <= 8; i++) {
    hit = d.checkBefore("npm run build");
    if (hit) break;
    d.checkAfter("npm run build", "ok");
  }
  assert.ok(hit, "8 identical commands must trip the repeat rule");
  assert.match(hit.reason, /重复执行/);
}

// --- loop: E2E re-run twice must NOT trip similarity ---
{
  const d = createLoopDetector();
  const out = "Running 24 tests...\n24 passed\n";
  d.checkAfter("npm run test:e2e", out);
  const hit = d.checkAfter("npm run test:e2e", out);
  assert.equal(hit, null, "two identical E2E runs are a legit debug pattern");
}

// --- loop: consecutive failures ---
{
  const d = createLoopDetector();
  let hit = null;
  for (let i = 0; i < 3; i++) {
    hit = d.checkAfter(`cmd-${i}`, "ERROR: boom");
    if (hit) break;
  }
  assert.ok(hit, "3 consecutive failures must trip");
  assert.match(hit.reason, /连续失败/);
}

// --- success resets the streak ---
{
  const d = createLoopDetector();
  d.checkAfter("a", "ERROR: one");
  d.checkAfter("b", "ERROR: two");
  d.checkAfter("c", "all good"); // reset
  const hit = d.checkAfter("d", "ERROR: three");
  assert.equal(hit, null, "a clean run must reset the fail streak");
}

// --- classification ---
assert.equal(classify("Get-Content x.txt"), "read_via_ps");
assert.equal(classify("git cat-file -p HEAD"), "external_or_capture");
assert.equal(classify("cmd1 && cmd2"), "bash_chain");

// --- paths resolve to an existing agent home ---
const p = resolvePaths("opencode");
assert.ok(p.issues.endsWith("check-environment-issues.md"));
assert.ok(p.standard && p.standard.endsWith("check-environment.md"));

console.log("guard-core: all assertions passed");
