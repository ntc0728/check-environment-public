// encoding-guard.js — opencode adapter for the shared guard core.
//
// Installed by `hooks/install.mjs` into ~/.config/opencode/plugins/ together
// with its sibling `encoding-guard-core.mjs`. Do not edit the installed copy:
// edit `skills/check-environment/hooks/opencode-plugin.js` and re-install.
//
// opencode exposes hooks as a function returning an object with
// "tool.execute.before" / "tool.execute.after". Both receive the live tool
// arguments, so we can rewrite `output.args.command` in place.
//
// Behaviour is identical to the CLI adapters (Claude/Cursor/Codex):
//   before -> prepend the UTF-8 guard (idempotent, PowerShell-only)
//             + stop the run if a repetition loop is detected
//   after  -> classify U+FFFD garbling into the issues log / standard
//             + stop the run if failures repeat with no progress
//
// Zero dependencies, plain Node ESM.

import {
  GUARD,
  resolvePaths,
  shouldInjectGuard,
  recordGarbling,
  createLoopDetector,
  loopMessage,
  ensureAutoRulesSection,
} from "./encoding-guard-core.mjs";

export const EncodingGuardPlugin = async () => {
  const paths = resolvePaths("opencode");
  // The plugin lives for the whole session, so the loop window stays in memory.
  const loop = createLoopDetector();
  ensureAutoRulesSection(paths.standard);

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return;
      const args = output && output.args;
      if (!args || typeof args.command !== "string") return;

      const cmd = args.command;

      // Loop check runs before any rewrite so the log records what the agent
      // actually asked for.
      const hit = loop.checkBefore(cmd);
      if (hit) throw new Error(loopMessage(hit));

      if (!shouldInjectGuard(cmd, process.env.SHELL)) return;
      args.command = GUARD + cmd;
      if (args.metadata) args.metadata.encodingGuard = "utf8+chcp65001";
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "bash") return;
      const cmd = String((input.args && input.args.command) || "");
      const text =
        output && typeof output.output === "string" ? output.output : null;

      const hit = loop.checkAfter(cmd, text);
      if (hit) throw new Error(loopMessage(hit));

      if (text) recordGarbling(cmd, text, paths);
    },
  };
};

export default EncodingGuardPlugin;
