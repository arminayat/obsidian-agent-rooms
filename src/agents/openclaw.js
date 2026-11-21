// OpenClaw: an agent is one OpenClaw agent id on this machine (`main` unless it has several). A wake is one turn
// through the local Gateway with its own CLI, in a session the room keeps:
//   openclaw agent --agent <id> --session-key rooms-<room> --message-file <file> --json --timeout <s>
// which routes to `agent:<id>:rooms-<room>` (docs.openclaw.ai/cli/agent, read 2026-11-21, v2026.11.6). Not the
// /hooks/agent webhook: the CLI needs no hook token or config change, and it waits for the turn to end, so one wake
// at a time holds as for every other agent. Docs only: nobody has run this against a real OpenClaw.

import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { configDir } from "../config.js";
import { fail, shown } from "../core.js";
import { slug } from "../format.js";
import { installSkill, lastLine, run, skillInstalled, wakePath, wakeText, which } from "./shared.js";

const command = () => which("openclaw", process.env.AGENT_ROOMS_OPENCLAW);
const stateDir = () => process.env.AGENT_ROOMS_OPENCLAW_HOME || process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw");
const TIMEOUT_S = 1800;

/** Where an agent's turns run, and where its own skills load from first: `workspace` for main, else per id. */
const workspaceOf = (id) => join(stateDir(), id === "main" ? "workspace" : `workspace-${id}`);
const skillDir = (folder) => join(folder, "skills", "agent-rooms");

const displayName = (id) => (id === "main" ? "OpenClaw" : id.charAt(0).toUpperCase() + id.slice(1));

export default {
  kind: "openclaw",
  label: "OpenClaw",
  ask: "agent",
  usage: 'rooms setup openclaw [<agent id>] [--workspace <folder>] [--name "<name in rooms>"] [--no-wake] [--join "<room>"]',
  found: command,

  async setup({ args, flags }) {
    if (!existsSync(stateDir())) fail(`No OpenClaw home at ${shown(stateDir())}. Run this on the machine where OpenClaw's Gateway runs.`);
    const id = args[0] || "main";
    if (!/^[A-Za-z0-9_-]+$/.test(id)) fail(`"${id}" isn't an OpenClaw agent id.`);
    const given = typeof flags.workspace === "string" ? flags.workspace : workspaceOf(id);
    mkdirSync(given, { recursive: true });
    const folder = realpathSync(given);
    const name = typeof flags.name === "string" && flags.name.trim() ? flags.name.trim() : displayName(id);
    const notes = [`Wakes are turns through this machine's OpenClaw Gateway, in a session per room (rooms-<room>). The Gateway has to be running.`];
    if (!flags["no-skill"]) notes.push(`The agent-rooms skill in ${shown(skillDir(folder))}: ${installSkill(skillDir(folder))}.`);
    notes.push("OpenClaw runs under its own settings: whether it may write outside its workspace (the vault) is its tools.fs and sandbox settings, not this program's.");
    if (!command()) notes.push("`openclaw` isn't on the PATH here, so the relay can't start a turn yet.");
    return { agents: [{ kind: this.kind, name, folder, profile: id }], notes };
  },

  async wake(agent, wake) {
    const openclaw = command();
    if (!openclaw) return { ok: false, error: "`openclaw` isn't installed where the relay can find it" };
    // The text goes in a file of its own: a long message as one argument can pass the system's limit.
    const dir = join(configDir(), "outbox");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${randomBytes(6).toString("hex")}.txt`);
    writeFileSync(file, wakeText(agent, wake), { mode: 0o600 });
    try {
      const args = ["agent", "--agent", agent.profile || "main", "--session-key", `rooms-${slug(wake.room)}`, "--message-file", file, "--json", "--timeout", String(TIMEOUT_S)];
      const env = { ...process.env, PATH: wakePath(openclaw), AGENT_ROOMS_NAME: agent.name, AGENT_ROOMS_RELAY: "1" };
      const result = await run(openclaw, args, { cwd: agent.folder, env });
      if (result.code === 0) return { ok: true };
      if (/ECONNREFUSED|gateway (is )?(not running|unreachable)|closed connection|connect failed/i.test(result.output)) {
        return { ok: false, error: "OpenClaw's Gateway isn't running on this machine" };
      }
      return { ok: false, busy: /\b(429|503)\b|busy|rate limit/i.test(result.output), error: `openclaw ended with ${result.code}: ${lastLine(result.output)}` };
    } finally {
      rmSync(file, { force: true });
    }
  },

  check(agent) {
    const problems = [];
    if (!command()) problems.push("`openclaw` isn't on the PATH.");
    if (!existsSync(agent.folder)) problems.push(`Its workspace ${shown(agent.folder)} is gone.`);
    if (!skillInstalled(skillDir(agent.folder))) problems.push(`The skill isn't in ${shown(skillDir(agent.folder))}; run setup again.`);
    return problems;
  },
};
