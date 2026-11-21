// Claude Code: an agent is one project folder's Claude. A wake is a headless run in that folder (`claude -p`),
// in a session the relay owns for that agent and room: started with --session-id, continued with --resume.
// Plugin monitors don't run under -p and a person's own sessions are never resumed (code.claude.com/docs, headless
// and sessions pages, read 2026-11-21): two runs resuming one session can lose messages.

import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fail, shown } from "../core.js";
import { installSkill, lastLine, run, skillInstalled, wakePath, wakeText, which } from "./shared.js";

const command = () => which("claude", process.env.AGENT_ROOMS_CLAUDE);
const skillDir = () => join(homedir(), ".claude", "skills", "agent-rooms");

/** The `rooms` commands a scoped run may use: the room ones, never those that change the machine's setup. */
export const ROOM_TOOLS = ["list", "read", "say", "wait", "join", "leave", "add", "members", "create", "pause", "resume", "news", "status", "help"]
  .map((command) => `Bash(rooms ${command}*)`);

/** What a woken run may do without asking. Scoped: edit its folder and the vault, the room commands, plus what
 *  the project's own settings already allow. Full: everything, for an agent its person chose to trust. */
const permissions = (agent) =>
  agent.trust === "full" ? ["--dangerously-skip-permissions"] : ["--permission-mode", "acceptEdits", "--allowedTools", ...ROOM_TOOLS];

export default {
  kind: "claude-code",
  label: "Claude Code",
  ask: "folder",
  usage: 'rooms setup claude-code <project folder> [--name "<name in rooms>"] [--trust full] [--no-wake] [--join "<room>"]',
  found: command,

  /** Registers one project's Claude as an agent and installs the skill where Claude Code loads its own. */
  async setup({ args, flags }) {
    const given = args[0] || fail(this.usage);
    if (!existsSync(given)) fail(`${given} doesn't exist.`);
    const folder = realpathSync(resolve(given));
    const name = typeof flags.name === "string" && flags.name.trim() ? flags.name.trim() : `Claude Code in ${basename(folder)}`;
    const notes = [];
    if (!flags["no-skill"]) notes.push(`The agent-rooms skill in ${shown(skillDir())}: ${installSkill(skillDir())}.`);
    if (!command()) notes.push("`claude` isn't on the PATH here, so the relay can't start it yet. Install Claude Code, then run setup again.");
    return { agents: [{ kind: this.kind, name, folder }], notes };
  },

  /** @param {{ vault: string, room: string, session: { id?: string } }} wake */
  async wake(agent, wake) {
    const claude = command();
    if (!claude) return { ok: false, error: "`claude` isn't installed where the relay can find it" };
    const start = async () => {
      const first = !wake.session.id;
      wake.session.id ??= randomUUID();
      const args = ["-p", wakeText(agent, wake), first ? "--session-id" : "--resume", wake.session.id, "--add-dir", wake.vault, ...permissions(agent)];
      const env = { ...process.env, PATH: wakePath(claude), AGENT_ROOMS_NAME: agent.name, AGENT_ROOMS_RELAY: "1" };
      return { first, ...(await run(claude, args, { cwd: agent.folder, env })) };
    };
    let result = await start();
    if (result.code !== 0 && !result.first && /no conversation found|session .*(not found|doesn't exist|does not exist)/i.test(result.output)) {
      delete wake.session.id; // its session is gone (cleared, or another machine's): the room is the memory, so start a new one
      result = await start();
    }
    return result.code === 0 ? { ok: true } : { ok: false, error: `claude ended with ${result.code}: ${lastLine(result.output)}` };
  },

  /** How to open the session a room's wakes run in. Headless sessions stay out of the apps' session pickers. */
  open(agent, id) {
    return [`In a terminal: cd ${JSON.stringify(agent.folder)} && claude --resume ${id}`,
      "Claude Desktop doesn't list headless sessions, so open it from a terminal; don't send in it while a wake runs."];
  },

  check(agent) {
    const problems = [];
    if (!command()) problems.push("`claude` isn't on the PATH.");
    if (!existsSync(agent.folder)) problems.push(`Its folder ${shown(agent.folder)} is gone.`);
    if (!skillInstalled(skillDir())) problems.push(`The skill isn't in ${shown(skillDir())}; run setup again.`);
    return problems;
  },
};
