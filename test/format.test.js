// The parts with no files in them: the message format, signatures, who a message wakes, and the prompt that
// connects an agent.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MESSAGE_FILE, dayOf, messageFileName, messageText, parseFile, parseMember, parseMessage, sameName, signedText, slug, timeOf } from "../src/format.js";
import { CONNECT_KINDS, connectPrompt, routineInstruction } from "../src/connect.js";
import { braked, overLimit, senderKind, targets } from "../src/policy.js";
import { newKeyPair, sign, verify } from "../src/sign.js";

const message = (fields) => ({ file: "2026-11-21T10-00-00.000Z_x_abcd.md", from: "", at: "2026-11-21T10:00:00.000Z", to: [], seen: "", re: "", sig: "", notice: false, body: "hi", ...fields });

test("a message survives being written and read back", () => {
  const at = new Date("2026-11-21T19:31:40.002Z");
  const file = messageFileName(at, "Claude Code in api", "q9x2");
  assert.equal(file, "2026-11-21T19-31-40.002Z_claude-code-in-api_q9x2.md");
  assert.match(file, MESSAGE_FILE);
  assert.equal(dayOf(file), "2026-11-21");
  const text = messageText({ from: "Claude Code in api", at: at.toISOString(), to: ["Codex", 'Dist "God"'], seen: "a.md", re: "b.md" }, "  Done.\n\nSee [[Deploys]].  ");
  const back = parseMessage(text, file);
  assert.deepEqual(back, { file, from: "Claude Code in api", at: "2026-11-21T19:31:40.002Z", to: ["Codex", 'Dist "God"'], seen: "a.md", re: "b.md", sig: "", notice: false, body: "Done.\n\nSee [[Deploys]]." });
  assert.equal(timeOf(back), at.getTime());
});

test("front matter is read the way Obsidian rewrites it", () => {
  const block = parseMessage("---\r\nfrom: \"true\"\r\nat: 2026-11-21T10:00:00.000Z\r\nto:\r\n  - Codex\r\n  - 'Dist God'\r\nre: x.md\r\n---\r\nBody\r\n", "f.md");
  assert.equal(block.from, "true");
  assert.deepEqual(block.to, ["Codex", "Dist God"]);
  assert.equal(block.re, "x.md");
  assert.equal(block.body, "Body");
  assert.deepEqual(parseMessage("---\nfrom: A\nto: [Codex, Dist God]\n---\nx", "f.md").to, ["Codex", "Dist God"]);
  assert.deepEqual(parseMessage("---\nfrom: A\nto: Codex\n---\nx", "f.md").to, ["Codex"]);
  assert.equal(parseFile("no front matter").hasFrontMatter, false);
  assert.equal(parseMessage("---\nat: 2026\n---\nx", "f.md").from, "", "a file without `from` isn't a whole message yet");
  assert.equal(timeOf(message({ at: "" })), Date.parse("2026-11-21T10:00:00.000Z"), "the file name says when, if `at` doesn't");
});

test("names match across spelling, and members default to agents", () => {
  assert.equal(slug("Claude Code (api)"), "claude-code-api");
  assert.equal(slug("Émile  Zola"), "emile-zola");
  assert.ok(sameName("Codex", "codex"));
  assert.ok(!sameName("Codex", "Codex 2"));
  assert.deepEqual(parseMember("---\nname: Armin\nkind: person\n---\n", "armin.md"), { name: "Armin", kind: "person", file: "armin.md" });
  assert.equal(parseMember("---\nname: X\n---\n", "x.md").kind, "agent");
  assert.equal(parseMember("---\nname: X\nkind: admin\n---\n", "x.md").kind, "agent");
  assert.equal(parseMember("", "claude-code.md").name, "claude-code");
});

test("a signature covers the room, the file name and the text", async () => {
  const pair = await newKeyPair();
  const m = message({ from: "Armin", to: ["Codex"], body: "Ship it." });
  const sig = await sign(pair.privateKey, signedText("Launch", m));
  assert.ok(await verify(pair.publicKey, signedText("Launch", m), sig));
  assert.ok(await verify(pair.publicKey, signedText("Launch", { ...m, body: "Ship it.\r\n" }), sig), "line endings and trailing space don't matter");
  assert.ok(!(await verify(pair.publicKey, signedText("Other", m), sig)), "copied into another room");
  assert.ok(!(await verify(pair.publicKey, signedText("Launch", { ...m, file: "2026-11-21T10-00-00.001Z_x_abcd.md" }), sig)), "copied under another name");
  assert.ok(!(await verify(pair.publicKey, signedText("Launch", { ...m, body: "Ship it now." }), sig)));
  assert.ok(!(await verify(pair.publicKey, signedText("Launch", { ...m, to: [] }), sig)));
  assert.ok(!(await verify((await newKeyPair()).publicKey, signedText("Launch", m), sig)), "someone else's key");
  assert.ok(!(await verify("not a key", signedText("Launch", m), sig)));
  assert.ok(!(await verify(pair.publicKey, signedText("Launch", m), "")));
});

test("a person is someone listed as one whose signature this machine trusts", async () => {
  const pair = await newKeyPair();
  const roomMembers = [{ name: "Armin", kind: "person" }, { name: "Codex", kind: "agent" }];
  const m = message({ from: "Armin" });
  const signed = { ...m, sig: await sign(pair.privateKey, signedText("Launch", m)) };
  assert.equal(await senderKind({ armin: [pair.publicKey] }, "Launch", roomMembers, signed), "person");
  assert.equal(await senderKind({}, "Launch", roomMembers, signed), "unverified", "no key trusted here");
  assert.equal(await senderKind({ Armin: [pair.publicKey] }, "Launch", roomMembers, m), "unverified", "no signature");
  assert.equal(await senderKind({ Armin: [pair.publicKey] }, "Launch", roomMembers, { ...signed, body: "changed" }), "unverified");
  assert.equal(await senderKind({ Armin: [pair.publicKey] }, "Launch", roomMembers, message({ from: "Codex" })), "agent");
  assert.equal(await senderKind({ Armin: [pair.publicKey] }, "Launch", [{ name: "Codex", kind: "agent" }], signed), "agent", "not listed as a person in this room");
});

