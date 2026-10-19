#!/usr/bin/env node
// install.mjs — register the encoding-guard hooks for every agent present.
//
// Cross-platform (Windows / macOS / Linux). Detects installed agents by their
// config locations, then idempotently adds the guard hook. Existing hook
// configs are MERGED, never overwritten.
//
// Usage:
//   node install.mjs                  install everywhere it can
//   node install.mjs --list           show detected agents + current status
//   node install.mjs --only claude    install for one agent only
//   node install.mjs --only cursor
//   node install.mjs --only codex
//   node install.mjs --only opencode
//   node install.mjs --dry-run        print what WOULD change, change nothing
//   node install.mjs --uninstall      remove the guard hooks we added
//
// Agents & config files:
//   Claude Code : ~/.claude/settings.json   (PreToolUse/PostToolUse, matcher Bash)
//   Cursor      : ~/.cursor/hooks.json      (preToolUse/postToolUse, matcher Shell)
//   Codex CLI   : ~/.codex/hooks.json + [features] codex_hooks = true
//   opencode    : ~/.config/opencode/plugins/encoding-guard.js (+ -core.mjs)
//
// The hooks themselves live next to this installer, so the skill directory is
// fully self-contained: copy `skills/check-environment/` anywhere and run
// `node hooks/install.mjs`.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.join(__dirname, "encoding-guard.mjs");
const GUARD_CORE = path.join(__dirname, "encoding-guard-core.mjs");
const OPENCODE_PLUGIN = path.join(__dirname, "opencode-plugin.js");

// os.homedir() on win32 uses USERPROFILE. Honor HOME too so the installer is
// testable (fake HOME) and consistent on cross-platform CI.
const home = process.env.HOME || os.homedir();

const AGENTS = {
  claude: {
    name: "Claude Code",
    cfgFile: path.join(home, ".claude", "settings.json"),
    detect: () => fs.existsSync(path.join(home, ".claude")),
  },
  cursor: {
    name: "Cursor",
    cfgFile: path.join(home, ".cursor", "hooks.json"),
    detect: () => fs.existsSync(path.join(home, ".cursor")),
  },
  codex: {
    name: "Codex CLI",
    cfgFile: path.join(home, ".codex", "hooks.json"),
    toml: path.join(home, ".codex", "config.toml"),
    detect: () => fs.existsSync(path.join(home, ".codex")),
  },
  opencode: {
    name: "opencode",
    pluginDir: path.join(home, ".config", "opencode", "plugins"),
    detect: () => fs.existsSync(path.join(home, ".config", "opencode")),
  },
};

// Substring used to recognize entries we own (for idempotency + uninstall).
const MARKER = "encoding-guard";

