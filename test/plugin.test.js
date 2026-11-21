// The plugin's store against the `rooms` command's own reading of the same files: what one writes, the other
// reads the same way, and a message signed in the plugin wakes agents through the relay. The store runs here over
// a file system adapter shaped like Obsidian's; nothing touches a real vault or a real agent.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RoomStore, shownText } from "../plugin/store.js";
import { senderKind, targets } from "../src/policy.js";
import { newKeyPair, sign } from "../src/sign.js";
import { isPaused, members, messageFiles, post, readMessage } from "../src/vault.js";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "..", "bin", "rooms");
const stub = join(here, "stub-agent.mjs");

/** Obsidian's DataAdapter, as far as the store uses it: vault-relative paths with `/`. */
function adapterFor(vault) {
  const at = (path) => join(vault, ...path.split("/"));
  return {
    exists: async (path) => existsSync(at(path)),
    list: async (path) => {
      const entries = readdirSync(at(path), { withFileTypes: true });
      return { files: entries.filter((e) => e.isFile()).map((e) => `${path}/${e.name}`), folders: entries.filter((e) => e.isDirectory()).map((e) => `${path}/${e.name}`) };
    },
    read: async (path) => readFileSync(at(path), "utf8"),
    write: async (path, data) => writeFileSync(at(path), data),
    mkdir: async (path) => mkdirSync(at(path)), // not recursive, like some adapters: the store makes parents itself
    rename: async (from, to) => renameSync(at(from), at(to)),
    remove: async (path) => rmSync(at(path)),
  };
}

function box() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-rooms-plugin-")));
  const b = { root, vault: join(root, "Vault"), config: join(root, "config"), home: join(root, "home"), project: join(root, "api"), stub: join(root, "stub") };
  for (const dir of [b.vault, b.config, b.home, b.project, b.stub]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(b.config, "config.json"), JSON.stringify({ machine: "testbox" }));
  const env = { PATH: process.env.PATH, HOME: b.home, AGENT_ROOMS_HOME: b.config, AGENT_ROOMS_CLAUDE: stub, STUB_DIR: b.stub };
  b.rooms = (args) => {
    const result = spawnSync(process.execPath, [bin, ...args], { env, cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, `rooms ${args.join(" ")}\n${result.stdout}${result.stderr}`);
    return result.stdout;
  };
  b.runs = () => {
    const file = join(b.stub, "runs.jsonl");
    const runs = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    rmSync(file, { force: true });
    return runs;
  };
  b.store = new RoomStore(adapterFor(b.vault));
  return b;
}

test("what the plugin writes, the rooms command reads the same way", async () => {
  const b = box();
  const { store } = b;
  const room = await store.createRoom("Launch: 1.0", "Getting 1.0 out");
  assert.equal(room, "Launch 1.0", "characters a folder can't have are dropped");
  await assert.rejects(store.createRoom("launch 1.0"), /already a room called Launch 1\.0/);
  assert.deepEqual(await store.rooms(), ["Launch 1.0"]);
  assert.deepEqual(await store.about(room), { title: "Launch: 1.0", description: "Getting 1.0 out" });

  assert.equal(await store.addMember(room, { name: "Armin", kind: "person" }), true);
  assert.equal(await store.addMember(room, { name: "Claude", kind: "agent", addedBy: "Armin" }), true);
  assert.equal(await store.addMember(room, { name: "claude", kind: "agent" }), false, "names match across spelling");
  assert.deepEqual(members(b.vault, room).map((m) => [m.name, m.kind]), [["Armin", "person"], ["Claude", "agent"]]);

  const pair = await newKeyPair();
  const signer = (payload) => sign(pair.privateKey, payload);
  const first = await store.post(room, { from: "Armin", to: ["Claude"] }, "Where are we?\r\nWith 1.0.", signer);
  const reply = await store.post(room, { from: "Claude", re: first.file, seen: first.file }, "Green.");
  assert.deepEqual(messageFiles(b.vault, room), [first.path, reply.path]);
  assert.ok(reply.file > first.file, "a reply sorts after what it answers");

  const read = readMessage(b.vault, room, first.path);
  assert.equal(read.body, "Where are we?\r\nWith 1.0.", "the text is kept as typed; the signature reads past line endings");
  assert.deepEqual(read.to, ["Claude"]);
  const roomMembers = members(b.vault, room);
  assert.equal(await senderKind({ Armin: [pair.publicKey] }, room, roomMembers, read), "person", "the plugin's signature verifies where the relay checks it");
  assert.equal(await senderKind({ Armin: [(await newKeyPair()).publicKey] }, room, roomMembers, read), "unverified");
  assert.equal(await senderKind({ Armin: [pair.publicKey] }, "Elsewhere", roomMembers, read), "unverified", "a signature belongs to its room");
  assert.equal(readMessage(b.vault, room, reply.path).re, first.file);
  assert.deepEqual(readdirSync(join(b.vault, "Rooms", room, first.path.split("/")[0])).filter((f) => f.startsWith(".")), [], "no temporary file is left");

  await store.pause(room, "Armin");
  assert.equal(isPaused(b.vault, room), true);
  assert.equal(await store.roomPaused(room), true);
  await store.resume(room);
  assert.equal(isPaused(b.vault, room), false);
  await store.pause(null, "Armin");
  assert.equal(isPaused(b.vault, room), true);
  assert.equal(await store.vaultPaused(), true);
  await store.resume(null);
  assert.equal(isPaused(b.vault, room), false);

  assert.equal(await store.removeMember(room, "CLAUDE"), true);
  assert.deepEqual(members(b.vault, room).map((m) => m.name), ["Armin"]);
});

