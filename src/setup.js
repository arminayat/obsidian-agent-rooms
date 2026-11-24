// Setting a machine up: which vaults it watches, which agents live on it, whose keys it trusts; and looking at
// the result (`status`, `doctor`). `setup <agent>` asks nothing, so an agent can run it for itself from a pasted
// prompt; `setup` alone asks the same things one at a time, for a person at a terminal.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { readJson, saveConfig } from "./config.js";
import { createKey, fail, listFlag, readKey, shown, vaultFor } from "./core.js";
import { sameName } from "./format.js";
import { KINDS, moduleFor } from "./agents/index.js";
import { agentKey } from "./relay.js";
import { relayStatus } from "./service.js";
import { addMember, findRoom, isPaused, members, placeKey, roomNames, roomsDir } from "./vault.js";

const TRUST_NOTE = {
  scoped: "Woken runs are scoped: they may work in the agent's folder and the vault, within what that tool allows unattended.",
  full: "Woken runs have full access, with no permission checks: you chose to trust this agent.",
};

// --- Agents ------------------------------------------------------------------------------------------------

export async function setup(config, args, flags) {
  const [kind, ...rest] = args;
  if (!kind) return wizard(config, flags);
  const module = KINDS[kind] ?? fail(`rooms setup <agent>, where <agent> is one of: ${Object.keys(KINDS).join(", ")}.`);
  if (flags.trust !== undefined && !["scoped", "full"].includes(flags.trust)) fail("--trust is scoped (the default) or full.");
  const { agents, notes } = await module.setup({ args: rest, flags });
  for (const agent of agents) {
    agent.trust = flags.trust === "full" ? "full" : "scoped";
    agent.wake = !flags["no-wake"];
    const clash = config.agents.find((other) => sameName(other.name, agent.name) && !replaces(agent, other));
    if (clash) fail(`"${agent.name}" is already the name of another agent on this machine (${moduleFor(clash)?.label ?? clash.kind}, ${shown(clash.folder)}). Choose another with --name.`);
  }
  config.agents = [...config.agents.filter((other) => !agents.some((agent) => replaces(agent, other))), ...agents];
  saveConfig(config);

  const joined = [];
  const wanted = listFlag(flags.join);
  if (wanted.length) {
    const vault = vaultFor(config, flags);
    for (const name of wanted) {
      const room = findRoom(vault, name) ?? fail(`No room called ${name} in that vault, so nothing was joined. The agents are set up; join later with: rooms join "<room>" --as "<name>"`);
      for (const agent of agents) addMember(vault, room, { name: agent.name, kind: "agent" });
      joined.push(room);
    }
  }

  for (const agent of agents) console.log(`Set up ${module.label} as "${agent.name}", starting in ${shown(agent.folder)}.`);
  console.log(`- ${TRUST_NOTE[agents[0].trust]}`);
  for (const note of notes) console.log(`- ${note}`);
  console.log(joined.length ? `- Joined: ${joined.join(", ")}.` : `- Rooms: join one with \`rooms join "<room>" --as "<name>"\`, or have a member add the agent with \`rooms add\`.`);
  if (!config.vaults.length) console.log("- No vault is registered on this machine yet: rooms vault add <folder>");
  console.log(agents[0].wake ? "- Waking: the relay picks this up within a minute. If it isn't running: rooms relay install" : "- Waking: off for this agent (--no-wake).");
}

/** Whether setting up `agent` again replaces `other`: the same kind, and the same name or the same home. */
const replaces = (agent, other) =>
  agent.kind === other.kind && (sameName(agent.name, other.name) || (agent.folder === other.folder && (agent.profile ?? "") === (other.profile ?? "")));

