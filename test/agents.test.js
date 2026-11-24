// The agent modules beyond Claude Code and Hermes (Codex, the desktop apps), what each needs from its machine, the
// conversation each agent is woken in, and what a woken agent may not change. Stand-in agents only.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { yamlValue } from "../src/agents/hermes.js";
import { names, prompt, scene } from "./helpers.js";

const binDir = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");

test("Codex is woken in a thread of its own per room, sandboxed to its folder, the vault and its place", () => {
  const b = scene();
  b.ok(["setup", "codex", b.project, "--name", "Codex", "--join", "Launch"]);
  assert.ok(existsSync(join(b.home, ".agents", "skills", "agent-rooms", "SKILL.md")), "the skill where Codex loads personal skills");
  b.relay(); // its first look: from now on
  b.runs();

  b.say("Armin", "Codex, review the migration.", ["--to", "Codex"]);
  b.relay();
  const [first] = b.runs();
  assert.equal(first.name, "Codex");
  assert.equal(first.cwd, b.project);
  assert.deepEqual(first.args.slice(0, 7), ["exec", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"', "-c",
    `sandbox_workspace_write.writable_roots=${JSON.stringify([b.vault, join(b.config, "readers")])}`]);
  assert.match(prompt(first), /You are "Codex" there\.[\s\S]*review the migration/);
  assert.match(b.ok(["relay", "status"]).out, /"Codex": last woken in Launch/);

  b.say("Armin", "And the tests?", ["--to", "Codex"]);
  b.relay();
  const [second] = b.runs();
  assert.deepEqual(second.args.slice(0, 3), ["exec", "resume", "--json"]);
  assert.equal(second.args.at(-2), "thread-1", "the thread its first wake started continues");
  assert.match(b.ok(["session", "Launch", "--as", "Codex"]).out, /Codex: thread-1\n {2}In a terminal: cd .*api.* && codex resume thread-1\n {2}In the Codex app: codex:\/\/threads\/thread-1/);

  b.ok(["setup", "codex", b.project, "--name", "Codex", "--trust", "full"]);
  b.say("Armin", "Full trust now.", ["--to", "Codex"]);
  b.relay();
  const [trusted] = b.runs();
  assert.ok(trusted.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!trusted.args.includes('sandbox_mode="workspace-write"'));
});

