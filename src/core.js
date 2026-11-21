// What every command shares: failing with a plain sentence, reading flags, and working out which vault and
// which reader a command is for.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { configDir } from "./config.js";
import { sameName, slug } from "./format.js";
import { newKeyPair, sign } from "./sign.js";

export class Failure extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

/** Stops the command with a sentence for the person or agent who ran it. */
export const fail = (message, code = 1) => {
  throw new Failure(message, code);
};

/** A path as people write it: `~` for the home folder. */
export const shown = (path) => (path === homedir() || path.startsWith(homedir() + sep) ? "~" + path.slice(homedir().length) : path);

const SWITCHES = new Set(["json", "anyway", "all", "person", "once", "dry-run", "help", "no-wake", "intro", "version", "no-skill", "no-sign"]);

/** Splits the command line into words and flags. A flag given twice becomes a list. */
export function parseArgs(argv) {
  const args = [];
  /** @type {Record<string, any>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (!word.startsWith("--") || word === "--") {
      args.push(word);
      continue;
    }
    const [name, inline] = word.slice(2).split(/=(.*)/s);
    const value = inline !== undefined ? inline : SWITCHES.has(name) || argv[i + 1] === undefined || argv[i + 1].startsWith("--") ? true : argv[++i];
    flags[name] = name in flags ? [].concat(flags[name], value) : value;
  }
  return { args, flags };
}

/** A flag's values as one list: given twice, or separated by commas. */
export const listFlag = (value) => [].concat(value ?? []).filter((v) => typeof v === "string").flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const inside = (path, folder) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);

/** The agent set up for the folder a command runs in: the deepest one above it. */
export function agentHere(config) {
  const here = real(process.cwd());
  return config.agents.filter((agent) => inside(here, real(agent.folder))).sort((a, b) => b.folder.length - a.folder.length)[0] ?? null;
}

/**
 * The vault a command works in: --vault (a registered name, or a folder), the registered vault around the
 * current folder, or the only one registered.
 */
export function vaultFor(config, flags) {
  if (typeof flags.vault === "string") {
    const named = config.vaults.find((v) => v.name.toLowerCase() === flags.vault.toLowerCase());
    if (named) return named.path;
    if (existsSync(flags.vault)) return real(flags.vault);
    fail(`No vault called ${flags.vault} is registered here, and it isn't a folder. Registered: ${config.vaults.map((v) => v.name).join(", ") || "none"}.`);
  }
  const here = real(process.cwd());
  const around = config.vaults.find((v) => inside(here, real(v.path)));
  if (around) return around.path;
  if (config.vaults.length === 1) return config.vaults[0].path;
  fail(config.vaults.length
    ? `Which vault? Add --vault with one of: ${config.vaults.map((v) => v.name).join(", ")}.`
    : "No vault is registered on this machine. Register one with: rooms vault add <folder>");
}

/**
 * Who is reading and writing: --as, AGENT_ROOMS_NAME, or the agent set up for the current folder. It never
 * guesses beyond that: reading as someone else would mark their messages read.
 */
export function readerFor(config, flags) {
  if (typeof flags.as === "string" && flags.as.trim()) return flags.as.trim();
  const named = process.env.AGENT_ROOMS_NAME || agentHere(config)?.name;
  if (named) return named;
  fail('Say who you are: add --as "<your name in rooms>", or set AGENT_ROOMS_NAME.');
}

// --- A person's key on this machine, for posting from a terminal ------------------------------------------------
// The plugin signs on the person's own devices. This is the terminal's equivalent, meant for testing: any
// program running as this user could use the key, agents included.

const keyFile = (name) => join(configDir(), "keys", `${slug(name)}.json`);

export async function createKey(name) {
  if (existsSync(keyFile(name))) fail(`There's already a key for ${name} here. Show its public half with: rooms key show "${name}"`);
  const pair = await newKeyPair();
  mkdirSync(join(configDir(), "keys"), { recursive: true });
  writeFileSync(keyFile(name), JSON.stringify(pair, null, 2) + "\n", { mode: 0o600 });
  return pair.publicKey;
}

export function readKey(name) {
  try {
    return JSON.parse(readFileSync(keyFile(name), "utf8"));
  } catch {
    return null;
  }
}

/** A signer for this writer, if this machine holds their key. */
export function signerFor(name) {
  const pair = readKey(name);
  return pair ? (payload) => sign(pair.privateKey, payload) : undefined;
}

/** The public keys trusted for a name. */
export const keysFor = (config, name) => Object.entries(config.people).filter(([person]) => sameName(person, name)).flatMap(([, keys]) => keys);
