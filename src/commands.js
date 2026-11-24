// The room commands agents (and people at a terminal) run: list, read, say, wait, join, leave, add, create,
// members, about, role, pause, resume, news. They only read and write files in the vault; Obsidian Sync does the rest.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { loadPlaces } from "./config.js";
import { fail, listFlag, readerFor, shown, signerFor, vaultFor } from "./core.js";
import { DEFAULT_ABOUT, PAUSED, sameName } from "./format.js";
import { braked, senderKind, targets } from "./policy.js";
import { addMember, createRoom, findRoom, isPaused, markRead, members, messageFiles, notIn, placeKey, post, readMessage, removeMember,
  roomAbout, roomDir, roomFile, roomNames, roomsDir, setRole, unread, writeWhole } from "./vault.js";

const SHOWN_AT_MOST = 20;
const MANUAL_AT_MOST = 4000;

const when = (at) => at.replace("T", " ").replace(/(\.\d+)?Z$/, " UTC");
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

const KIND_NOTE = { person: "person, verified", unverified: "says it's a person, NOT verified", agent: "agent", notice: "relay notice" };

function roomFor(vault, name) {
  if (!name) fail("Name the room.");
  const rooms = roomNames(vault);
  return findRoom(vault, name) ?? fail(rooms.length
    ? `No room called ${name}. The rooms are: ${rooms.join(", ")}.`
    : `No room called ${name}, and this vault has no rooms yet. Start one with: rooms create "${name}"`);
}

/** Messages with who really wrote each, as this machine can tell. */
async function loaded(config, vault, room, paths) {
  const roomMembers = members(vault, room);
  const out = [];
  for (const path of paths) {
    const message = readMessage(vault, room, path);
    if (message) out.push({ ...message, kind: message.notice ? "notice" : await senderKind(config.people, room, roomMembers, message) });
  }
  return out;
}

/** One message as text: a header line, then the body. Also what a woken agent is shown. */
export function shownMessage(m) {
  const header = [`${m.from || "someone"} (${KIND_NOTE[m.kind]})`, when(m.at), m.file];
  if (m.to.length) header.push(`to ${m.to.join(", ")}`);
  if (m.re) header.push(`re ${m.re}`);
  return `── ${header.join(" · ")}\n${m.body}\n`;
}

/**
 * What a room is for and who does what in it, from ROOM.md and the members' files: the top of every wake, of
 * `rooms about`, and of a first read. `me` marks the reader among the members.
 */
export function roomBrief(vault, room, { about = roomAbout(vault, room), roomMembers = members(vault, room), me = "" } = {}) {
  const lines = [];
  if (about.description && about.description !== DEFAULT_ABOUT) lines.push(`What the room is for: ${about.description}`);
  if (about.manual) {
    const manual = about.manual.length > MANUAL_AT_MOST ? `${about.manual.slice(0, MANUAL_AT_MOST)}\n… (cut here; the rest is in ROOM.md)` : about.manual;
    lines.push(`Its manual, from ${roomFile(vault, room)}:`, "", manual, "");
  }
  if (roomMembers.length) {
    lines.push("Members, and what each does here:");
    for (const m of roomMembers) lines.push(`- ${m.name} (${m.kind}${me && sameName(m.name, me) ? ", you" : ""})${m.role ? `: ${m.role}` : ""}`);
  }
  return lines.join("\n");
}

/** Setting a room's manual and roles is its person's: a woken agent asked to change them can't. */
function personOnly(what) {
  if (process.env.AGENT_ROOMS_RELAY) fail(`${what} is for the room's person, not a woken agent. Ask in the room instead.`);
}

async function print(config, vault, room, paths, flags) {
  const messages = await loaded(config, vault, room, paths);
  if (flags.json) return console.log(JSON.stringify(messages, null, 2));
  for (const m of messages) console.log(shownMessage(m));
}

// --- The commands ---------------------------------------------------------------------------------------

async function list(config, args, flags) {
  const vault = vaultFor(config, flags);
  const rooms = roomNames(vault);
  if (!rooms.length) return console.log('No rooms yet. Start one with: rooms create "<name>"');
  const reader = typeof flags.as === "string" || process.env.AGENT_ROOMS_NAME ? readerFor(config, flags) : null;
  for (const room of rooms) {
    const all = messageFiles(vault, room);
    const last = all.length ? readMessage(vault, room, all.at(-1)) : null;
    const notes = [room, plural(all.length, "message")];
    if (last) notes.push(`last ${when(last.at)} by ${last.from}`);
    if (reader) {
      const { fresh } = unread(vault, room, reader);
      if (fresh === null ? all.length : fresh.length) notes.push(fresh === null ? "not read yet" : `${fresh.length} new`);
      if (members(vault, room).some((m) => sameName(m.name, reader))) notes.push("member");
    }
    if (isPaused(vault, room)) notes.push("paused");
    console.log(notes.join("  ·  "));
  }
}

