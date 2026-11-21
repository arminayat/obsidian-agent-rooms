// The relay: one per machine, beside `ob sync`. It watches the registered vaults' Rooms/ folders and, when a
// message is for an agent that lives on this machine, starts that agent through its module.
//
// A file event only means "look now". What to do is decided from saved state: for each agent and room, the set of
// messages already handled. So a restart, a re-download or a burst of events never wakes anyone twice, and a
// message that arrives half-written is simply looked at again.
//
// One wake per agent at a time. A wake that fails is tried again, then reported in the room once.

import { existsSync, readFileSync, watch } from "node:fs";
import { basename, join } from "node:path";
import { loaded } from "./commands.js";
import { loadConfig, readJson, writeJson } from "./config.js";
import { STATUS, sameName, slug, timeOf } from "./format.js";
import { braked, overLimit, targets } from "./policy.js";
import { moduleFor } from "./agents/index.js";
import { packageRoot } from "./agents/shared.js";
import { isPaused, markRead, members, messageFiles, notIn, placeKey, placeOf, post, readMessage, roomNames, roomsDir, unread, writeWhole } from "./vault.js";

const SHOWN_AT_MOST = 20;
const GIVE_UP_AFTER = 3;
/** How long a failed or busy wake waits before the next try: this, times the failures so far. */
const RETRY_MS = Number(process.env.AGENT_ROOMS_RETRY_SECONDS ?? "60") * 1000;
const HOUR = 3_600_000;
const version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;

const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
const when = (ms) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
export const agentKey = (agent) => `${agent.kind}:${agent.name}`;

