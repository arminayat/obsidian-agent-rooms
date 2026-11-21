// OpenClaw and Grok Bot, which nobody has run for real: what this program sends them, against a stand-in
// `openclaw` and a local HTTP server playing the routine's webhook.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { names, prompt, roomsAsync, scene } from "./helpers.js";

test("OpenClaw is woken with a turn through its Gateway, in a session per room", () => {
  const b = scene();
  assert.match(b.rooms(["setup", "openclaw"]).err, /No OpenClaw home/);
  mkdirSync(join(b.root, "openclaw"));
  b.ok(["setup", "openclaw", "--join", "Launch"]);
  b.ok(["setup", "openclaw", "ops", "--join", "Launch"]);
  const workspace = join(b.root, "openclaw", "workspace");
  assert.ok(existsSync(join(workspace, "skills", "agent-rooms", "SKILL.md")), "the skill in the agent's own workspace");
  assert.ok(existsSync(join(b.root, "openclaw", "workspace-ops", "skills", "agent-rooms", "SKILL.md")));
  b.relay();
  b.runs();

  b.say("Armin", "OpenClaw, what's on today?", ["--to", "OpenClaw"]);
  b.relay();
  const [run] = b.runs();
  assert.equal(run.name, "OpenClaw");
  assert.equal(run.cwd, workspace);
  const file = run.args[run.args.indexOf("--message-file") + 1];
  assert.deepEqual(run.args, ["agent", "--agent", "main", "--session-key", "rooms-launch", "--message-file", file, "--json", "--timeout", "1800"]);
  assert.match(prompt(run), /You are "OpenClaw" there\.[\s\S]*what's on today\?/);
  assert.ok(!existsSync(file), "the message file is gone once the turn ends");

  b.say("Armin", "Ops, you too.", ["--to", "Ops"]);
  b.relay();
  assert.equal(b.runs()[0].args[2], "ops");

  b.behave({ OpenClaw: { fail: "Error: connect ECONNREFUSED 127.0.0.1:18789" } });
  b.say("Armin", "Still there?", ["--to", "OpenClaw"]);
  for (let i = 0; i < 3; i++) b.relay();
  assert.match(b.messages().at(-1).body, /Couldn't wake OpenClaw .*: OpenClaw's Gateway isn't running on this machine/);
});

/** A routine's webhook: answers with `status`, and keeps what it was sent. */
async function routine(status = 200) {
  const got = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      got.push({ auth: request.headers.authorization, type: request.headers["content-type"], body: JSON.parse(body) });
      response.writeHead(server.status).end(server.status === 200 ? "{}" : "nope");
    });
  });
  server.status = status;
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  return { server, got, url: `http://127.0.0.1:${server.address().port}/routine` };
}

test("a Grok Bot is woken by posting to its routine, with its key kept off the vault", async () => {
  const b = scene();
  const hook = await routine();
  try {
    const folder = join(b.root, "workspace");
    assert.match(b.rooms(["setup", "grok-bot", "--name", "Grok", "--url", "http://example.com/x", "--key", "k"]).err, /starting with https:\/\//);
    const out = b.ok(["setup", "grok-bot", "--name", "Grok", "--url", hook.url, "--key", "secret-123", "--folder", folder, "--join", "Launch"]).out;
    assert.match(out, /The routine's instruction[\s\S]*for you as "Grok"[\s\S]*"Always allow" rule/);
    b.ok(["setup", "grok-bot", "--name", "Grok Two", "--url", `${hook.url}/2`, "--key", "other", "--folder", folder]);
    assert.match(b.ok(["agents"]).out, /Grok {2}·[\s\S]*Grok Two {2}·/, "two Bots on one computer don't replace each other");
    assert.doesNotMatch(readFileSync(join(b.config, "config.json"), "utf8"), /secret-123/, "the key isn't in the settings");
    const secret = join(b.config, "secrets", "grok-bot-grok.json");
    assert.equal(statSync(secret).mode & 0o777, 0o600);
    assert.ok(existsSync(join(folder, "agent-rooms-skill", "SKILL.md")));

    assert.equal((await roomsAsync(b, ["relay", "--once"])).code, 0);
    b.say("Armin", "Grok, any news from X today?", ["--to", "Grok"]);
    const relayed = await roomsAsync(b, ["relay", "--once"]);
    assert.match(relayed.out, /posted to Grok's routine: 200/);
    assert.equal(hook.got.length, 1);
    const [sent] = hook.got;
    assert.equal(sent.auth, "Bearer secret-123");
    assert.equal(sent.type, "application/json");
    assert.deepEqual([sent.body.source, sent.body.room, sent.body.you, sent.body.addressed, sent.body.vault], ["agent-rooms", "Launch", "Grok", true, b.vault]);
    assert.match(sent.body.text, /any news from X today\?[\s\S]*\/bin\/rooms say "Launch" "<your message>" --vault ".*" --as "Grok"/);

    hook.server.status = 429;
    b.say("Armin", "Again?", ["--to", "Grok"]);
    for (let i = 0; i < 3; i++) await roomsAsync(b, ["relay", "--once"]);
    assert.doesNotMatch(b.messages().at(-1).body, /Couldn't wake/, "an hourly limit is waited out, not reported");
    hook.server.status = 401;
    for (let i = 0; i < 3; i++) await roomsAsync(b, ["relay", "--once"]);
    assert.match(b.messages().at(-1).body, /Couldn't wake Grok .*refused its key/);
    assert.match(b.rooms(["doctor"]).out, /ok {3}Grok: Grok Bot is set up/);
  } finally {
    hook.server.close();
  }
});