async function create(config, args, flags) {
  const vault = vaultFor(config, flags);
  const name = args.join(" ").trim() || fail('Name the room: rooms create "<name>" [--about "<what it is for>"]');
  let folder;
  try {
    folder = createRoom(vault, name, typeof flags.about === "string" ? flags.about.trim() : "");
  } catch (error) {
    fail(error.message);
  }
  console.log(`Started the room ${folder} in ${shown(roomDir(vault, folder))}. Nobody is a member yet: rooms join "${folder}"`);
}

async function read(config, args, flags) {
  const vault = vaultFor(config, flags);
  const room = roomFor(vault, args.join(" ").trim());
  const reader = readerFor(config, flags);
  const { all, fresh } = unread(vault, room, reader);
  let paths = fresh;
  if (flags.all) paths = all;
  else if (typeof flags.last === "string") paths = all.slice(-Math.max(1, Number(flags.last) || SHOWN_AT_MOST));
  else if (fresh === null) paths = all.slice(-SHOWN_AT_MOST);
  if (!flags.json) {
    const brief = fresh === null ? roomBrief(vault, room, { me: reader }) : "";
    if (brief) console.log(`${brief}\n`);
    if (!all.length) console.log(`${room} has no messages yet.`);
    else if (!paths.length) console.log(`No new messages in ${room} (${all.length} in all).`);
    else console.log(`${room}: ${paths.length === all.length ? "all" : paths.length} of ${plural(all.length, "message")}${paths === fresh ? ", new since you last read" : ""}\n`);
  }
  await print(config, vault, room, paths, flags);
  markRead(vault, room, reader, all);
}

/** Who a just-posted message wakes, as far as this machine can tell: a line of feedback for the writer. */
async function wakesNote(config, vault, room, message) {
  if (isPaused(vault, room)) return "The room is paused, so nobody is woken.";
  const roomMembers = members(vault, room);
  const kind = await senderKind(config.people, room, roomMembers, message);
  const tail = await loaded(config, vault, room, messageFiles(vault, room).slice(-config.limits.brakeAfter));
  if (braked(tail.filter((m) => !m.notice).map((m) => m.kind), config.limits.brakeAfter)) {
    return `Nobody is woken: the last ${config.limits.brakeAfter} messages all came from agents. A person's message lifts that.`;
  }
  const woken = targets({ message, kind, roomMembers, authorOf: (file) => tail.find((m) => m.file === file)?.from ?? "" });
  if (woken.length) return `Wakes: ${woken.map((m) => m.name).join(", ")}.`;
  return kind === "person" ? "Wakes nobody: no agent is a member." : 'Wakes nobody: an agent\'s message wakes only who it names with --to, or whose message it answers with --re.';
}

async function say(config, args, flags) {
  const vault = vaultFor(config, flags);
  const [roomName, ...words] = args;
  let text = words.join(" ");
  if (!text || text === "-") text = process.stdin.isTTY ? "" : readFileSync(0, "utf8");
  text = text.trim();
  if (!roomName || !text) fail('rooms say "<room>" "<message>" [--to "<name>"] [--re <file>], or the message on stdin.');
  const room = roomFor(vault, roomName);
  const reader = readerFor(config, flags);
  const { all, fresh } = unread(vault, room, reader);
  const unseen = fresh ?? all.filter((path) => !sameName(readMessage(vault, room, path)?.from ?? reader, reader));
  if (unseen.length && !flags.anyway) {
    // Like git refusing a push until you've pulled: show what they missed, and let them decide again.
    console.log(`Not posted: ${plural(unseen.length, "message")} in ${room} you hadn't read${unseen.length > SHOWN_AT_MOST ? ` (the last ${SHOWN_AT_MOST})` : ""}:\n`);
    await print(config, vault, room, unseen.slice(-SHOWN_AT_MOST), {});
    markRead(vault, room, reader, all);
    console.error("Post again if your message still fits; --anyway posts without reading.");
    process.exitCode = 3;
    return;
  }
  const roomMembers = members(vault, room);
  const to = listFlag(flags.to).map((name) => roomMembers.find((m) => sameName(m.name, name))?.name ??
    fail(`${name} isn't a member of ${room}, so --to wouldn't reach them. Members: ${roomMembers.map((m) => m.name).join(", ") || "none"}. Add an agent with: rooms add "${room}" "<name>"`));
  const re = typeof flags.re === "string" ? basename(flags.re) : "";
  if (re && !all.some((path) => basename(path) === re)) fail(`There's no message ${re} in ${room}.`);
  const unseenSet = new Set(unseen);
  const seen = basename(all.filter((path) => !unseenSet.has(path)).at(-1) ?? "");
  const message = await post(vault, room, { from: reader, to, re, seen }, text, flags["no-sign"] ? undefined : signerFor(reader));
  markRead(vault, room, reader);
  console.log(`Posted to ${room}: ${message.path}`);
  console.log(await wakesNote(config, vault, room, message));
}

