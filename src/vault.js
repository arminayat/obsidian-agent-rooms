// Reading and writing a vault's rooms as files. No git and no network: Obsidian Sync carries the files, and a
// message appears whole, because it's written under a hidden name (which Sync skips) and then renamed.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DAY, MESSAGE_FILE, PAUSED, ROOMS, dayOf, notIn, placeOf, memberFileName, memberText, messageFileName, messageText, parseMember,
  parseMessage, roomFolderName, roomText, sameName, signedText, slug, timeOf } from "./format.js";
import { loadPlaces, savePlaces } from "./config.js";

export { notIn, placeOf } from "./format.js";

export const roomsDir = (vault) => join(vault, ROOMS);
export const roomDir = (vault, room) => join(vault, ROOMS, room);

/** Folders under Rooms/ that are rooms: not hidden ones, and not `_status`. */
export function roomNames(vault) {
  if (!existsSync(roomsDir(vault))) return [];
  return readdirSync(roomsDir(vault), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !/^[._]/.test(entry.name)).map((entry) => entry.name).sort();
}

/** A room's folder name, by its name: exactly, ignoring case, or as it would appear in a file name. */
export function findRoom(vault, name) {
  const rooms = roomNames(vault);
  return rooms.find((room) => room === name) ?? rooms.find((room) => room.toLowerCase() === name.toLowerCase()) ??
    rooms.find((room) => slug(room) === slug(name)) ?? null;
}

/** A room's messages, oldest first, as paths inside the room: `<day>/<file>`. */
export function messageFiles(vault, room) {
  const dir = roomDir(vault, room);
  if (!existsSync(dir)) return [];
  const found = [];
  for (const day of readdirSync(dir).filter((name) => DAY.test(name)).sort()) {
    let files = [];
    try {
      files = readdirSync(join(dir, day));
    } catch {}
    for (const file of files.filter((name) => MESSAGE_FILE.test(name)).sort()) found.push(`${day}/${file}`);
  }
  return found;
}

/** A message, or null while its file isn't whole yet (no `from`), or is gone. */
export function readMessage(vault, room, path) {
  let source;
  try {
    source = readFileSync(join(roomDir(vault, room), path), "utf8");
  } catch {
    return null;
  }
  const message = parseMessage(source, basename(path));
  return message.from ? { ...message, path } : null;
}

export function members(vault, room) {
  const dir = join(roomDir(vault, room), "members");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".md") && !name.startsWith(".")).sort()
    .map((file) => parseMember(readFileSync(join(dir, file), "utf8"), file));
}

export const isPaused = (vault, room) => existsSync(join(roomsDir(vault), PAUSED)) || existsSync(join(roomDir(vault, room), PAUSED));

/** Writes a file so that it appears whole: under a hidden name first, then renamed. */
export function writeWhole(target, text) {
  mkdirSync(dirname(target), { recursive: true });
  const temp = join(dirname(target), `.tmp-${randomBytes(6).toString("hex")}`);
  writeFileSync(temp, text);
  renameSync(temp, target);
}

/**
 * Posts a message: names the file, stamps it at least 1 ms after the newest message here (so a slow clock can't
 * sort a reply before what it answers), signs it if `signer` is given, and writes it whole.
 * @param {(text: string) => Promise<string>} [signer]
 */
export async function post(vault, room, { from, to = [], re = "", seen = "", notice = false }, body, signer) {
  const all = messageFiles(vault, room);
  const latest = all.length ? readMessage(vault, room, all.at(-1)) : null;
  const at = new Date(Math.max(Date.now(), ((latest && timeOf(latest)) || 0) + 1));
  const file = messageFileName(at, from, randomBytes(4).readUInt32BE(0).toString(36).slice(-4));
  const message = { file, from, at: at.toISOString(), to, seen, re, sig: "", notice, body: body.trim() };
  if (signer) message.sig = await signer(signedText(room, message));
  const path = `${dayOf(file)}/${file}`;
  writeWhole(join(roomDir(vault, room), path), messageText(message, body));
  return { ...message, path };
}

export function createRoom(vault, name, about = "") {
  const folder = roomFolderName(name);
  if (!folder) throw new Error("That name leaves nothing to call the room's folder.");
  // Ignoring case even where the file system doesn't: the vault also syncs to machines that do.
  const taken = findRoom(vault, folder);
  if (taken) throw new Error(`There's already a room called ${taken}.`);
  writeWhole(join(roomDir(vault, folder), "ROOM.md"), roomText(name, about));
  return folder;
}

/** Adds a member, one file each, so two joins never touch the same file. False if they're one already. */
export function addMember(vault, room, { name, kind, addedBy = "" }) {
  if (members(vault, room).some((member) => sameName(member.name, name))) return false;
  writeWhole(join(roomDir(vault, room), "members", memberFileName(name)), memberText({ name, kind, joined: new Date().toISOString(), addedBy }));
  return true;
}

export function removeMember(vault, room, name) {
  const member = members(vault, room).find((m) => sameName(m.name, name));
  if (!member) return false;
  rmSync(join(roomDir(vault, room), "members", member.file));
  return true;
}

// --- What a reader has read (a "place": see placeOf in format.js) -------------------------------------------

export const placeKey = (vault, room) => `${vault}::${room}`;

/** What `reader` hasn't read in a room, leaving out their own messages. `fresh` is null if they never read it. */
export function unread(vault, room, reader) {
  const all = messageFiles(vault, room);
  const place = loadPlaces(reader)[placeKey(vault, room)];
  if (!place) return { all, fresh: null };
  const fresh = notIn(place, all).filter((path) => {
    const message = readMessage(vault, room, path);
    return message && !sameName(message.from, reader);
  });
  return { all, fresh };
}

export function markRead(vault, room, reader, paths = messageFiles(vault, room)) {
  const places = loadPlaces(reader);
  places[placeKey(vault, room)] = placeOf(paths);
  savePlaces(reader, places);
}
