// The agents this program knows how to set up and wake. Each module provides the same five things:
//   kind, label, usage   what it's called and how its setup is invoked
//   found()              its command on this machine, or null
//   setup({args, flags}) registers agents: returns { agents: [{kind, name, folder, …}], notes: [what it did] }
//   wake(agent, wake)    starts one run for new messages: { ok: true } | { ok: false, busy?: true, error }
//   check(agent)         what's wrong with an agent's setup, as sentences
//   open(agent, id)      optional: how to open the session a room's wakes run in, as lines
//   ask                  what the setup wizard asks for: "folder" or "profiles"
// A new agent is one more file here and one more line below. The desktop apps are setups only (`alias`): their
// agents are registered as the command-line kind that wakes them.

import claudeCode from "./claude-code.js";
import codex from "./codex.js";
import { claudeDesktop, codexDesktop } from "./desktop.js";
import hermes from "./hermes.js";

export const KINDS = Object.fromEntries([claudeCode, claudeDesktop, codex, codexDesktop, hermes].map((m) => [m.kind, m]));

export const moduleFor = (agent) => KINDS[agent.kind] ?? null;