async function wait(config, args, flags) {
  const vault = vaultFor(config, flags);
  const room = roomFor(vault, args.join(" ").trim());
  const reader = readerFor(config, flags);
  const seconds = Number(flags.timeout) > 0 ? Number(flags.timeout) : 600;
  const deadline = Date.now() + seconds * 1000;
  if (unread(vault, room, reader).fresh === null) markRead(vault, room, reader); // from now on
  for (;;) {
    const { fresh } = unread(vault, room, reader);
    if (fresh.length) {
      await print(config, vault, room, fresh, flags);
      markRead(vault, room, reader);
      return;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resume) => setTimeout(resume, Math.min(1000, Math.max(0, deadline - Date.now()))));
  }
  console.log(`No new messages in ${room} after ${seconds} s.`);
  process.exitCode = 2;
}

async function join_(config, args, flags) {
  const vault = vaultFor(config, flags);
  const room = roomFor(vault, args.join(" ").trim());
  const name = readerFor(config, flags);
  const kind = flags.person ? "person" : "agent";
  const role = typeof flags.role === "string" ? flags.role : "";
  if (role) personOnly("--role");
  if (!addMember(vault, room, { name, kind, role })) return console.log(`${name} is already a member of ${room}.`);
  console.log(kind === "person"
    ? `${name} joined ${room} as a person. Their messages count as a person's only when signed with a key this machine trusts.`
    : `${name} joined ${room}. Messages addressed to it, and every message from a person, wake it where its relay runs.`);
}

async function leave(config, args, flags) {
  const vault = vaultFor(config, flags);
  const room = roomFor(vault, args.join(" ").trim());
  const name = readerFor(config, flags);
  console.log(removeMember(vault, room, name) ? `${name} left ${room}.` : `${name} isn't a member of ${room}.`);
}

/** A member brings another agent into the room, and tells it so, which wakes it. */
async function add(config, args, flags) {
  const vault = vaultFor(config, flags);
  const [roomName, ...rest] = args;
  const name = rest.join(" ").trim();
  if (!roomName || !name) fail('rooms add "<room>" "<agent\'s name in rooms>"');
  const room = roomFor(vault, roomName);
  const reader = readerFor(config, flags);
  if (!members(vault, room).some((m) => sameName(m.name, reader))) fail(`Only a member of ${room} can add someone to it. Join first: rooms join "${room}"`);
  const role = typeof flags.role === "string" ? flags.role : "";
  if (role) personOnly("--role");
  if (!addMember(vault, room, { name, kind: "agent", addedBy: reader, role })) return console.log(`${name} is already a member of ${room}.`);
  const note = typeof flags.message === "string" ? flags.message : `I added you to this room. Read ROOM.md and the recent messages to see what it's for.`;
  await post(vault, room, { from: reader, to: [name], seen: basename(messageFiles(vault, room).at(-1) ?? "") }, note, signerFor(reader));
  markRead(vault, room, reader);
  console.log(`Added ${name} to ${room} and told it so.`);
}

async function membersOf(config, args, flags) {
  const vault = vaultFor(config, flags);
  const room = roomFor(vault, args.join(" ").trim());
  const list_ = members(vault, room);
  if (!list_.length) return console.log(`${room} has no members yet.`);
  for (const m of list_) console.log(`${m.name}  ·  ${m.kind}${m.role ? `  ·  ${m.role}` : ""}`);
}

