// What the end-to-end tests share: a machine in a box, in a temporary folder with its own home and settings, where
// test/stub-agent.mjs plays `claude`, `codex` and `hermes`.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MESSAGE_FILE, parseMessage } from "../src/format.js";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "..", "bin", "rooms");
const stub = join(here, "stub-agent.mjs");

/** A machine in a box: a vault, a project, a Hermes home, and settings of its own. */
export function box() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-rooms-")));
  const b = { root, home: join(root, "home"), config: join(root, "config"), vault: join(root, "Vault"), project: join(root, "api"), hermes: join(root, "hermes"), stub: join(root, "stub") };
  for (const dir of Object.values(b)) mkdirSync(dir, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: b.home, AGENT_ROOMS_HOME: b.config, AGENT_ROOMS_CLAUDE: stub, AGENT_ROOMS_CODEX: stub, AGENT_ROOMS_HERMES: stub, AGENT_ROOMS_OPENCLAW: stub, AGENT_ROOMS_OPENCLAW_HOME: join(root, "openclaw"), AGENT_ROOMS_HERMES_HOME: b.hermes, STUB_DIR: b.stub, AGENT_ROOMS_RETRY_SECONDS: "0" };
  writeFileSync(join(b.config, "config.json"), JSON.stringify({ machine: "testbox" }));
  b.env = env;
  b.rooms = (args, { as, cwd = root, extraEnv = {} } = {}) => {
    const result = spawnSync(process.execPath, [bin, ...args, ...(as ? ["--as", as] : [])], { env: { ...env, ...extraEnv }, cwd, encoding: "utf8" });
    return { code: result.status, out: result.stdout, err: result.stderr, all: result.stdout + result.stderr };
  };
  b.ok = (args, options) => {
    const result = b.rooms(args, options);
    assert.equal(result.code, 0, `rooms ${args.join(" ")}\n${result.all}`);
    return result;
  };
  /** Posts without the read-first check, which has its own test. Returns the message's file name. */
  b.say = (as, text, extra = []) => b.ok(["say", "Launch", text, "--anyway", ...extra], { as }).out.match(/Posted to Launch: \S+\/(\S+)/)[1];
  b.relay = () => b.ok(["relay", "--once"]).out;
  /** How the stand-ins were started since the last call. */
  b.runs = () => {
    const file = join(b.stub, "runs.jsonl");
    const runs = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    rmSync(file, { force: true });
    return runs;
  };
  b.behave = (behaviour) => writeFileSync(join(b.stub, "behaviour.json"), JSON.stringify(behaviour));
  b.settings = (change) => {
    const file = join(b.config, "config.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...change }));
  };
  b.room = join(b.vault, "Rooms", "Launch");
  b.messages = () => readdirSync(b.room).filter((d) => /^\d{4}-/.test(d)).sort().flatMap((day) => readdirSync(join(b.room, day)).filter((f) => MESSAGE_FILE.test(f)).sort()
    .map((file) => parseMessage(readFileSync(join(b.room, day, file), "utf8"), file)));
  return b;
}

/** A room with a person whose key this machine trusts, a Claude Code agent and a Hermes Bot; the relay has looked once. */
export function scene() {
  const b = box();
  b.ok(["vault", "add", b.vault]);
  b.ok(["create", "Launch", "--about", "Getting 1.0 out"]);
  const key = b.ok(["key", "new", "Armin"]).out.split("\n").find((line) => /^[A-Za-z0-9_-]{80,100}$/.test(line));
  b.ok(["trust", "Armin", key]);
  b.ok(["join", "Launch", "--person"], { as: "Armin" });
  b.ok(["setup", "claude-code", b.project, "--name", "Claude", "--join", "Launch"]);
  b.ok(["setup", "hermes", "--join", "Launch"]);
  b.relay();
  assert.deepEqual(b.runs(), []);
  return b;
}

export const names = (runs) => runs.map((run) => run.name).sort();
export const prompt = (run) => (run.args.includes("-p") ? run.args[run.args.indexOf("-p") + 1] : run.args[0] === "exec" ? run.args.at(-1) : run.stdin);

/** Runs `rooms` without blocking this process, for tests that serve HTTP to the relay. */
export function roomsAsync(b, args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [bin, ...args], { env: b.env, cwd: b.root });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("exit", (code) => done({ code, out }));
  });
}