function quotePath(p) {
  // Forward slashes survive both cmd.exe and POSIX shells; JSON.stringify
  // handles spaces and escaping for the settings file.
  return JSON.stringify(p.replace(/\\/g, "/"));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function isOurs(entry) {
  if (!entry) return false;
  if (typeof entry.command === "string" && entry.command.includes(MARKER)) {
    return true;
  }
  if (Array.isArray(entry.hooks)) {
    return entry.hooks.some(
      (h) => h && typeof h.command === "string" && h.command.includes(MARKER)
    );
  }
  return false;
}

function hookCommand(format) {
  return `node ${quotePath(CORE)} --format=${format}`;
}

// An entry of ours may point at an OLD location (e.g. after the skill moved
// from `hooks/` to `skills/check-environment/hooks/`). Recognize and rewrite it
// instead of treating it as already up to date.
function isCurrent(entry, format) {
  if (!entry) return false;
  const want = hookCommand(format);
  const cmds = [];
  if (typeof entry.command === "string") cmds.push(entry.command);
  if (Array.isArray(entry.hooks)) {
    for (const h of entry.hooks) {
      if (h && typeof h.command === "string") cmds.push(h.command);
    }
  }
  return cmds.includes(want);
}

function rewriteOurs(entry, format) {
  if (typeof entry.command === "string" && entry.command.includes(MARKER)) {
    entry.command = hookCommand(format);
  }
  if (Array.isArray(entry.hooks)) {
    for (const h of entry.hooks) {
      if (h && typeof h.command === "string" && h.command.includes(MARKER)) {
        h.command = hookCommand(format);
      }
    }
  }
}

// --- Claude Code ------------------------------------------------------------

function installClaude(cfg, { dryRun, uninstall }) {
  const changed = [];
  if (!cfg.hooks) cfg.hooks = {};

  const apply = (event, matcher) => {
    const groups = (cfg.hooks[event] = cfg.hooks[event] || []);
    const group = groups.find((g) => g.matcher === matcher);

    if (uninstall) {
      if (!group) return;
      const before = group.hooks ? group.hooks.length : 0;
      group.hooks = (group.hooks || []).filter(
        (h) => !(h.command || "").includes(MARKER)
      );
      if (before !== group.hooks.length) changed.push(`remove:${event}:${matcher}`);
      return;
    }

    if (group && isOurs(group)) {
      if (isCurrent(group, "claude")) return;
      if (!dryRun) rewriteOurs(group, "claude");
      changed.push(`update:${event}:${matcher}`);
      return;
    }
    if (dryRun) {
      changed.push(`add:${event}:${matcher}`);
      return;
    }
    if (group) {
      group.hooks = group.hooks || [];
      group.hooks.push({ type: "command", command: hookCommand("claude") });
    } else {
      groups.push({
        matcher,
        hooks: [{ type: "command", command: hookCommand("claude") }],
      });
    }
    changed.push(`add:${event}:${matcher}`);
  };

  apply("PreToolUse", "Bash");
  apply("PostToolUse", "Bash");
  return changed;
}

// --- Cursor -----------------------------------------------------------------

function installCursor(cfg, { dryRun, uninstall }) {
  const changed = [];
  if (!cfg.hooks) cfg.hooks = {};

  const apply = (event, matcher) => {
    const list = (cfg.hooks[event] = cfg.hooks[event] || []);
    // Find OUR entry specifically (not just any entry at this matcher), so a
    // pre-existing user hook at the same matcher does not make us re-append
    // on every run.
    const ourIdx = list.findIndex(
      (h) => h && h.matcher === matcher && isOurs(h)
    );
    const anyIdx = list.findIndex((h) => h && h.matcher === matcher);

    if (uninstall) {
      if (ourIdx >= 0) {
        list.splice(ourIdx, 1);
        changed.push(`remove:${event}:${matcher}`);
      }
      return;
    }
    if (ourIdx >= 0) {
      if (isCurrent(list[ourIdx], "cursor")) return;
      if (!dryRun) list[ourIdx].command = hookCommand("cursor");
      changed.push(`update:${event}:${matcher}`);
      return;
    }
    if (dryRun) {
      changed.push(`add:${event}:${matcher}`);
      return;
    }
    // No our-entry yet. If a non-ours entry already occupies this matcher,
    // APPEND a new entry rather than silently overwriting the user's hook.
    list.push({ command: hookCommand("cursor"), matcher });
    changed.push(`add:${event}:${matcher}`);
    void anyIdx;
  };

  apply("preToolUse", "Shell");
  apply("postToolUse", "Shell");
  return changed;
}

// --- Codex CLI --------------------------------------------------------------

function installCodex(cfg, tomlPath, { dryRun, uninstall }) {
  const changed = [];
  if (!cfg.hooks) cfg.hooks = {};

  const apply = (event, matcher) => {
    const groups = (cfg.hooks[event] = cfg.hooks[event] || []);
    const group = groups.find((g) => g.matcher === matcher);

    if (uninstall) {
      if (!group) return;
      const before = (group.hooks || []).length;
      group.hooks = (group.hooks || []).filter(
        (h) => !(h.command || "").includes(MARKER)
      );
      if (before !== group.hooks.length) changed.push(`remove:${event}:${matcher}`);
      return;
    }
    if (group && isOurs(group)) {
      if (isCurrent(group, "codex")) return;
      if (!dryRun) rewriteOurs(group, "codex");
      changed.push(`update:${event}:${matcher}`);
      return;
    }
    if (dryRun) {
      changed.push(`add:${event}:${matcher}`);
      return;
    }
    if (group) {
      group.hooks = group.hooks || [];
      group.hooks.push({ type: "command", command: hookCommand("codex") });
    } else {
      groups.push({
        matcher,
        hooks: [{ type: "command", command: hookCommand("codex") }],
      });
    }
    changed.push(`add:${event}:${matcher}`);
  };

  apply("PreToolUse", "Bash");
  apply("PostToolUse", "Bash");

  // Codex gates hooks behind a feature flag (off by default).
  if (!uninstall && fs.existsSync(tomlPath)) {
    let toml = fs.readFileSync(tomlPath, "utf8");
    if (!/[^\S\r\n]*codex_hooks\s*=\s*true/.test(toml)) {
      if (!dryRun) {
        if (toml.includes("[features]")) {
          toml = toml.replace("[features]", "[features]\ncodex_hooks = true");
        } else {
          toml = (toml.trim() ? toml + "\n\n" : "") + "[features]\ncodex_hooks = true\n";
        }
        fs.writeFileSync(tomlPath, toml, "utf8");
      }
      changed.push("feature:codex_hooks=true");
    }
  }
  return changed;
}

// --- opencode ---------------------------------------------------------------

function installOpencode({ dryRun, uninstall }) {
  const dir = AGENTS.opencode.pluginDir;
  const destPlugin = path.join(dir, "encoding-guard.js");
  const destCore = path.join(dir, "encoding-guard-core.mjs");
  const changed = [];

  if (uninstall) {
    for (const f of [destPlugin, destCore]) {
      if (fs.existsSync(f)) {
        if (!dryRun) fs.rmSync(f, { force: true });
        changed.push(`remove:${path.basename(f)}`);
      }
    }
    return changed;
  }

  // The installed plugin is a build artifact: always refresh it from source so
  // a re-run of the installer is how you upgrade.
  const pairs = [
    [OPENCODE_PLUGIN, destPlugin],
    [GUARD_CORE, destCore],
  ];
  for (const [src, dst] of pairs) {
    let same = false;
    try {
      same = fs.readFileSync(src, "utf8") === fs.readFileSync(dst, "utf8");
    } catch {
      same = false;
    }
    if (same) continue;
    if (!dryRun) {
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(src, dst);
    }
    changed.push(`copy:${path.basename(dst)}`);
  }
  return changed;
}

// --- main -------------------------------------------------------------------

function status(name) {
  const a = AGENTS[name];
  if (!a.detect()) return "not installed";
  if (name === "opencode") {
    const p = path.join(a.pluginDir, "encoding-guard.js");
    return fs.existsSync(p) ? "installed (plugin present)" : "installed, guard NOT present";
  }
  const cfg = readJson(a.cfgFile);
  const registered = cfg && cfg.hooks && JSON.stringify(cfg.hooks).includes(MARKER);
  return registered ? "installed, guard registered" : "installed, guard NOT registered";
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const uninstall = args.includes("--uninstall");
  const list = args.includes("--list");
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

  const names = only ? [only] : Object.keys(AGENTS);

  if (only && !AGENTS[only]) {
    console.error(`unknown agent "${only}" (expected: ${Object.keys(AGENTS).join(", ")})`);
    process.exit(1);
  }

  if (list) {
    for (const name of names) {
      console.log(`${name.padEnd(9)} ${status(name)}`);
    }
    return;
  }

  const summary = [];
  for (const name of names) {
    const a = AGENTS[name];
    if (!a.detect()) {
      summary.push(`${a.name}: not installed, skipped`);
      continue;
    }
    let changed = [];
    const opts = { dryRun, uninstall };
    if (name === "opencode") {
      changed = installOpencode(opts);
    } else {
      // If the config file exists but is unparseable, DO NOT clobber it with
      // a fresh {} — that would silently wipe the user's other hooks.
      const exists = fs.existsSync(a.cfgFile);
      const cfg = readJson(a.cfgFile);
      if (exists && !cfg) {
        summary.push(
          `${a.name}: config exists but could not be parsed — SKIPPED (fix manually or delete the file)`
        );
        continue;
      }
      changed =
        name === "cursor"
          ? installCursor(cfg || {}, opts)
          : name === "codex"
            ? installCodex(cfg || {}, a.toml, opts)
            : installClaude(cfg || {}, opts);
      if (!dryRun && changed.length && cfg) writeJson(a.cfgFile, cfg);
    }
    const verb = uninstall ? "removed" : "changed";
    summary.push(
      `${a.name}: ${changed.length ? `${verb} ${changed.join(", ")}` : "no change"}` +
        (dryRun ? " [dry-run]" : "")
    );
  }
  console.log(summary.join("\n"));
}

main();
