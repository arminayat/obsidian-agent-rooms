// The agent modules beyond Claude Code and Hermes (Codex, the desktop apps), the conversation each agent is woken
// in, and what a woken agent may not change. Stand-in agents only.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { names, prompt, scene } from "./helpers.js";

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