async function wizard(config, flags) {
  if (!process.stdin.isTTY) fail(`rooms setup <agent> [options], where <agent> is one of: ${Object.keys(KINDS).join(", ")}.\n${Object.values(KINDS).map((m) => m.usage).join("\n")}`);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question, fallback = "") => (await prompt.question(fallback ? `${question} [${fallback}] ` : `${question} `)).trim() || fallback;
  try {
    console.log("Agents this machine can set up:");
    const kinds = Object.values(KINDS);
    kinds.forEach((m, i) => console.log(`  ${i + 1}. ${m.label}${m.found() ? "" : "  (its command isn't on the PATH here)"}`));
    const module = kinds[Number(await ask("Which one?", "1")) - 1] ?? fail("That isn't one of the numbers.");
    const args = [];
    const answers = { ...flags };
    if (module.ask === "folder") args.push(await ask("Its folder (a code project, or a vault):", process.cwd()));
    else if (module.ask === "profiles") args.push(...(await ask('Which Hermes profiles, separated by spaces ("default" is the one without a name):', "default")).split(/\s+/));
    else if (module.ask === "agent") args.push(await ask("Its OpenClaw agent id:", "main"));
    else {
      answers.name = await ask("The Bot's name in rooms:") || fail("A Bot needs a name in rooms.");
      answers.url = await ask('The routine\'s "POST to" address (ask the Bot to create a routine, then copy it from its details):');
      answers.key = await ask("The routine's key, from the same place:");
    }
    if (args.length === 1) {
      const name = await ask("Its name in rooms (empty for the usual one):");
      if (name) answers.name = name;
    }
    if (/^f/i.test(await ask("May its woken runs do anything without asking? scoped or full:", "scoped"))) answers.trust = "full";
    if (config.vaults.length) {
      const rooms = await ask(`Rooms to join now, separated by commas${config.vaults.length > 1 ? ` (in ${config.vaults[0].name}; --vault picks another)` : ""}:`);
      if (rooms) answers.join = rooms;
    }
    prompt.close();
    await setup(config, [module.kind, ...args], answers);
  } finally {
    prompt.close();
  }
}

export function agents(config, args) {
  const [action, ...rest] = args;
  if (action === "remove") {
    const name = rest.join(" ").trim() || fail('rooms agents remove "<name>"');
    const kept = config.agents.filter((agent) => !sameName(agent.name, name));
    if (kept.length === config.agents.length) fail(`No agent called ${name} is set up on this machine.`);
    config.agents = kept;
    saveConfig(config);
    return console.log(`${name} is no longer set up on this machine. Its skill copy and its member files in rooms stay; \`rooms leave\` removes those.`);
  }
  if (action) fail('rooms agents [remove "<name>"]');
  if (!config.agents.length) return console.log("No agents are set up on this machine. `rooms setup` adds one.");
  for (const agent of config.agents) console.log(`${agent.name}  ·  ${moduleFor(agent)?.label ?? agent.kind}  ·  ${shown(agent.folder)}  ·  ${agent.trust}${agent.wake === false ? "  ·  not woken" : ""}`);
}

/** The session or thread each agent here is woken in for a room, and how to open it: in a terminal or an app. */
export function session(config, args, flags) {
  const vault = vaultFor(config, flags);
  const name = args.join(" ").trim() || fail('rooms session "<room>" [--as "<agent>"]');
  const room = findRoom(vault, name) ?? fail(`No room called ${name}.`);
  const state = readJson("relay.json", { agents: {} });
  const chosen = typeof flags.as === "string" ? config.agents.filter((agent) => sameName(agent.name, flags.as)) : config.agents;
  let shownAny = false;
  for (const agent of chosen) {
    const id = state.agents?.[agentKey(agent)]?.rooms?.[placeKey(vault, room)]?.session?.id;
    if (!id) continue;
    shownAny = true;
    console.log(`${agent.name}: ${id}`);
    for (const line of moduleFor(agent)?.open?.(agent, id) ?? []) console.log(`  ${line}`);
  }
  if (!shownAny) console.log(`No agent on this machine has a session in ${room} yet; one starts at its first wake there.`);
}