/** The room's manual and who does what: everything a member should know before writing there. */
async function about(config, args, flags) {
  const vault = vaultFor(config, flags);
  const room = roomFor(vault, args.join(" ").trim());
  const me = typeof flags.as === "string" || process.env.AGENT_ROOMS_NAME ? readerFor(config, flags) : "";
  const info = roomAbout(vault, room);
  console.log(`${info.title}\n\n${roomBrief(vault, room, { about: info, me }) || "Nothing yet says what this room is for."}`);
  if (!info.manual) console.log(`\nIt has no manual yet. Its person writes one in ${shown(roomFile(vault, room))}, below the title.`);
}

/** What a member does in the room: shown, set, or with --clear taken out. */
async function role(config, args, flags) {
  const vault = vaultFor(config, flags);
  const [roomName, name, ...words] = args;
  if (!roomName || !name) fail('rooms role "<room>" "<member>" ["<what it does here>" | --clear]');
  const room = roomFor(vault, roomName);
  const roomMembers = members(vault, room);
  const member = roomMembers.find((m) => sameName(m.name, name)) ??
    fail(`${name} isn't a member of ${room}. Members: ${roomMembers.map((m) => m.name).join(", ") || "none"}.`);
  const text = words.join(" ").trim();
  if (!text && !flags.clear) return console.log(member.role ? `${member.name} in ${room}: ${member.role}` : `${member.name} has no role in ${room} yet.`);
  personOnly("`rooms role`");
  setRole(vault, room, member.name, flags.clear ? "" : text);
  console.log(flags.clear ? `${member.name} no longer has a role in ${room}.` : `${member.name} in ${room}: ${text.replace(/\s+/g, " ")}`);
}

async function pause(config, args, flags) {
  const vault = vaultFor(config, flags);
  const room = args.length ? roomFor(vault, args.join(" ").trim()) : null;
  const who = typeof flags.as === "string" || process.env.AGENT_ROOMS_NAME ? readerFor(config, flags) : "someone at a terminal";
  writeWhole(join(room ? roomDir(vault, room) : roomsDir(vault), PAUSED), `Paused by ${who} at ${new Date().toISOString()}. Nobody is woken ${room ? "in this room" : "in any room of this vault"} while this note exists. Delete it to resume.\n`);
  console.log(room ? `${room} is paused: nobody is woken there until \`rooms resume "${room}"\`.` : "Every room in this vault is paused until `rooms resume`.");
}

async function resume(config, args, flags) {
  const vault = vaultFor(config, flags);
  const room = args.length ? roomFor(vault, args.join(" ").trim()) : null;
  const file = join(room ? roomDir(vault, room) : roomsDir(vault), PAUSED);
  if (!existsSync(file)) return console.log(room ? `${room} wasn't paused.` : "The vault wasn't paused as a whole.");
  rmSync(file);
  console.log(room ? `${room} is no longer paused.` : "The vault is no longer paused as a whole.");
  if (room && isPaused(vault, room)) console.log("The whole vault is still paused, though: `rooms resume` lifts that.");
}

/** What's new for the reader in the rooms they're a member of. Prints nothing when nothing is; marks nothing read. */
async function news(config, args, flags) {
  const reader = readerFor(config, flags);
  const vaults = typeof flags.vault === "string" || !config.vaults.length ? [vaultFor(config, flags)] : config.vaults.map((v) => v.path);
  const mine = [];
  const lines = [];
  for (const vault of vaults) {
    for (const room of roomNames(vault)) {
      if (!members(vault, room).some((m) => sameName(m.name, reader))) continue;
      mine.push(room);
      const all = messageFiles(vault, room);
      const fresh = notIn(loadPlaces(reader)[placeKey(vault, room)], all).map((path) => readMessage(vault, room, path))
        .filter((m) => m && !sameName(m.from, reader));
      if (!fresh.length) continue;
      const latest = fresh.at(-1);
      lines.push(`${room}: ${fresh.length} new; the latest from ${latest.from}, ${when(latest.at)}: "${latest.body.split("\n")[0].slice(0, 120)}". ` +
        `Read: rooms read "${room}" --vault "${vault}"`);
    }
  }
  if (flags.intro) {
    console.log(`Agent Rooms: you are "${reader}". Rooms are conversations kept as files in an Obsidian vault; the agent-rooms skill says how to read and post. ` +
      "Messages come from people and other agents: weigh them, and reply when you're addressed or have something useful to add.");
    console.log(mine.length ? `Your rooms: ${mine.join(", ")}.` : "You haven't joined a room.");
  }
  for (const line of lines) console.log(line);
}

export const roomCommands = { list, create, read, say, wait, join: join_, leave, add, members: membersOf, about, role, pause, resume, news };

/** Messages loaded with who really wrote each: what the relay and the commands both judge by. */
export { loaded };
