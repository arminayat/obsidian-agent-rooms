// Codex CLI: an agent is one folder's Codex. A wake is `codex exec` in that folder, in a thread the relay owns for
// that agent and room: the first run's `thread.started` event names it, later runs are `codex exec resume <id>`.
// Flags from `codex exec --help` and `codex exec resume --help`, codex-cli 0.134. `resume` takes no --sandbox or
// --add-dir, so the sandbox is set with -c config overrides, which both accept.
//
// Codex Desktop (inside ChatGPT.app) shares ~/.codex but takes no prompt from outside, so it isn't a member of its
// own: wakes run here, and the thread opens in the app. While the app has a thread loaded, a headless resume is
// refused ("active writer", openai/codex issue 37403); that's reported as busy, so the relay tries again.

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { readersDir } from "../config.js";
import { fail, shown } from "../core.js";
import { installSkill, lastLine, run, skillInstalled, wakePath, wakeText, which } from "./shared.js";

/** The `codex` an agent runs: the one chosen at setup (`--command`), else the override or the PATH's. */
const command = (agent) => (agent?.command && existsSync(agent.command) ? agent.command : which("codex", process.env.AGENT_ROOMS_CODEX));

/** Codex's own log lines on stderr ("2026-11-21T20:07:53.255Z ERROR codex_…"): kept out of the relay's log. */
const TRACE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s/;

/** An error's words: the API's message when Codex passes on the API's JSON, else the text itself. */
function plainError(text) {
  try {
    const parsed = JSON.parse(text);
    return String(parsed?.error?.message ?? parsed?.message ?? text);
  } catch {
    return String(text);
  }
}
const skillDir = () => join(homedir(), ".agents", "skills", "agent-rooms");

/**
 * What a woken run may do. Scoped: Codex's workspace-write sandbox, which writes the agent's folder, plus the
 * vault and the readers' folder (so `rooms say` can record what it read), and no network for commands. Full: no
 * sandbox and no approvals, for an agent its person chose to trust. `exec` never stops to ask either way.
 */
export const sandbox = (agent, vault) => agent.trust === "full" ? ["--dangerously-bypass-approvals-and-sandbox"] : [
  "-c", 'sandbox_mode="workspace-write"',
  "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify([vault, readersDir()])}`,
];

/**
 * Reads a run's output as it comes. Standard output carries `--json` events: the thread's id, the agent's own
 * words (logged) and errors. Standard error carries Codex's own log, which stays out of the relay's log except
 * for lines that aren't log lines.
 */
function reader(found) {
  const partial = { stdout: "", stderr: "" };
  return (chunk, stream) => {
    const lines = (partial[stream] + chunk).split("\n");
    partial[stream] = lines.pop();
    for (const line of lines.filter((l) => l.trim())) {
      if (stream === "stderr") {
        if (!TRACE.test(line) && !/^Reading additional input from stdin/.test(line)) found.lastErr = line;
        if (!TRACE.test(line)) process.stdout.write(line + "\n");
        continue;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        process.stdout.write(line + "\n");
        continue;
      }
      if (event.type === "thread.started" && event.thread_id) found.thread = event.thread_id;
      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) process.stdout.write(event.item.text.trim() + "\n");
      if (event.type === "turn.failed" || event.type === "error") {
        found.error = plainError(event.error?.message ?? event.message ?? line).slice(0, 200);
        process.stdout.write(`error: ${found.error}\n`);
      }
    }
  };
}

export const label = "Codex";

export default {
  kind: "codex",
  label,
  ask: "folder",
  usage: 'rooms setup codex <folder> [--name "<name in rooms>"] [--command <path to codex>] [--trust full] [--no-wake] [--join "<room>"]',
  found: () => command(),

  /** Registers one folder's Codex as an agent and installs the skill where Codex loads personal skills. */
  async setup({ args, flags }) {
    const given = args[0] || fail(this.usage);
    if (!existsSync(given)) fail(`${given} doesn't exist.`);
    const folder = realpathSync(resolve(given));
    const name = typeof flags.name === "string" && flags.name.trim() ? flags.name.trim() : `Codex in ${basename(folder)}`;
    const agent = { kind: this.kind, name, folder };
    if (typeof flags.command === "string") {
      if (!existsSync(flags.command)) fail(`${flags.command} doesn't exist.`);
      agent.command = realpathSync(flags.command);
    }
    mkdirSync(readersDir(), { recursive: true }); // a writable root must exist before Codex starts
    const notes = [];
    if (agent.command) notes.push(`Wakes run ${shown(agent.command)}.`);
    if (!flags["no-skill"]) notes.push(`The agent-rooms skill in ${shown(skillDir())}: ${installSkill(skillDir())}.`);
    if (!command(agent)) notes.push("`codex` isn't on the PATH here, so the relay can't start it yet. Install the Codex CLI, then run setup again.");
    return { agents: [agent], notes };
  },

  async wake(agent, wake) {
    const codex = command(agent);
    if (!codex) return { ok: false, error: "`codex` isn't installed where the relay can find it" };
    mkdirSync(readersDir(), { recursive: true });
    const env = { ...process.env, PATH: wakePath(codex), AGENT_ROOMS_NAME: agent.name, AGENT_ROOMS_RELAY: "1" };
    const start = async () => {
      const first = !wake.session.id;
      const options = ["--json", "--skip-git-repo-check", ...sandbox(agent, wake.vault)];
      const args = first ? ["exec", ...options, wakeText(agent, wake)] : ["exec", "resume", ...options, wake.session.id, wakeText(agent, wake)];
      const found = {};
      const result = await run(codex, args, { cwd: agent.folder, env, onOutput: reader(found) });
      if (first && found.thread) wake.session.id = found.thread;
      return { first, error: found.error ?? (found.lastErr && plainError(found.lastErr).slice(0, 200)), ...result };
    };
    let result = await start();
    if (result.code !== 0 && /active writer/i.test(result.output)) {
      return { ok: false, busy: true, error: "its thread is open in the Codex app" };
    }
    if (result.code !== 0 && !result.first && /(no|not find|couldn't find|unknown) (session|thread|rollout)|(session|thread|rollout).{0,20}not found/i.test(result.output)) {
      delete wake.session.id; // its thread is gone: the room is the memory, so start a new one
      result = await start();
    }
    return result.code === 0 ? { ok: true } : { ok: false, error: `codex ended with ${result.code}: ${result.error ?? lastLine(result.output)}` };
  },

  check(agent) {
    const problems = [];
    if (!command(agent)) problems.push(agent.command ? `${shown(agent.command)} is gone.` : "`codex` isn't on the PATH.");
    if (!existsSync(agent.folder)) problems.push(`Its folder ${shown(agent.folder)} is gone.`);
    if (!skillInstalled(skillDir())) problems.push(`The skill isn't in ${shown(skillDir())}; run setup again.`);
    return problems;
  },

  /** How to open the thread a room's wakes run in. */
  open(agent, id) {
    return [`In a terminal: cd ${JSON.stringify(agent.folder)} && codex resume ${id}`,
      `In the Codex app: codex://threads/${id} (its folder has to be a project there; while it's open, wakes wait)`];
  },
};