/** `once` looks at everything one time, waits for the wakes it started, and returns: for tests and for cron. */
export async function runRelay({ once = false } = {}) {
  let config = loadConfig();
  const state = readJson("relay.json", {});
  state.agents ??= {};
  state.status ??= {};
  const save = () => writeJson("relay.json", state);
  const running = new Set();
  const again = new Set();
  const inFlight = new Set();

  /** Looks at one room for one agent, and wakes it if something there is for it. */
  async function consider(agent, vault, room, roomMembers, paths) {
    const key = agentKey(agent);
    if (running.has(key)) return void again.add(key); // one wake at a time; look again when it ends
    const record = (state.agents[key] ??= { rooms: {}, wakes: [] });
    const roomState = (record.rooms[placeKey(vault, room)] ??= {});
    if (!roomState.place) {
      // Just joined, or the relay is new here: from now on. An agent that has never read the room starts from
      // here too, so a later wake shows it what was said since, and nothing from before.
      roomState.place = placeOf(paths);
      if (unread(vault, room, agent.name).fresh === null) markRead(vault, room, agent.name, paths);
      return save();
    }
    const pending = new Set(notIn(roomState.place, paths));
    if (!pending.size) return;
    if (roomState.retryAt && Date.now() < roomState.retryAt) return; // a failed wake is waiting out its pause

    const tail = new Set(paths.slice(-(config.limits.brakeAfter + 10)));
    const recent = await loaded(config, vault, room, paths.filter((path) => tail.has(path) || pending.has(path)));
    const byFile = new Map(recent.map((m) => [m.file, m]));
    const authorOf = (file) => byFile.get(file)?.from ?? readMessage(vault, room, paths.find((path) => basename(path) === file) ?? "")?.from ?? "";
    /** Marks what was looked at as handled. A file that isn't whole yet stays pending, and so does `leave`. */
    const settle = (leave = []) => {
      const left = new Set(leave);
      roomState.place = placeOf(paths.filter((path) => (!pending.has(path) || byFile.has(basename(path))) && !left.has(path)));
      save();
    };

    const now = Date.now();
    const forIt = recent.filter((m) => pending.has(m.path) &&
      targets({ message: m, kind: m.kind, roomMembers, authorOf }).some((target) => sameName(target.name, agent.name)));
    const triggers = forIt.filter((m) => now - timeOf(m) <= config.limits.maxAgeHours * HOUR);
    if (!triggers.length) {
      if (forIt.length) log(`${agent.name}: ${room}: not woken; ${forIt.length} older than ${config.limits.maxAgeHours} h`);
      return settle();
    }
    if (isPaused(vault, room)) {
      log(`${agent.name}: ${room}: not woken; the room is paused`);
      return settle();
    }
    if (braked(recent.filter((m) => !m.notice).map((m) => m.kind), config.limits.brakeAfter)) {
      log(`${agent.name}: ${room}: not woken; the last ${config.limits.brakeAfter} messages all came from agents`);
      return settle();
    }
    record.wakes = record.wakes.filter((at) => now - at < 24 * HOUR);
    const limit = overLimit(record.wakes, config.limits, now);
    if (limit) {
      if (!roomState.limited) log(`${agent.name}: ${room}: not woken yet; ${limit}`);
      roomState.limited = true;
      return settle(triggers.map((m) => m.path)); // kept for when the limit lifts
    }
    roomState.limited = false;

    // What it's shown: everything it hasn't read here (the newest few), with what woke it among them.
    const unseen = unread(vault, room, agent.name).fresh ?? [];
    const everything = [...new Set([...unseen, ...triggers.map((m) => m.path)])].sort();
    const shownPaths = [...new Set([...everything.slice(-SHOWN_AT_MOST), ...triggers.map((m) => m.path)])].sort();
    const wake = {
      vault, room,
      messages: await loaded(config, vault, room, shownPaths),
      earlier: everything.length - shownPaths.length,
      addressed: triggers.some((m) => m.to.some((name) => sameName(name, agent.name)) || (m.re && sameName(authorOf(m.re), agent.name))),
      session: (roomState.session ??= {}),
    };
    record.wakes.push(now);
    settle(); // handled before it starts, so nothing wakes it twice for these
    markRead(vault, room, agent.name, paths.filter((path) => !pending.has(path) || byFile.has(basename(path))));
    running.add(key);
    log(`${agent.name}: ${room}: woken for ${triggers.length} ${triggers.length === 1 ? "message" : "messages"}`);

    const work = (async () => {
      let result;
      try {
        result = await moduleFor(agent).wake(agent, wake);
      } catch (error) {
        result = { ok: false, error: error.message };
      }
      running.delete(key);
      if (result.ok) {
        roomState.failures = 0;
        roomState.retryAt = 0;
        roomState.noticed = false;
        record.last = { at: Date.now(), room, result: "woken" };
        log(`${agent.name}: ${room}: finished`);
      } else {
        record.wakes.pop(); // a wake that didn't happen doesn't count against the limit
        if (!result.busy) roomState.failures = (roomState.failures || 0) + 1;
        const retry = result.busy || roomState.failures < GIVE_UP_AFTER;
        record.last = { at: Date.now(), room, result: result.busy ? "busy; trying again" : `failed: ${result.error}` };
        log(`${agent.name}: ${room}: ${result.busy ? "busy" : `failed (${result.error})`}; ${retry ? "will try again" : "gave up"}`);
        if (retry) {
          const back = new Set(triggers.map((m) => m.file)); // pending again, so a look after the pause finds them
          roomState.place.seen = roomState.place.seen.filter((file) => !back.has(file));
          const pause = result.busy ? RETRY_MS : roomState.failures * RETRY_MS;
          roomState.retryAt = Date.now() + pause;
          if (!once) setTimeout(scanAll, pause + 100).unref();
        } else if (!roomState.noticed) {
          roomState.retryAt = 0;
          roomState.noticed = true;
          roomState.failures = 0;
          await post(vault, room, { from: `Relay on ${config.machine}`, notice: true },
            `Couldn't wake ${agent.name} on ${config.machine} after ${GIVE_UP_AFTER} tries: ${result.error}. \`rooms doctor\` on that machine says what to fix.`);
        }
      }
      save();
      writeStatus();
      if (again.delete(key) && !once) scanAll();
    })();
    inFlight.add(work);
    work.finally(() => inFlight.delete(work));
  }

  async function scan(vault) {
    for (const room of roomNames(vault)) {
      const roomMembers = members(vault, room);
      const here = config.agents.filter((agent) => agent.wake !== false && moduleFor(agent) &&
        roomMembers.some((m) => m.kind === "agent" && sameName(m.name, agent.name)));
      if (!here.length) continue;
      const paths = messageFiles(vault, room);
      for (const agent of here) await consider(agent, vault, room, roomMembers, paths);
    }
  }

  /**
   * A note per machine in each vault, so the plugin can show on any device what this relay last did. Written when
   * it changes, and once an hour so an idle relay can be told from a dead one. Names, times and results only.
   */
  function writeStatus() {
    for (const { path: vault } of config.vaults) {
      if (!existsSync(roomsDir(vault))) continue;
      const rows = [];
      for (const agent of config.agents) {
        const rooms = roomNames(vault).filter((room) => members(vault, room).some((m) => sameName(m.name, agent.name)));
        if (!rooms.length) continue;
        const record = state.agents[agentKey(agent)];
        const last = record?.last && rooms.includes(record.last.room) ? record.last : null;
        const hour = (record?.wakes ?? []).filter((at) => Date.now() - at < HOUR).length;
        rows.push(`| ${agent.name} | ${moduleFor(agent)?.label ?? agent.kind} | ${rooms.join(", ")} | ${last ? `${when(last.at)} in ${last.room}` : "not yet"} | ${last ? last.result.replace(/\|/g, "/") : ""} | ${hour} |`);
      }
      const saved = state.status[vault];
      if (!rows.length && !saved) continue; // nothing of this machine's lives in that vault
      const body = `# Relay on ${config.machine}\n\n` + (rows.length
        ? `| Agent | Kind | Rooms | Last wake | Result | Wakes in the last hour |\n|---|---|---|---|---|---|\n${rows.join("\n")}\n`
        : "No agent on this machine is a member of a room here.\n");
      if (saved?.body === body && Date.now() - saved.at < HOUR) continue;
      writeWhole(join(roomsDir(vault), STATUS, `${slug(config.machine)}.md`),
        `---\nmachine: ${JSON.stringify(config.machine)}\nrelay: ${version}\nupdated: ${new Date().toISOString()}\n---\n${body}`);
      state.status[vault] = { body, at: Date.now() };
    }
    save();
  }

  let chain = Promise.resolve();
  /** One look at every vault. Looks run one after another, never two at once. */
  function scanAll() {
    return (chain = chain.then(async () => {
      config = loadConfig(); // agents and vaults added since
      for (const { path } of config.vaults) await scan(path).catch((error) => log(`couldn't look at ${path}: ${error.message}`));
      writeStatus();
    }));
  }

  if (once) {
    await scanAll();
    while (inFlight.size) await Promise.allSettled([...inFlight]);
    await chain;
    writeStatus();
    return;
  }

  log(`relay ${version} on ${config.machine}: ${config.vaults.length} ${config.vaults.length === 1 ? "vault" : "vaults"}, ` +
    (config.agents.length ? `agents ${config.agents.map((a) => `"${a.name}"`).join(", ")}` : "no agents yet (`rooms setup` adds one)"));
  let timer = null;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(scanAll, 300); // a message is a rename, sometimes several events: look once they settle
  };
  const watchers = new Map();
  const watchAll = () => {
    for (const { path } of config.vaults) {
      if (watchers.has(path) || !existsSync(roomsDir(path))) continue;
      try {
        // Not for the status notes this relay writes, nor for hidden files half-way to being a message.
        const watcher = watch(roomsDir(path), { recursive: true }, (event, file) => !/^_status|(^|[\\/])\./.test(String(file ?? "")) && soon());
        watcher.on("error", () => {
          watcher.close();
          watchers.delete(path);
        });
        watchers.set(path, watcher);
      } catch (error) {
        log(`can't watch ${path} (${error.message}); it's looked at once a minute instead`);
      }
    }
  };
  watchAll();
  await scanAll();
  setInterval(() => {
    watchAll(); // a vault registered since, or one whose watcher failed
    scanAll(); // a safety net if an event is ever missed, and the status note's hourly sign of life
  }, 60_000);
  return new Promise(() => {});
}
