// One relay per machine. Two would both wake an agent for the same message, so a relay holds a lock file while it
// runs and refreshes it every minute. `rooms relay ensure` reads the lock to tell a running relay from a dead one,
// which is what lets it run on a schedule where nothing else restarts the relay.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, writeJson } from "./config.js";

const BEAT_MS = 60_000;
const lockFile = () => join(configDir(), "relay.lock");

/** Whether a process is a relay, for a lock whose relay has been quiet: after a restart its number may be another's. */
function isRelay(pid) {
  let command;
  try {
    command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {
    command = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "";
  }
  return /rooms\s+relay(\s|$)/.test(command);
}

/** The relay running on this machine, or null: its lock names a live process that beat lately or is a relay. */
export function runningRelay() {
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockFile(), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    try {
      return Date.now() - statSync(lockFile()).mtimeMs < 5_000 ? { pid: 0 } : null; // being written this instant
    } catch {
      return null;
    }
  }
  if (!Number.isInteger(lock?.pid) || lock.pid <= 0) return null;
  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    if (error.code !== "EPERM") return null;
  }
  return Date.now() - (lock.beat ?? 0) < 3 * BEAT_MS || isRelay(lock.pid) ? lock : null;
}

/** Takes the lock for this process and keeps it fresh. Returns the relay that holds it instead, if one does. */
export function takeLock() {
  mkdirSync(configDir(), { recursive: true });
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, beat: Date.now() }), { flag: "wx", mode: 0o600 });
      const beat = setInterval(() => {
        if (readLockPid() === process.pid) writeJson("relay.lock", { pid: process.pid, beat: Date.now() });
      }, BEAT_MS);
      beat.unref();
      process.on("exit", releaseLock);
      for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(signal, () => process.exit(0));
      return null;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const other = runningRelay();
      if (other) return other;
      rmSync(lockFile(), { force: true }); // left by a relay that died
    }
  }
  return runningRelay() ?? { pid: 0 };
}

function readLockPid() {
  try {
    return JSON.parse(readFileSync(lockFile(), "utf8")).pid;
  } catch {
    return null;
  }
}

export function releaseLock() {
  if (readLockPid() === process.pid) rmSync(lockFile(), { force: true });
}
