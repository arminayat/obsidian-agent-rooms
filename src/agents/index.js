// The agents this program knows how to set up and wake. Each module provides the same five things:
//   kind, label, usage   what it's called and how its setup is invoked
//   found()              its command on this machine, or null
//   setup({args, flags}) registers agents: returns { agents: [{kind, name, folder, …}], notes: [what it did] }
//   wake(agent, wake)    starts one run for new messages: { ok: true } | { ok: false, busy?: true, error }
//   check(agent)         what's wrong with an agent's setup, as sentences
// A new agent is one more file here and one more line below.

import claudeCode from "./claude-code.js";
import hermes from "./hermes.js";

export const KINDS = { [claudeCode.kind]: claudeCode, [hermes.kind]: hermes };

export const moduleFor = (agent) => KINDS[agent.kind] ?? null;