test("a thread open in the Codex app makes the wake wait, not fail", () => {
  const b = scene();
  b.ok(["setup", "codex", b.project, "--name", "Codex", "--join", "Launch"]);
  b.relay();
  b.runs();
  b.behave({ Codex: { fail: "Error: thread thread-1 already has an active writer" } });
  b.say("Armin", "Anyone?", ["--to", "Codex"]);
  for (let i = 0; i < 4; i++) b.relay();
  assert.equal(b.runs().length, 4, "tried again at every look, with no give-up");
  assert.doesNotMatch(b.messages().map((m) => m.body).join("\n"), /Couldn't wake/, "busy isn't a failure to report");
  assert.match(b.ok(["relay", "status"]).out, /"Codex": last busy; trying again/);
  b.behave({});
  b.relay();
  assert.deepEqual(names(b.runs()), ["Codex"]);
  b.relay();
  assert.deepEqual(b.runs(), [], "and once through, not again");
});

test("the desktop apps are set up as the command-line agent that wakes for them", () => {
  const b = scene();
  const claude = b.ok(["setup", "claude-desktop", b.project, "--name", "Desk"]).out;
  assert.match(claude, /Set up Claude Code \(for Claude Desktop\) as "Desk"[\s\S]*can't be woken from outside, so wakes run as Claude Code/);
  const codex = b.ok(["setup", "codex-desktop", b.project, "--name", "App"]).out;
  assert.match(codex, /Set up Codex \(for Codex Desktop\) as "App"[\s\S]*rooms session/);
  const config = JSON.parse(readFileSync(join(b.config, "config.json"), "utf8"));
  assert.deepEqual(config.agents.filter((a) => ["Desk", "App"].includes(a.name)).map((a) => [a.name, a.kind]), [["Desk", "claude-code"], ["App", "codex"]]);
});

test("inside a wake, an agent can talk but can't change the machine's setup", () => {
  const b = scene();
  const inWake = { extraEnv: { AGENT_ROOMS_RELAY: "1" } };
  for (const args of [["trust", "Armin", "A".repeat(87)], ["key", "new", "Armin"], ["setup", "claude-code", b.project], ["vault", "add", b.root], ["agents", "remove", "Hermes"], ["relay", "install"]]) {
    const refused = b.rooms(args, inWake);
    assert.equal(refused.code, 1, `rooms ${args.join(" ")}`);
    assert.match(refused.err, /changes this machine's setup, which only its person does/);
  }
  assert.equal(b.rooms(["relay", "status"], inWake).code, 0);
  assert.equal(b.rooms(["say", "Launch", "Still allowed.", "--anyway"], { ...inWake, as: "Claude" }).code, 0);
  assert.ok(existsSync(join(b.config, "readers", "claude.json")), "what an agent has read is kept in the readers' folder");
});

test("a place kept under the old name is still read", () => {
  const b = scene();
  b.say("Armin", "One.");
  b.ok(["read", "Launch"], { as: "Hermes" });
  const kept = join(b.config, "readers", "hermes.json");
  writeFileSync(join(b.config, "reader-hermes.json"), readFileSync(kept));
  writeFileSync(kept, "not json"); // unreadable, as if it weren't there
  assert.match(b.ok(["read", "Launch"], { as: "Hermes" }).out, /No new messages/);
});

test("a failed wake waits out its pause before the next try", () => {
  const b = scene();
  b.behave({ Claude: { fail: "boom" } });
  b.say("Armin", "Status?", ["--to", "Claude"]);
  const slow = { extraEnv: { AGENT_ROOMS_RETRY_SECONDS: "60" } };
  b.ok(["relay", "--once"], slow);
  assert.equal(b.runs().length, 1);
  b.ok(["relay", "--once"], slow);
  assert.deepEqual(b.runs(), [], "not again within the minute");
  const file = join(b.config, "relay.json");
  const state = JSON.parse(readFileSync(file, "utf8"));
  for (const record of Object.values(state.agents)) for (const room of Object.values(record.rooms)) if (room.retryAt) room.retryAt = Date.now() - 1;
  writeFileSync(file, JSON.stringify(state)); // as if the minute had passed
  b.relay();
  assert.equal(b.runs().length, 1);
});

test("a Codex error says what the API said, without Codex's own log", () => {
  const b = scene();
  b.ok(["setup", "codex", b.project, "--name", "Codex", "--join", "Launch"]);
  b.relay();
  b.runs();
  b.behave({ Codex: { fail: "2026-11-21T20:07:53.255172Z ERROR codex_models_manager::cache: failed to load models cache\n{\"type\":\"error\",\"status\":400,\"error\":{\"message\":\"The model is not supported.\"}}" } });
  b.say("Armin", "Hello?", ["--to", "Codex"]);
  for (let i = 0; i < 3; i++) b.relay();
  const notice = b.messages().at(-1);
  assert.equal(notice.notice, true);
  assert.match(notice.body, /codex ended with 1: The model is not supported\.\./);
  assert.doesNotMatch(notice.body, /codex_models_manager|\{"type"/);
});

test("a Hermes Bot on a Claude subscription needs a Claude login of its own before it can be woken", () => {
  const b = scene();
  const profile = join(b.hermes, "profiles", "belfort");
  mkdirSync(profile, { recursive: true });
  const config = (extra = "") => writeFileSync(join(profile, "config.yaml"),
    "model:\n  default: claude-opus\n  provider: claude-subscription-directsdk-experimental\nterminal:\n  cwd: /tmp # its own\n" +
    `plugins:\n  enabled:\n    - claude-subscription-directsdk-experimental\n${extra}`);
  config();
  const setup = b.ok(["setup", "hermes", "belfort", "--name", "Belfort", "--join", "Launch"]).out;
  assert.match(setup, /"Belfort": Its model is a Claude subscription, and its profile has no Claude login of its own/);
  assert.match(setup, /hermes -p belfort config set plugins\.entries\.claude-subscription-directsdk-experimental\.settings\.claude_config_dir ~\/\.claude/);
  const doctor = () => b.rooms(["doctor"]).out.split("\n").filter((line) => line.includes("Belfort")).join("\n");
  assert.match(doctor(), /FIX {2}Belfort: Its model is a Claude subscription/);

  config("  entries:\n    claude-subscription-directsdk-experimental:\n      settings:\n        claude_config_dir: ~/.claude-belfort\n");
  assert.match(doctor(), /FIX {2}Belfort: Its Claude login folder ~\/\.claude-belfort \(claude_config_dir\) doesn't exist/);
  mkdirSync(join(b.home, ".claude-belfort"));
  assert.match(doctor(), /ok {3}Belfort: Hermes is set up/, "a login folder of its own");

  config();
  writeFileSync(join(profile, ".env"), "CLAUDE_CODE_OAUTH_TOKEN=\n");
  assert.match(doctor(), /FIX {2}Belfort/, "an empty token is no login");
  writeFileSync(join(profile, ".env"), "OPENAI_API_KEY=x\nexport CLAUDE_CODE_OAUTH_TOKEN=\"sk-ant-oat01-x\"\n");
  assert.match(doctor(), /ok {3}Belfort: Hermes is set up/, "a token of its own");

  writeFileSync(join(profile, "config.yaml"), "model:\n  provider: openai-codex\n");
  rmSync(join(profile, ".env"));
  assert.match(doctor(), /ok {3}Belfort: Hermes is set up/, "another provider needs no Claude login");
  assert.doesNotMatch(b.rooms(["doctor"]).out, /FIX {2}Hermes:/, "the default profile is the one Hermes is launched for");
});

test("a value is read from a config.yaml by its keys, nested mappings only", () => {
  const text = "model:\n  default: gpt\n  provider: 'openai-codex'\nterminal:\n  env:\n    cwd: /wrong\n  cwd: \"/right\"  # a comment\n" +
    "plugins:\n  enabled:\n    - a\n  entries:\n    a:\n      settings:\n        claude_config_dir: ~/.claude\nbase_url: https://x.test/a:b\n";
  assert.equal(yamlValue(text, ["model", "provider"]), "openai-codex");
  assert.equal(yamlValue(text, ["terminal", "cwd"]), "/right", "not the deeper key of the same name");
  assert.equal(yamlValue(text, ["plugins", "entries", "a", "settings", "claude_config_dir"]), "~/.claude");
  assert.equal(yamlValue(text, ["base_url"]), "https://x.test/a:b");
  assert.equal(yamlValue(text, ["model", "cwd"]), undefined, "a key from the next mapping isn't this one's");
  assert.equal(yamlValue(text, ["missing"]), undefined);
});

test("an agent's own terminal may lack rooms: the skill gives the full command, and doctor says so", () => {
  const b = scene();
  const skill = readFileSync(join(b.hermes, "skills", "knowledge", "agent-rooms", "SKILL.md"), "utf8");
  assert.match(skill, /## On this machine\n\nIf `rooms` isn't found in your terminal, run ".*node" ".*bin\/rooms" instead, with the same arguments\.\n$/);
  const node = dirname(process.execPath);
  const without = b.rooms(["doctor"], { extraEnv: { PATH: `${node}:/usr/bin:/bin` } }).out;
  assert.match(without, /FIX {2}`rooms` doesn't run in this terminal: `rooms` isn't on its PATH\. .* run ".*node" ".*bin\/rooms" instead[\s\S]*add .*bin to the PATH/);
  assert.match(b.rooms(["doctor"], { extraEnv: { PATH: `${binDir}:${node}:/usr/bin:/bin` } }).out, /ok {3}`rooms` runs in this terminal/);
});