// --- Vaults ------------------------------------------------------------------------------------------------

export function vault(config, args, flags) {
  const [action, ...rest] = args;
  if (action === "add") {
    const given = rest[0] || fail('rooms vault add <folder> [--name "<name>"]');
    if (!existsSync(given)) fail(`${given} doesn't exist.`);
    const path = realpathSync(resolve(given));
    const name = typeof flags.name === "string" && flags.name.trim() ? flags.name.trim() : basename(path);
    if (config.vaults.some((v) => v.path === path)) return console.log(`${shown(path)} is already registered, as ${config.vaults.find((v) => v.path === path).name}.`);
    if (config.vaults.some((v) => v.name.toLowerCase() === name.toLowerCase())) fail(`Another vault here is already called ${name}. Choose another with --name.`);
    mkdirSync(roomsDir(path), { recursive: true });
    config.vaults.push({ name, path });
    saveConfig(config);
    console.log(`Registered ${name} (${shown(path)}). This machine's relay now watches its Rooms folder.`);
    if (!existsSync(`${path}/.obsidian`)) console.log("It has no .obsidian folder, so it may not be an Obsidian vault; rooms work in any folder, but nothing syncs it for you.");
    return;
  }
  if (action === "remove") {
    const name = rest.join(" ").trim() || fail('rooms vault remove "<name>"');
    const kept = config.vaults.filter((v) => v.name.toLowerCase() !== name.toLowerCase());
    if (kept.length === config.vaults.length) fail(`No vault called ${name} is registered here.`);
    config.vaults = kept;
    saveConfig(config);
    return console.log(`${name} is no longer watched on this machine. Its files are untouched.`);
  }
  if (action && action !== "list") fail('rooms vault [add <folder> | remove "<name>" | list]');
  if (!config.vaults.length) return console.log("No vault is registered on this machine. rooms vault add <folder>");
  for (const v of config.vaults) console.log(`${v.name}  ·  ${shown(v.path)}  ·  ${roomNames(v.path).length} rooms`);
}

// --- People's keys ---------------------------------------------------------------------------------------------

export function trust(config, args, flags) {
  const [name, key] = args;
  if (!name) {
    const people = Object.entries(config.people).filter(([, keys]) => keys.length);
    if (!people.length) return console.log("No person's key is trusted here, so every message counts as an agent's. rooms trust \"<person>\" <public key>");
    for (const [person, keys] of people) console.log(`${person}  ·  ${keys.length} ${keys.length === 1 ? "key" : "keys"}`);
    return;
  }
  const existing = Object.keys(config.people).find((person) => sameName(person, name)) ?? name;
  if (flags.remove) {
    delete config.people[existing];
    saveConfig(config);
    return console.log(`No key is trusted for ${name} any more: their messages count as an agent's here.`);
  }
  if (!key || !/^[A-Za-z0-9_-]{80,100}$/.test(key)) fail('rooms trust "<person>" <public key>   (the key the plugin shows, or `rooms key show "<person>"`)');
  config.people[existing] = [...new Set([...(config.people[existing] ?? []), key])];
  saveConfig(config);
  console.log(`This machine now trusts that key for ${existing}: messages signed with it count as theirs.`);
}

export async function key(config, args) {
  const [action, ...rest] = args;
  const name = rest.join(" ").trim();
  if (!["new", "show"].includes(action) || !name) fail('rooms key new "<person>" | rooms key show "<person>"');
  const publicKey = action === "new" ? await createKey(name) : readKey(name)?.publicKey ?? fail(`This machine holds no key for ${name}. rooms key new "${name}"`);
  if (action === "new") console.log(`Made a key for ${name} on this machine. Any program running as you here can sign with it, so it's for testing; the plugin is where a person really signs.`);
  console.log(publicKey);
  if (action === "new") console.log(`Trust it on each machine that runs a relay: rooms trust "${name}" ${publicKey}`);
}