test("what the rooms command writes, the plugin reads the same way", async () => {
  const b = box();
  b.rooms(["vault", "add", b.vault]);
  b.rooms(["create", "Launch", "--about", "Getting 1.0 out"]);
  b.rooms(["join", "Launch", "--as", "Hermes"]);
  const a = await post(b.vault, "Launch", { from: "Hermes", to: ["Claude Code in api"] }, "Done: **the build**.");
  const c = await post(b.vault, "Launch", { from: "Relay on testbox", notice: true }, "Couldn't wake someone.");
  const { store } = b;
  assert.deepEqual(await store.messagePaths("Launch"), [a.path, c.path]);
  const [first, second] = await store.messages("Launch", [a.path, c.path]);
  assert.equal(first.body, "Done: **the build**.");
  assert.deepEqual(first.to, ["Claude Code in api"]);
  assert.equal(second.notice, true);
  assert.deepEqual((await store.members("Launch")).map((m) => [m.name, m.kind]), [["Hermes", "agent"]]);

  // A half-written message (no front matter yet) and stray files are left out, as the relay does.
  writeFileSync(join(b.vault, "Rooms", "Launch", a.path.split("/")[0], "2026-01-01T00-00-00.000Z_x_abcd.md"), "");
  writeFileSync(join(b.vault, "Rooms", "Launch", "notes.md"), "not a message");
  mkdirSync(join(b.vault, "Rooms", "_status"), { recursive: true });
  writeFileSync(join(b.vault, "Rooms", "_status", "testbox.md"), '---\nmachine: "testbox"\nrelay: 0.1.0\nupdated: 2026-11-21T10:00:00.000Z\n---\n# Relay on testbox\n\nNo agent on this machine is a member of a room here.\n');
  assert.equal((await store.messages("Launch", await store.messagePaths("Launch"))).length, 2);
  assert.deepEqual(await store.rooms(), ["Launch"], "_status isn't a room");
  const [relay] = await store.relays();
  assert.equal(relay.machine, "testbox");
  assert.equal(relay.updated, Date.parse("2026-11-21T10:00:00.000Z"));
  assert.match(relay.body, /No agent on this machine/);
});

test("a message signed in the plugin wakes agents through the relay", async () => {
  const b = box();
  const { store } = b;
  const pair = await newKeyPair();
  b.rooms(["vault", "add", b.vault]);
  const room = await store.createRoom("Launch");
  await store.addMember(room, { name: "Armin", kind: "person" });
  b.rooms(["trust", "Armin", pair.publicKey]);
  b.rooms(["setup", "claude-code", b.project, "--name", "Claude", "--join", "Launch", "--no-skill"]);
  b.rooms(["setup", "claude-code", join(b.root, "home"), "--name", "Other", "--join", "Launch", "--no-skill"]);
  b.rooms(["relay", "--once"]);
  assert.deepEqual(b.runs(), []);

  const roomMembers = await store.members(room);
  const whole = { from: "Armin", to: [], re: "", notice: false };
  assert.deepEqual(targets({ message: whole, kind: "person", roomMembers, authorOf: () => "" }).map((m) => m.name), ["Claude", "Other"], "what the composer says it wakes");

  await store.post(room, { from: "Armin" }, "Everyone: status?", (payload) => sign(pair.privateKey, payload));
  b.rooms(["relay", "--once"]);
  assert.deepEqual(b.runs().map((run) => run.name).sort(), ["Claude", "Other"]);

  await store.post(room, { from: "Armin", to: ["Other"] }, "Only you.", (payload) => sign(pair.privateKey, payload));
  b.rooms(["relay", "--once"]);
  assert.deepEqual(b.runs().map((run) => run.name), ["Other"]);

  await store.post(room, { from: "Armin" }, "Unsigned, so it counts as an agent's and wakes nobody.");
  b.rooms(["relay", "--once"]);
  assert.deepEqual(b.runs(), []);
});

test("angle brackets show as written, except inside code", () => {
  assert.equal(shownText('rooms say "Test" "<message>"'), 'rooms say "Test" "&lt;message>"');
  assert.equal(shownText("keep `<b>` and\n```\n<div>\n```\nbut not <b>"), "keep `<b>` and\n```\n<div>\n```\nbut not &lt;b>");
  assert.equal(shownText("an open fence ```\n<x>"), "an open fence ```\n<x>");
});
