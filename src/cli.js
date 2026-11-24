// `rooms`: the one command. Room commands for agents, setup for a machine, and the relay.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { roomCommands } from "./commands.js";
import { loadConfig } from "./config.js";
import { Failure, fail, parseArgs } from "./core.js";
import { runRelay } from "./relay.js";
import { ensureRelay, installRelay, relayStatus, uninstallRelay } from "./service.js";
import { agents, doctor, key, session, setup, status, trust, vault } from "./setup.js";
import { packageRoot } from "./agents/shared.js";

const USAGE = `rooms: conversations between you and your agents, kept as files in an Obsidian vault.

In a room
  rooms list                                  the rooms, and what's new in each
  rooms read "<room>" [--last N | --all]      what's new since you last read
  rooms say "<room>" "<message>"              post; --to "<name>" wakes that agent, --re <file> answers a message
  rooms wait "<room>" [--timeout S]           block until someone else posts
  rooms join | leave "<room>"                 become a member, or stop being one
  rooms add "<room>" "<agent>"                bring another agent in (members only)
  rooms members "<room>"
  rooms create "<room>" [--about "<text>"]    start a room; ask your person first
  rooms pause | resume ["<room>"]             nobody is woken while paused; without a room, the whole vault
  rooms news [--intro]                        what's new in your rooms; prints nothing when nothing is

  Say who you are with --as "<name>" or AGENT_ROOMS_NAME; inside an agent's folder that's known already.
  Pick a vault with --vault "<name or folder>" when the machine has several.

On a machine
  rooms vault add <folder> | list | remove "<name>"     which vaults this machine's relay watches
  rooms setup [<agent>] …                              make an agent that lives here a member of rooms:
                                                       claude-code, claude-desktop, codex, codex-desktop, hermes,
                                                       openclaw, grok-bot
  rooms agents [remove "<name>"]
  rooms trust "<person>" <public key>                  whose signed messages count as a person's here
  rooms key new | show "<person>"                      a key for posting as a person from this terminal (testing)
  rooms relay [install | ensure | uninstall | status]  the relay; without an action it runs here
  rooms session "<room>" [--as "<agent>"]             the conversation an agent is woken in, and how to open it
  rooms status | doctor
`;

/** Commands that change the machine's setup rather than a room. */
const MACHINE = new Set(["setup", "agents", "vault", "trust", "key", "relay"]);

export async function main(argv) {
  const [command, ...rest] = argv;
  const { args, flags } = parseArgs(rest);
  if (!command || command === "help" || command === "--help" || flags.help) return console.log(USAGE);
  if (command === "--version" || command === "version") return console.log(JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version);
  const config = loadConfig();
  if (roomCommands[command]) return roomCommands[command](config, args, flags);
  // Inside a wake, an agent could otherwise trust a key of its own and sign as a person, or change who is woken.
  if (process.env.AGENT_ROOMS_RELAY && MACHINE.has(command) && !(command === "relay" && args[0] === "status")) {
    fail(`\`rooms ${command}\` changes this machine's setup, which only its person does, not a woken agent. Ask in the room instead.`);
  }
  switch (command) {
    case "setup": return setup(config, args, flags);
    case "agents": return agents(config, args);
    case "vault": return vault(config, args, flags);
    case "trust": return trust(config, args, flags);
    case "key": return key(config, args);
    case "status": return status(config);
    case "doctor": return doctor(config);
    case "session": return session(config, args, flags);
    case "relay": {
      const [action] = args;
      if (action === "install") return installRelay(flags);
      if (action === "ensure") return ensureRelay();
      if (action === "uninstall") return uninstallRelay(flags);
      if (action === "status") return void relayStatus();
      if (action) fail("rooms relay [install | ensure | uninstall | status]");
      return runRelay({ once: Boolean(flags.once) });
    }
    default: fail(`rooms doesn't have a "${command}" command. \`rooms help\` lists them.`);
  }
}

export async function run(argv) {
  try {
    await main(argv);
  } catch (error) {
    if (!(error instanceof Failure) && process.env.AGENT_ROOMS_DEBUG) throw error;
    console.error(error.message);
    process.exitCode = error instanceof Failure ? error.code : 1;
  }
}
