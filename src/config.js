// What this machine knows that never syncs: its vaults, the agents that live here, the people whose keys it
// trusts, and what each reader has read. Kept outside the vaults, so Obsidian Sync never carries it.
// The relay alone writes relay.json; each reader's place is its own file, so two writers never share one.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { slug } from "./format.js";

export const configDir = () =>
  process.env.AGENT_ROOMS_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agent-rooms");

export function readJson(name, fallback) {
  try {
    return JSON.parse(readFileSync(join(configDir(), name), "utf8"));
  } catch {
    return fallback;
  }
}

/** Writes through a temporary file, so a reader never sees half of it. */
export function writeJson(name, value) {
  mkdirSync(configDir(), { recursive: true });
  const temp = join(configDir(), `.${name}.${process.pid}.tmp`);
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, join(configDir(), name));
}

/** Wakes per agent an hour and a day; agent messages in a row before a room pauses; how old a message may be. */
export const DEFAULT_LIMITS = { perHour: 20, perDay: 100, brakeAfter: 30, maxAgeHours: 24 };

/**
 * @typedef {object} Agent
 * @property {string} kind    which module starts it: claude-code, hermes, …
 * @property {string} name    its name in rooms
 * @property {string} folder  where it starts: a project, or a vault
 * @property {"scoped" | "full"} trust  what a woken run may do without asking
 * @property {boolean} wake
 */

export function loadConfig() {
  const saved = readJson("config.json", {});
  return {
    machine: saved.machine || hostname().replace(/\.(local|lan)$/, ""),
    /** @type {{ name: string, path: string }[]} */
    vaults: saved.vaults || [],
    /** @type {Agent[]} */
    agents: saved.agents || [],
    /** @type {Record<string, string[]>} a person's name to the public keys this machine trusts for it */
    people: saved.people || {},
    limits: { ...DEFAULT_LIMITS, ...saved.limits },
  };
}

export const saveConfig = (config) => writeJson("config.json", config);

/** A reader's places: for each room, what they've read. */
export const loadPlaces = (reader) => readJson(`reader-${slug(reader)}.json`, {});
export const savePlaces = (reader, places) => writeJson(`reader-${slug(reader)}.json`, places);