// --- Looking at the result ----------------------------------------------------------------------------------------

/** Whether a continuous Obsidian Headless sync is running for a vault, as far as the process list shows. */
function syncRunning(path) {
  const listing = spawnSync("ps", ["-Ao", "args="], { encoding: "utf8" });
  if (listing.status !== 0) return null;
  return listing.stdout.split("\n").some((line) => line.includes("--continuous") && line.includes("sync") && line.includes(path));
}

export function status(config) {
  console.log(`Machine: ${config.machine}`);
  console.log(config.vaults.length ? "Vaults:" : "Vaults: none registered (rooms vault add <folder>)");
  for (const v of config.vaults) {
    const rooms = roomNames(v.path);
    console.log(`  ${v.name} (${shown(v.path)}): ${rooms.length ? rooms.map((room) => `${room}${isPaused(v.path, room) ? " (paused)" : ""}`).join(", ") : "no rooms"}`);
  }
  console.log(config.agents.length ? "Agents:" : "Agents: none set up (rooms setup)");
  for (const agent of config.agents) {
    const rooms = config.vaults.flatMap((v) => roomNames(v.path).filter((room) => members(v.path, room).some((m) => sameName(m.name, agent.name))));
    console.log(`  ${agent.name} (${moduleFor(agent)?.label ?? agent.kind}, ${shown(agent.folder)}, ${agent.trust}): ${rooms.length ? `member of ${rooms.join(", ")}` : "in no room yet"}`);
  }
  const people = Object.entries(config.people).filter(([, keys]) => keys.length).map(([person]) => person);
  console.log(`People whose signed messages count as theirs here: ${people.join(", ") || "nobody"}`);
  relayStatus();
}

/** Checks the setup and says what to fix. Exit 1 when something is wrong. */
export function doctor(config) {
  const problems = [];
  const good = (line) => console.log(`ok   ${line}`);
  const bad = (line) => {
    problems.push(line);
    console.log(`FIX  ${line}`);
  };
  Number(process.versions.node.split(".")[0]) >= 22 ? good(`Node.js ${process.versions.node}`) : bad(`Node.js ${process.versions.node}: 22 or later is needed.`);
  if (!config.vaults.length) bad("No vault is registered: rooms vault add <folder>");
  for (const v of config.vaults) {
    if (!existsSync(v.path)) {
      bad(`${v.name}: its folder ${shown(v.path)} is gone.`);
      continue;
    }
    const sync = syncRunning(v.path);
    if (sync) good(`${v.name}: a continuous sync is running for ${shown(v.path)}`);
    else bad(`${v.name}: no \`ob sync --continuous\` was found for ${shown(v.path)}. Without it, messages neither arrive nor leave, and nothing says so.`);
  }
  if (!config.agents.length) bad("No agent is set up: rooms setup");
  for (const agent of config.agents) {
    const module = moduleFor(agent);
    const found = module ? module.check(agent) : [`This version doesn't know the agent kind "${agent.kind}".`];
    if (found.length) for (const line of found) bad(`${agent.name}: ${line}`);
    else good(`${agent.name}: ${module.label} is set up`);
  }
  if (!Object.values(config.people).some((keys) => keys.length)) bad("No person's key is trusted, so a person's message wakes nobody by itself and permits nothing: rooms trust \"<person>\" <public key>");
  else good(`Trusted keys for: ${Object.entries(config.people).filter(([, keys]) => keys.length).map(([person]) => person).join(", ")}`);
  const relay = relayStatus();
  if (!relay.running) bad(`The relay isn't running: ${relay.installed ? "rooms relay ensure" : "rooms relay install"}`);
  else if (relay.installed) good("The relay runs as a login service");
  else good("The relay runs in the background, until this machine restarts; `rooms relay ensure` on a schedule starts it again");
  if (problems.length) process.exitCode = 1;
  else console.log("\nEverything checked is in order.");
}
