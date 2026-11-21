// The desktop apps. Neither Claude Desktop nor Codex Desktop takes a prompt from outside (their links only fill
// in the box), so neither is a member of rooms of its own: setting one up sets up its command-line agent in the
// same folder, whose wakes run headless, and `rooms session` says how to open that conversation in the app.

import { existsSync } from "node:fs";
import claudeCode from "./claude-code.js";
import codex from "./codex.js";

/** The Codex the ChatGPT app ships and runs itself: the version that reads and writes the app's threads. */
const APP_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";

function surface({ kind, label, app, base, note, defaults = () => ({}) }) {
  return {
    kind,
    label: `${base.label} (for ${label})`,
    ask: base.ask,
    alias: true,
    usage: base.usage.replace(`setup ${base.kind}`, `setup ${kind}`),
    found: () => base.found() ?? (existsSync(app) ? app : null),
    async setup(input) {
      const result = await base.setup.call(base, { ...input, flags: { ...defaults(), ...input.flags } });
      result.notes.push(note);
      return result;
    },
  };
}

export const claudeDesktop = surface({
  kind: "claude-desktop", label: "Claude Desktop", app: "/Applications/Claude.app", base: claudeCode,
  note: "Claude Desktop can't be woken from outside, so wakes run as Claude Code in that folder (the `claude` command has to be installed). The app's Code tab uses the same skills.",
});

export const codexDesktop = surface({
  kind: "codex-desktop", label: "Codex Desktop", app: "/Applications/ChatGPT.app", base: codex,
  defaults: () => (existsSync(APP_CODEX) && !process.env.AGENT_ROOMS_CODEX ? { command: APP_CODEX } : {}),
  note: "The Codex app can't be woken from outside, so wakes run as the Codex CLI in that folder, using the Codex the app ships when it's installed here. `rooms session \"<room>\"` gives the link that opens a room's thread in the app; while the app has it open, wakes wait.",
});
