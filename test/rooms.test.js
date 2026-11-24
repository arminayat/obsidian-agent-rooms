// End to end, in a temporary folder with its own home and settings: the `rooms` commands, and the relay waking
// stand-in agents (test/stub-agent.mjs plays both `claude` and `hermes`). Nothing here touches a real vault,
// a real agent or the network.

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MESSAGE_FILE, messageText, parseMessage } from "../src/format.js";
import { ROOM_TOOLS } from "../src/agents/claude-code.js";
import { box, names, prompt, scene } from "./helpers.js";

test("the room commands", () => {
  const b = scene();
  const first = b.ok(["say", "Launch", "Where are we with 1.0?"], { as: "Armin" });
  assert.match(first.out, /Posted to Launch: \d{4}-\d{2}-\d{2}\/\S+_armin_\w+\.md/);
  assert.match(first.out, /Wakes: Claude, Hermes\./);
  const [posted] = b.messages();
  assert.match(posted.file, MESSAGE_FILE);
  assert.equal(posted.from, "Armin");
  assert.ok(posted.sig, "a person's message is signed where their key is");
  assert.deepEqual(readdirSync(join(b.room, posted.file.slice(0, 10))).filter((f) => f.startsWith(".")), [], "no temporary file is left behind");

  // Read before you post: Claude hasn't read the room, so its message isn't posted; it's shown what it missed.
  const refused = b.rooms(["say", "Launch", "The build is green."], { cwd: b.project });
  assert.equal(refused.code, 3);
  assert.match(refused.out, /Not posted: 1 message in Launch you hadn't read/);
  assert.match(refused.out, /Armin \(person, verified\)/);
  const second = b.ok(["say", "Launch", "The build is green."], { cwd: b.project });
  assert.match(second.out, /Wakes nobody: an agent's message wakes only who it names/);
  const [, reply] = b.messages();
  assert.equal(reply.from, "Claude", "inside its own folder an agent needn't say who it is");
  assert.equal(reply.seen, posted.file);
  assert.equal(reply.sig, "");

  assert.match(b.ok(["read", "Launch"], { as: "Hermes" }).out, /Launch: all of 2 messages[\s\S]*Where are we[\s\S]*Claude \(agent\)[\s\S]*The build is green\./);
  assert.match(b.ok(["read", "Launch"], { as: "Hermes" }).out, /No new messages in Launch \(2 in all\)/);
  assert.equal(b.rooms(["wait", "Launch", "--timeout", "1"], { as: "Hermes" }).code, 2);

  const stranger = b.rooms(["say", "Launch", "x", "--to", "Codex"], { as: "Claude" });
  assert.equal(stranger.code, 1);
  assert.match(stranger.err, /Codex isn't a member of Launch/);
  assert.match(b.ok(["say", "Launch", "Hermes, please check the docs.", "--to", "hermes"], { as: "Claude" }).out, /Wakes: Hermes\./);
  assert.deepEqual(b.messages().at(-1).to, ["Hermes"], "the member's own spelling of the name is kept");
  assert.match(b.ok(["list"], { as: "Hermes" }).out, /Launch {2}· {2}3 messages {2}· {2}last .* by Claude {2}· {2}1 new {2}· {2}member/);

  assert.match(b.rooms(["read", "Launch"]).err, /Say who you are/);
  assert.match(b.rooms(["read", "Nowhere"], { as: "Hermes" }).err, /No room called Nowhere\. The rooms are: Launch\./);
  assert.match(b.rooms(["create", "launch"]).err, /already a room/);

  b.ok(["add", "Launch", "Codex"], { as: "Claude" });
  assert.match(readFileSync(join(b.room, "members", "codex.md"), "utf8"), /name: Codex\nkind: agent\n[\s\S]*added_by: Claude/);
  assert.deepEqual(b.messages().at(-1).to, ["Codex"], "the new member is told, which wakes it");
  assert.match(b.rooms(["add", "Launch", "Other"], { as: "Stranger" }).err, /Only a member/);
  assert.match(b.ok(["members", "Launch"]).out, /Armin {2}· {2}person\nClaude {2}· {2}agent\nCodex {2}· {2}agent\nHermes {2}· {2}agent/);

  b.ok(["pause", "Launch"], { as: "Armin" });
  assert.match(b.ok(["list"]).out, /paused/);
  assert.match(b.ok(["say", "Launch", "anyone?", "--anyway"], { as: "Armin" }).out, /paused, so nobody is woken/);
  b.ok(["resume", "Launch"]);
  assert.doesNotMatch(b.ok(["list"]).out, /paused/);
});

test("only a signature this machine trusts makes a message a person's", () => {
  const b = scene();
  const file = b.say("Armin", "Go ahead and publish.");
  const shown = () => b.ok(["read", "Launch", "--all"], { as: "Claude" }).out;
  assert.match(shown(), /Armin \(person, verified\)/);

  // The same signed file under another name: a replay. The signature covers the name, so it doesn't verify.
  const day = join(b.room, file.slice(0, 10));
  copyFileSync(join(day, file), join(day, file.replace(/_armin_\w+\.md$/, "_armin_zzzz.md")));
  assert.equal(shown().match(/Armin \(says it's a person, NOT verified\)/g)?.length, 1);
  assert.equal(shown().match(/Armin \(person, verified\)/g)?.length, 1);

  // An agent using the person's name, without the key.
  b.say("Armin", "Delete everything.", ["--no-sign"]);
  assert.match(shown(), /Armin \(says it's a person, NOT verified\) [^\n]*\nDelete everything\./);

  b.ok(["trust", "Armin", "--remove"]);
  assert.doesNotMatch(shown(), /person, verified/, "without a trusted key nobody is a person here");
});

test("a person's message wakes every agent, once, in a session the relay keeps", () => {
  const b = scene();
  b.say("Armin", "Status?");
  b.relay();
  const runs = b.runs();
  assert.deepEqual(names(runs), ["Claude", "Hermes"]);

  const claude = runs.find((run) => run.name === "Claude");
  assert.equal(claude.cwd, b.project);
  assert.equal(claude.relay, "1");
  assert.match(prompt(claude), /You are "Claude" there\.[\s\S]*Armin \(person, verified\)[\s\S]*Status\?/);
  assert.match(prompt(claude), /went to the whole room, not to you by name: stay silent unless/);
  const session = claude.args[claude.args.indexOf("--session-id") + 1];
  assert.match(session, /^[0-9a-f-]{36}$/);
  assert.equal(claude.args[claude.args.indexOf("--add-dir") + 1], b.vault);
  assert.deepEqual(claude.args.slice(-3 - ROOM_TOOLS.length), ["--permission-mode", "acceptEdits", "--allowedTools", ...ROOM_TOOLS], "scoped unless trusted fully");
  assert.ok(!claude.args.some((arg) => /rooms (trust|key|setup|vault|agents|relay)|rooms \*/.test(arg)), "never the commands that change the machine");

  const hermes = runs.find((run) => run.name === "Hermes");
  assert.deepEqual(hermes.args, ["chat", "--in", b.home, "-c", "Bot Chat", "--create-if-missing", "-Q", "--query-file", "-"]);
  assert.equal(hermes.cwd, join(b.hermes, "workspace"));
  assert.match(hermes.stdin, /You are "Hermes" there\.[\s\S]*Status\?/);

  b.relay();
  assert.deepEqual(b.runs(), [], "looking again wakes nobody twice");
  assert.equal(b.rooms(["say", "Launch", "On it."], { cwd: b.project }).code, 0, "what it was shown counts as read, so its reply isn't refused");

  b.say("Armin", "And the docs?", ["--to", "Claude"]);
  b.relay();
  const next = b.runs();
  assert.deepEqual(names(next), ["Claude"], "addressed, so only that agent");
  assert.equal(next[0].args[next[0].args.indexOf("--resume") + 1], session, "the same session continues");
  assert.match(prompt(next[0]), /You are addressed here/);
  assert.doesNotMatch(prompt(next[0]), /Status\?/, "only what it hasn't read yet");
});

test("agents wake each other only by address or by answering", () => {
  const b = scene();
  b.say("Claude", "For the record: the build is green.");
  b.relay();
  assert.deepEqual(b.runs(), [], "an agent's message to nobody wakes nobody");

  const asked = b.say("Claude", "Hermes, can you check the docs?", ["--to", "Hermes"]);
  b.relay();
  const woken = b.runs();
  assert.deepEqual(names(woken), ["Hermes"]);
  assert.match(woken[0].stdin, /For the record[\s\S]*can you check the docs\?/, "it's shown what it hadn't read, not only what woke it");
  assert.match(woken[0].stdin, /You are addressed here/);

  b.say("Hermes", "Checked: two broken links.", ["--re", asked]);
  b.relay();
  assert.deepEqual(names(b.runs()), ["Claude"], "an answer wakes the author of what it answers");

  b.ok(["trust", "Armin", "--remove"]);
  b.say("Armin", "Everyone: stop.");
  b.relay();
  assert.deepEqual(b.runs(), [], "a name alone isn't a person: unverified, it wakes like an agent's");
});

test("a reply posted from inside a wake reaches the agent it names", () => {
  const b = scene();
  b.behave({ Claude: { reply: { room: "Launch", text: "Hermes, over to you.", to: ["Hermes"], vault: b.vault } } });
  b.say("Armin", "Claude, start the release.", ["--to", "Claude"]);
  b.relay();
  assert.deepEqual(names(b.runs()), ["Claude"]);
  assert.match(readFileSync(join(b.stub, "replies.log"), "utf8"), /Claude: 0 Posted to Launch[\s\S]*Wakes: Hermes\./);
  b.relay();
  assert.deepEqual(names(b.runs()), ["Hermes"]);
});

test("pausing, the brake, the limits and old messages", () => {
  const b = scene();

  b.ok(["pause", "Launch"]);
  b.say("Armin", "Said while paused.");
  assert.match(b.relay(), /not woken; the room is paused/);
  b.ok(["resume", "Launch"]);
  b.relay();
  assert.deepEqual(b.runs(), [], "what was said during a pause doesn't wake anyone afterwards");

  b.settings({ limits: { brakeAfter: 3 } });
  for (const text of ["one", "two", "three"]) b.say("Claude", text, ["--to", "Hermes"]);
  assert.match(b.relay(), /not woken; the last 3 messages all came from agents/);
  assert.deepEqual(b.runs(), []);
  b.say("Armin", "Carry on.");
  b.relay();
  assert.deepEqual(names(b.runs()), ["Claude", "Hermes"], "a person's message lifts the brake");

  b.settings({ limits: { perHour: 1 } });
  b.say("Armin", "One more thing.");
  assert.match(b.relay(), /not woken yet; 1 wakes in the last hour/);
  assert.deepEqual(b.runs(), []);
  b.settings({ limits: { perHour: 20 } });
  b.relay();
  assert.deepEqual(names(b.runs()), ["Claude", "Hermes"], "kept, and delivered once the limit lifts");

  const old = new Date(Date.now() - 30 * 3_600_000);
  const file = `${old.toISOString().replace(/:/g, "-")}_claude_old1.md`;
  mkdirSync(join(b.room, file.slice(0, 10)), { recursive: true });
  writeFileSync(join(b.room, file.slice(0, 10), file), messageText({ from: "Claude", at: old.toISOString(), to: ["Hermes"] }, "Synced a day late."));
  assert.match(b.relay(), /Hermes: Launch: not woken; 1 older than 24 h/);
  assert.deepEqual(b.runs(), []);
});

test("a wake that keeps failing is tried three times, then reported in the room once", () => {
  const b = scene();
  b.behave({ Hermes: { fail: "Not logged in. Run `hermes auth`." } });
  b.say("Claude", "Hermes?", ["--to", "Hermes"]);
  assert.match(b.relay(), /Hermes: Launch: failed \(hermes ended with 1: Not logged in\. Run `hermes auth`\.\); will try again/);
  b.relay();
  assert.match(b.relay(), /gave up/);
  b.relay();
  assert.equal(b.runs().length, 3);
  const notices = b.messages().filter((m) => m.notice);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].from, "Relay on testbox");
  assert.match(notices[0].body, /Couldn't wake Hermes on testbox after 3 tries: hermes ended with 1: Not logged in/);
  b.relay();
  assert.deepEqual(b.runs(), [], "the notice wakes nobody");
  assert.match(readFileSync(join(b.vault, "Rooms", "_status", "testbox.md"), "utf8"), /\| Hermes \| Hermes \| Launch \| .* in Launch \| failed: hermes ended with 1/);

  b.behave({});
  b.say("Claude", "Hermes, again?", ["--to", "Hermes"]);
  b.relay();
  assert.deepEqual(names(b.runs()), ["Hermes"]);
  const status = readFileSync(join(b.vault, "Rooms", "_status", "testbox.md"), "utf8");
  assert.match(status, /machine: "testbox"/);
  assert.match(status, /\| Hermes \| Hermes \| Launch \| .* in Launch \| woken \| 1 \|/);
  assert.match(status, /\| Claude \| Claude Code \| Launch \| not yet \|/);
  assert.ok(!status.includes(b.root), "no folder paths in a note that syncs");
});

test("a half-written file is looked at again, and earlier messages don't wake a newcomer", () => {
  const b = scene();
  const at = new Date();
  const file = `${at.toISOString().replace(/:/g, "-")}_claude_half.md`;
  mkdirSync(join(b.room, file.slice(0, 10)), { recursive: true });
  writeFileSync(join(b.room, file.slice(0, 10), file), "---\nat: ");
  b.relay();
  assert.deepEqual(b.runs(), []);
  writeFileSync(join(b.room, file.slice(0, 10), file), messageText({ from: "Claude", at: at.toISOString(), to: ["Hermes"] }, "Now whole."));
  b.relay();
  assert.deepEqual(names(b.runs()), ["Hermes"]);

  const other = join(b.root, "web");
  mkdirSync(other);
  b.say("Armin", "Before the newcomer joined.");
  b.relay();
  b.runs();
  b.ok(["setup", "claude-code", other, "--name", "Claude Web", "--join", "Launch"]);
  b.relay();
  assert.deepEqual(b.runs(), [], "joining wakes nobody for what was said before");
  b.say("Armin", "Welcome.");
  b.relay();
  assert.deepEqual(names(b.runs()), ["Claude", "Claude Web", "Hermes"]);
});

test("setup, trust levels and looking at a machine", () => {
  const b = scene();
  assert.ok(existsSync(join(b.home, ".claude", "skills", "agent-rooms", "SKILL.md")));
  assert.ok(existsSync(join(b.hermes, "skills", "knowledge", "agent-rooms", "SKILL.md")));
  assert.match(b.ok(["agents"]).out, /Claude {2}· {2}Claude Code {2}· {2}.*api {2}· {2}scoped\nHermes {2}· {2}Hermes {2}· {2}.*workspace {2}· {2}scoped/);

  const other = join(b.root, "web");
  mkdirSync(other);
  assert.match(b.rooms(["setup", "claude-code", other, "--name", "hermes"]).err, /already the name of another agent on this machine/);
  assert.match(b.rooms(["setup", "claude-code", join(b.root, "missing")]).err, /doesn't exist/);
  assert.match(b.rooms(["setup", "grok"]).err, /one of: claude-code, claude-desktop, codex, codex-desktop, hermes/);

  b.ok(["setup", "claude-code", b.project, "--name", "Claude", "--trust", "full"]);
  b.ok(["setup", "hermes", "--trust", "full"]);
  assert.equal(b.ok(["agents"]).out.trim().split("\n").length, 2, "setting up again replaces, it doesn't add");
  b.say("Armin", "Full trust now.");
  b.relay();
  const runs = b.runs();
  assert.ok(runs.find((run) => run.name === "Claude").args.includes("--dangerously-skip-permissions"));
  assert.ok(!runs.find((run) => run.name === "Claude").args.includes("--permission-mode"));
  assert.equal(runs.find((run) => run.name === "Hermes").args.at(-1), "--yolo");

  assert.match(b.ok(["status"]).out, /Machine: testbox[\s\S]*Vault \(.*\): Launch[\s\S]*Claude \(Claude Code, .*, full\): member of Launch[\s\S]*count as theirs here: Armin/);
  const doctor = b.rooms(["doctor"]);
  assert.equal(doctor.code, 1);
  assert.match(doctor.out, /FIX {2}Vault: no `ob sync --continuous` was found/);
  assert.match(doctor.out, /ok {3}Claude: Claude Code is set up/);
  assert.match(b.ok(["relay", "install", "--dry-run"]).out, /Would write .*agent-rooms[\s\S]*bin\/rooms[\s\S]*relay/);

  b.ok(["agents", "remove", "Hermes"]);
  b.say("Armin", "Is Hermes still woken?");
  b.relay();
  assert.deepEqual(names(b.runs()), ["Claude"], "an agent removed from this machine isn't woken here");
});

test("one relay per machine, and ensure starts it only when it isn't running", async () => {
  const b = box();
  b.ok(["vault", "add", b.vault]);
  const lock = join(b.config, "relay.lock");
  // Left by a relay that died, as after a restart: a process number that's gone, and one that isn't a relay.
  writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 - 1, beat: Date.now() }));
  assert.match(b.ok(["relay", "status"]).out, /Relay: not running/);
  writeFileSync(lock, JSON.stringify({ pid: process.pid, beat: Date.now() - 3_600_000 }));
  assert.match(b.ok(["relay", "status"]).out, /Relay: not running/, "a stale lock naming a process that isn't a relay");

  let pid;
  try {
    const started = b.ok(["relay", "ensure"]).out;
    assert.match(started, /wasn't running; it runs in the background again \(process \d+\)/);
    pid = Number(started.match(/process (\d+)/)[1]);
    assert.match(b.ok(["relay", "ensure"]).out, new RegExp(`The relay is running \\(process ${pid}\\)`));
    assert.match(b.ok(["relay", "--once"]).out, new RegExp(`already running on this machine \\(process ${pid}\\); this one stops`));
    assert.match(b.ok(["relay", "status"]).out, /Relay: running \(process \d+\), in the background until this machine restarts/);
    assert.match(b.rooms(["doctor"]).out, /ok {3}The relay runs in the background/);
    assert.match(b.ok(["relay", "uninstall"]).out, /The relay is stopped/);
    assert.ok(!existsSync(lock), "a relay that stops removes its lock");
    assert.match(b.rooms(["doctor"]).out, /FIX {2}The relay isn't running: rooms relay install/);
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

test("a room's manual and its members' roles reach every agent woken there", () => {
  const b = scene();
  writeFileSync(join(b.room, "ROOM.md"), "---\ntitle: Launch\ndescription: Getting 1.0 out\n---\n# Launch\n\n%% For the person only. %%\n\n" +
    "Claude ships; Hermes checks the docs. Nothing else belongs here.\n");
  b.ok(["role", "Launch", "claude", "Writes the code"]);
  assert.match(b.ok(["role", "Launch", "Claude"]).out, /Claude in Launch: Writes the code/);
  assert.match(b.ok(["members", "Launch"]).out, /Claude {2}· {2}agent {2}· {2}Writes the code\n/);
  b.ok(["join", "Launch", "--role", "Reviews"], { as: "Codex" });
  assert.match(readFileSync(join(b.room, "members", "codex.md"), "utf8"), /kind: agent\nrole: Reviews\n/);

  b.say("Armin", "Status?");
  b.relay();
  const text = prompt(b.runs().find((run) => run.name === "Claude"));
  assert.match(text, new RegExp("You are \"Claude\" there\\.\n\nWhat the room is for: Getting 1\\.0 out\nIts manual, from .*ROOM\\.md:\n\n" +
    "Claude ships; Hermes checks the docs\\. Nothing else belongs here\\.\n\nMembers, and what each does here:\n- Armin \\(person\\)\n" +
    "- Claude \\(agent, you\\): Writes the code\n- Codex \\(agent\\): Reviews\n- Hermes \\(agent\\)\n\nThe new messages:\n"));
  assert.doesNotMatch(text, /For the person only/);
  assert.match(text, /- Keep to what this room is for, and to your part in it\./);

  const refused = b.rooms(["role", "Launch", "Claude", "Runs everything"], { extraEnv: { AGENT_ROOMS_RELAY: "1" } });
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, /is for the room's person, not a woken agent/);
  assert.match(b.rooms(["join", "Launch", "--role", "Boss"], { as: "Intruder", extraEnv: { AGENT_ROOMS_RELAY: "1" } }).err, /--role is for the room's person/);
  b.ok(["role", "Launch", "Claude", "--clear"]);
  assert.match(b.ok(["role", "Launch", "Claude"]).out, /Claude has no role in Launch yet/);
  assert.match(b.rooms(["role", "Launch", "Nobody", "Anything"]).err, /Nobody isn't a member of Launch/);

  assert.match(b.ok(["about", "Launch"]).out, /^Launch\n\nWhat the room is for: Getting 1\.0 out\nIts manual[\s\S]*- Hermes \(agent\)\n$/);
  assert.match(b.ok(["read", "Launch"], { as: "Newcomer" }).out, /^What the room is for: Getting 1\.0 out[\s\S]*Members[\s\S]*\n\nLaunch: (all|\d+) of/, "a first read starts with the manual");
  assert.doesNotMatch(b.ok(["read", "Launch"], { as: "Newcomer" }).out, /What the room is for/, "only the first");
  rmSync(join(b.room, "ROOM.md"));
  assert.match(b.ok(["about", "Launch"]).out, /It has no manual yet\. Its person writes one in .*ROOM\.md, below the title\./);
});