test("who a message wakes", () => {
  const roomMembers = [{ name: "Armin", kind: "person" }, { name: "Claude", kind: "agent" }, { name: "Codex", kind: "agent" }, { name: "Dist God", kind: "agent" }];
  const authorOf = (file) => ({ "c.md": "Claude", "a.md": "Armin" })[file] ?? "";
  const woken = (fields, kind) => targets({ message: message(fields), kind, roomMembers, authorOf }).map((m) => m.name);
  assert.deepEqual(woken({ from: "Armin" }, "person"), ["Claude", "Codex", "Dist God"], "a person's message wakes every agent");
  assert.deepEqual(woken({ from: "Armin", to: ["codex"] }, "person"), ["Codex"], "or only those addressed");
  assert.deepEqual(woken({ from: "Claude" }, "agent"), [], "an agent's message wakes nobody by itself");
  assert.deepEqual(woken({ from: "Claude", to: ["Codex", "Dist God"] }, "agent"), ["Codex", "Dist God"]);
  assert.deepEqual(woken({ from: "Codex", re: "c.md" }, "agent"), ["Claude"], "a reply wakes the author");
  assert.deepEqual(woken({ from: "Claude", re: "c.md", to: ["Claude"] }, "agent"), [], "never the writer");
  assert.deepEqual(woken({ from: "Codex", re: "a.md", to: ["Armin", "Nobody"] }, "agent"), [], "people and non-members aren't woken");
  assert.deepEqual(woken({ from: "Armin" }, "unverified"), [], "an unverified person counts as an agent");
  assert.deepEqual(woken({ from: "Relay on mbp", notice: true, to: ["Codex"] }, "agent"), [], "a relay's notice wakes nobody");
});

test("the brake and the limits", () => {
  assert.ok(braked(["agent", "agent", "unverified"], 3));
  assert.ok(!braked(["agent", "agent"], 3), "not enough messages yet");
  assert.ok(!braked(["agent", "person", "agent", "agent"], 3), "a person among the last three");
  assert.ok(braked(["person", "agent", "agent", "agent"], 3));
  const now = 1_000_000_000_000;
  const limits = { perHour: 2, perDay: 3 };
  assert.equal(overLimit([now - 10, now - 20], limits, now), "2 wakes in the last hour");
  assert.equal(overLimit([now - 10, now - 4_000_000], limits, now), "");
  assert.equal(overLimit([now - 4_000_000, now - 5_000_000, now - 6_000_000], limits, now), "3 wakes in the last day");
});

test("one prompt connects an agent: your keys, the vault, the room, and the steps for its kind", () => {
  const keys = ["A".repeat(86), "B".repeat(86)];
  const claude = connectPrompt({ kind: "claude-code", room: "Launch", vault: "Team", folder: "/Users/me/vaults/Team", person: "Ada", keys });
  assert.match(claude, /vault "Team"/);
  assert.match(claude, /On my computer it's \/Users\/me\/vaults\/Team/);
  assert.match(claude, new RegExp(`rooms trust "Ada" ${"A".repeat(86)}\\n   rooms trust "Ada" ${"B".repeat(86)}`), "every key of the person's, from their device");
  assert.match(claude, /rooms setup claude-code <the project folder you work in> --join "Launch"/);
  assert.match(claude, /\d\. rooms relay install\n\d\. rooms doctor/);
  assert.doesNotMatch(claude, /routine|\/workspace/);

  const grok = connectPrompt({ kind: "grok-bot", name: "Scout", room: "Launch", vault: "Team", person: "Ada", keys: keys.slice(0, 1) });
  assert.match(grok, /R means `node \/workspace\/obsidian-agent-rooms\/bin\/rooms`/);
  assert.match(grok, /R setup grok-bot --name "Scout" --url <the address> --key - --join "Launch"/);
  assert.ok(grok.includes(routineInstruction("Scout")), "the routine's instruction, word for word");
  assert.match(grok, /every 2 hours[\s\S]*rooms relay ensure/, "a routine that restarts the relay after the computer restarts");
  assert.doesNotMatch(grok, /On my computer/, "a phone doesn't know the folder");

  const unnamed = connectPrompt({ kind: "hermes", vault: "Team", person: "Ada", keys: keys.slice(0, 1) });
  assert.match(unnamed, /rooms setup hermes <the Hermes profile this chat runs in, or default>\n/);
  assert.match(unnamed, /tell me your name in rooms, and I'll add you to one/);
  assert.match(unnamed, /no Claude login of its own, ask me which login to use/);
  assert.match(claude, /If `rooms` still isn't found, your terminal's PATH lacks it or Node\.js[\s\S]*run `<that node> ~\/\.local\/share\/obsidian-agent-rooms\/bin\/rooms`/);
  assert.match(connectPrompt({ kind: "openclaw", name: 'Say "hi" $HOME', vault: "Team", person: "Ada", keys }), /--name "Say \\"hi\\" \\\$HOME"/, "a name can't break out of its quotes");
  for (const kind of Object.keys(CONNECT_KINDS)) assert.match(connectPrompt({ kind, name: "X", vault: "Team", person: "Ada", keys }), /relay install[\s\S]*doctor/, kind);
});
