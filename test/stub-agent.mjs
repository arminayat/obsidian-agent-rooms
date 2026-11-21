#!/usr/bin/env node
// A stand-in for `claude` and `hermes` in tests: records how it was started, then does what the test's
// behaviour file says for the agent it was started as (fail, or post a reply with `rooms say`).

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.STUB_DIR;
const name = process.env.AGENT_ROOMS_NAME;
const args = process.argv.slice(2);
const stdin = args.includes("--query-file") ? readFileSync(0, "utf8") : "";
appendFileSync(join(dir, "runs.jsonl"), JSON.stringify({ name, args, cwd: process.cwd(), stdin, relay: process.env.AGENT_ROOMS_RELAY }) + "\n");

const file = join(dir, "behaviour.json");
const behaviour = (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {})[name] ?? {};
if (behaviour.fail) {
  console.error(behaviour.fail);
  process.exit(1);
}
if (behaviour.reply) {
  const { room, text, to = [], vault } = behaviour.reply;
  const said = spawnSync("rooms", ["say", room, text, "--vault", vault, ...to.flatMap((t) => ["--to", t])], { encoding: "utf8" });
  appendFileSync(join(dir, "replies.log"), `${name}: ${said.status} ${said.stdout}${said.stderr}\n`);
}
