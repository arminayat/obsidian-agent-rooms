// Hermes Agent: an agent is one Hermes profile (a Bot). A wake is one turn in the Bot's own "Bot Chat", with the
// new messages as the message, so the Bot answers where its person already reads it:
//   hermes [-p <profile>] chat --in ~ -c "Bot Chat" --create-if-missing -Q --query-file -
// (flags from `hermes chat --help`, v0.23.1). Runs on the machine where Hermes runs.

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fail, shown } from "../core.js";
import { installSkill, lastLine, run, skillInstalled, wakePath, wakeText, which } from "./shared.js";

const command = () => which("hermes", process.env.AGENT_ROOMS_HERMES);
const root = () => process.env.AGENT_ROOMS_HERMES_HOME || join(homedir(), ".hermes");
const DEFAULT = "default";

/** The default profile is Hermes's home itself; named ones live under profiles/. */
const profileDir = (profile) => (profile === DEFAULT ? root() : join(root(), "profiles", profile));
const skillDir = (profile) => join(profileDir(profile), "skills", "knowledge", "agent-rooms");

function profiles() {
  const dir = join(root(), "profiles");
  return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [];
}

const read = (file) => (existsSync(file) ? readFileSync(file, "utf8") : "");
const config = (profile) => read(join(profileDir(profile), "config.yaml"));
const unquote = (text) => text.replace(/^(["'])(.*)\1$/, "$2");

/** A value in a config.yaml that Hermes wrote, by its keys, such as ["terminal", "cwd"]: nested mappings only. */
export function yamlValue(text, keys) {
  let level = 0;
  let parent = -1; // the indent of the last key found
  let child = null; // the indent of the keys inside it
  for (const line of text.split(/\r?\n/)) {
    const entry = line.match(/^( *)([^\s#-][^:]*?):(?:[ \t]+(.*?))?[ \t]*$/);
    if (!entry) continue;
    const indent = entry[1].length;
    if (indent <= parent) return undefined;
    child ??= indent;
    if (indent !== child || unquote(entry[2]) !== keys[level]) continue;
    if (++level === keys.length) return unquote((entry[3] ?? "").replace(/[ \t]+#.*$/, ""));
    parent = indent;
    child = null;
  }
  return undefined;
}

/** The folder a Bot's terminal starts in: `terminal.cwd` in its config.yaml when absolute, else its workspace. */
function workspaceOf(profile) {
  const cwd = yamlValue(config(profile), ["terminal", "cwd"]);
  return cwd && isAbsolute(cwd) ? cwd : join(profileDir(profile), "workspace");
}

/**
 * Why a Bot whose model is the Claude subscription can't sign in when the relay starts it, or "". Started with
 * `-p <profile>`, the Claude plugin refuses the login of the profile Hermes was launched for, so a named profile
 * needs its own: the plugin's claude_config_dir setting, or a token or folder in its .env.
 * The default profile is the one launched for, so it uses this machine's Claude login.
 */
export function claudeLoginProblem(profile) {
  if (profile === DEFAULT) return "";
  const text = config(profile);
  const provider = yamlValue(text, ["model", "provider"]) ?? "";
  if (!provider.startsWith("claude-subscription")) return "";
  const folder = yamlValue(text, ["plugins", "entries", provider, "settings", "claude_config_dir"])?.trim();
  if (folder) {
    return existsSync(folder.replace(/^~(?=\/|$)/, homedir())) ? "" : `Its Claude login folder ${folder} (claude_config_dir) doesn't exist.`;
  }
  const env = join(profileDir(profile), ".env");
  if (/^(?:export[ \t]+)?(?:CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR|CLAUDE_CONFIG_DIR)[ \t]*=[ \t]*["']?[^\s"'#]/m.test(read(env))) return "";
  return "Its model is a Claude subscription, and its profile has no Claude login of its own, so a woken turn can't sign in. " +
    `Ask its person which login it should use: this machine's, with \`hermes -p ${profile} config set plugins.entries.${provider}.settings.claude_config_dir ~/.claude\` ` +
    `(where Claude Code keeps it), or one of its own, with CLAUDE_CODE_OAUTH_TOKEN from \`claude setup-token\` in ${shown(env)}.`;
}

const displayName = (profile) => (profile === DEFAULT ? "Hermes" : profile.charAt(0).toUpperCase() + profile.slice(1));

export default {
  kind: "hermes",
  label: "Hermes",
  ask: "profiles",
  usage: 'rooms setup hermes [<profile>… | --all] [--name "<name in rooms>"] [--trust full] [--no-wake] [--join "<room>"]',
  found: command,

  /** Registers Bots as agents: one per profile, the skill in each Bot's own skills. */
  async setup({ args, flags }) {
    if (!existsSync(root())) fail(`No Hermes home at ${shown(root())}. Run this on the machine where Hermes runs.`);
    const known = profiles();
    const chosen = flags.all ? (known.length ? known : [DEFAULT]) : args.length ? args : known.length ? [] : [DEFAULT];
    if (!chosen.length) fail(`${this.usage}\nProfiles here: ${known.join(", ")}; "${DEFAULT}" is the one without a name.`);
    const unknown = chosen.filter((p) => p !== DEFAULT && !known.includes(p));
    if (unknown.length) fail(`No Hermes profile called ${unknown.join(", ")}. Profiles here: ${[DEFAULT, ...known].join(", ")}.`);
    if (typeof flags.name === "string" && chosen.length > 1) fail("--name names one Bot; set them up one at a time to name each.");
    const agents = [];
    const notes = [];
    for (const profile of chosen) {
      const workspace = workspaceOf(profile);
      mkdirSync(workspace, { recursive: true });
      const name = typeof flags.name === "string" && flags.name.trim() ? flags.name.trim() : displayName(profile);
      agents.push({ kind: this.kind, name, folder: realpathSync(workspace), profile });
      if (!flags["no-skill"]) notes.push(`"${name}" (profile ${profile}): the agent-rooms skill in ${shown(skillDir(profile))}: ${installSkill(skillDir(profile))}.`);
      const login = claudeLoginProblem(profile);
      if (login) notes.push(`"${name}": ${login}`);
    }
    if (!command()) notes.push("`hermes` isn't on the PATH here, so the relay can't start a turn yet.");
    return { agents, notes };
  },

  async wake(agent, wake) {
    const hermes = command();
    if (!hermes) return { ok: false, error: "`hermes` isn't installed where the relay can find it" };
    const args = [...(agent.profile && agent.profile !== DEFAULT ? ["-p", agent.profile] : []),
      "chat", "--in", homedir(), "-c", "Bot Chat", "--create-if-missing", "-Q", "--query-file", "-", ...(agent.trust === "full" ? ["--yolo"] : [])];
    const env = { ...process.env, PATH: wakePath(hermes), AGENT_ROOMS_NAME: agent.name, AGENT_ROOMS_RELAY: "1" };
    const result = await run(hermes, args, { cwd: agent.folder, env, input: wakeText(agent, wake) });
    return result.code === 0 ? { ok: true } : { ok: false, error: `hermes ended with ${result.code}: ${lastLine(result.output)}` };
  },

  check(agent) {
    const problems = [];
    if (!command()) problems.push("`hermes` isn't on the PATH.");
    if (!existsSync(profileDir(agent.profile || DEFAULT))) problems.push(`Its profile ${agent.profile} is gone.`);
    if (!skillInstalled(skillDir(agent.profile || DEFAULT))) problems.push(`The skill isn't in ${shown(skillDir(agent.profile || DEFAULT))}; run setup again.`);
    const login = claudeLoginProblem(agent.profile || DEFAULT);
    if (login) problems.push(login);
    return problems;
  },
};
