// The room files, as text. Pure: no file system and no Node APIs, so the Obsidian plugin can use it too.
//
//   Rooms/<room>/ROOM.md                                        the room's manual: what it's for, who does what
//   Rooms/<room>/members/<name>.md                              one file per member: name, kind (person or agent),
//                                                               and what it does here (role), if anyone said
//   Rooms/<room>/<UTC day>/<UTC time to the ms>_<writer>_<random>.md   one file per message
//   Rooms/<room>/PAUSED.md, Rooms/PAUSED.md                     nobody is woken while one exists
//   Rooms/_status/<machine>.md                                  what each machine's relay last did
//
// One file per message, so no two writers ever change the same file and Obsidian Sync has nothing to merge.

export const ROOMS = "Rooms";
export const STATUS = "_status";
export const PAUSED = "PAUSED.md";
export const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const MESSAGE_FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z_[a-z0-9-]+_[0-9a-z]{1,8}\.md$/;

/** A name as it appears in file names: lowercase letters, digits and hyphens. */
export const slug = (name) =>
  String(name).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 32) || "someone";

/** Whether two names mean the same member: "Codex" and "codex" do. */
export const sameName = (a, b) => a === b || slug(a) === slug(b);

// --- Front matter ------------------------------------------------------------------------------------

function scalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      return String(JSON.parse(value));
    } catch {}
  }
  if (value.length > 1 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

function inlineList(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {}
  return raw.replace(/^\[|\]$/g, "").split(",").map(scalar).filter(Boolean);
}

/**
 * Splits a file into its front matter fields and its body. A field is a string, or a list of strings when it
 * was written as one, inline (`to: ["A", "B"]`) or as a block, which is how Obsidian rewrites it.
 */
export function parseFile(text) {
  const match = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
  if (!match) return { fields: {}, body: text, hasFrontMatter: false };
  /** @type {Record<string, string | string[]>} */
  const fields = {};
  let listKey = null;
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && listKey) {
      fields[listKey].push(scalar(item[1]));
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 1 || /^\s/.test(line)) continue;
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    if (raw === "") {
      fields[key] = [];
      listKey = key;
      continue;
    }
    listKey = null;
    fields[key] = raw.startsWith("[") ? inlineList(raw) : scalar(raw);
  }
  return { fields, body: match[2], hasFrontMatter: true };
}

const text = (value) => (Array.isArray(value) ? value.join(", ") : String(value ?? ""));
const list = (value) => (Array.isArray(value) ? value : value ? [String(value)] : []);

/** A front matter value, quoted when YAML would otherwise read it as something else. */
export const yaml = (value) =>
  /^[A-Za-z][\w .,()'@/+-]*$/.test(value) && !/^(true|false|yes|no|on|off|null)$/i.test(value) ? value : JSON.stringify(value);

// --- Messages ------------------------------------------------------------------------------------------

/**
 * @typedef {object} Message
 * @property {string} file    the file's name, which starts with the time and so sorts in order
 * @property {string} from    who wrote it, by their own account
 * @property {string} at      when, in UTC to the millisecond
 * @property {string[]} to    who it's addressed to; empty means the room
 * @property {string} seen    the newest message the writer had read
 * @property {string} re      the message it answers
 * @property {string} sig     a person's signature over the message, from the plugin
 * @property {boolean} notice written by a relay about itself; wakes nobody
 * @property {string} body
 */

/** @returns {Message} */
export function parseMessage(source, file) {
  const { fields, body } = parseFile(source);
  return {
    file,
    from: text(fields.from),
    at: text(fields.at),
    to: list(fields.to),
    seen: text(fields.seen),
    re: text(fields.re),
    sig: text(fields.sig),
    notice: text(fields.notice) === "true",
    body: body.trim(),
  };
}

/** A message file's text. */
export function messageText({ from, at, to = [], seen = "", re = "", sig = "", notice = false }, body) {
  const lines = ["---", `from: ${yaml(from)}`, `at: ${at}`];
  if (to.length) lines.push(`to: [${to.map((name) => JSON.stringify(name)).join(", ")}]`);
  if (seen) lines.push(`seen: ${seen}`);
  if (re) lines.push(`re: ${re}`);
  if (notice) lines.push("notice: true");
  if (sig) lines.push(`sig: ${sig}`);
  return `${lines.join("\n")}\n---\n${body.trim()}\n`;
}

/** The name of a message's file: the time with `-` for `:`, the writer, and a few random characters. */
export const messageFileName = (at, writer, random) => `${at.toISOString().replace(/:/g, "-")}_${slug(writer)}_${random}.md`;

/** The UTC day folder a message file belongs in. */
export const dayOf = (file) => file.slice(0, 10);

/** The last part of a path: a message's file name from `<day>/<file>`. */
export const fileOf = (path) => path.slice(path.lastIndexOf("/") + 1);

// --- What a reader has read ----------------------------------------------------------------------------
// A place is the set of message files a reader has seen in a room, for days from `before` on; earlier days count
// as read. A set, not "everything up to the newest name", because names follow each writer's clock: a message
// stamped in the past must still show up as new.

const KEPT_DAYS = 14;

/** The place that covers these messages. */
export function placeOf(paths, now = Date.now()) {
  const before = new Date(now - KEPT_DAYS * 86_400_000).toISOString().slice(0, 10);
  return { before, seen: paths.map(fileOf).filter((file) => dayOf(file) >= before) };
}

/** The messages a place doesn't cover; all of them if there's no place yet. */
export function notIn(place, paths) {
  if (!place) return paths;
  const seen = new Set(place.seen);
  return paths.filter((path) => dayOf(fileOf(path)) >= place.before && !seen.has(fileOf(path)));
}

/** When a message was written, from its `at` or else its file name; NaN if neither says. */
export function timeOf(message) {
  const at = Date.parse(message.at);
  if (!Number.isNaN(at)) return at;
  const stamp = message.file.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}\.\d{3})Z/);
  return stamp ? Date.parse(`${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}Z`) : NaN;
}

/**
 * What a person's signature covers. The room and the file name are part of it, so a signed message copied into
 * another room, or under another name, doesn't verify.
 */
export const signedText = (room, message) =>
  ["agent-rooms/v1", room, message.file, message.from, message.at, message.to.join("\u001f"), message.re,
    message.body.replace(/\r\n/g, "\n").trim()].join("\n");

// --- Members and rooms -----------------------------------------------------------------------------------

/** @typedef {{ name: string, kind: "person" | "agent", role: string, file: string }} Member */

/** @returns {Member} */
export function parseMember(source, file) {
  const { fields } = parseFile(source);
  return { name: text(fields.name) || file.replace(/\.md$/, ""), kind: text(fields.kind) === "person" ? "person" : "agent", role: text(fields.role).trim(), file };
}

export const memberFileName = (name) => `${slug(name)}.md`;

const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export function memberText({ name, kind, joined, addedBy = "", role = "" }) {
  role = oneLine(role);
  return `---\nname: ${yaml(name)}\nkind: ${kind}\n${role ? `role: ${yaml(role)}\n` : ""}joined: ${joined}\n${addedBy ? `added_by: ${yaml(addedBy)}\n` : ""}---\n`;
}

/** A member file with its role set, or taken out when `role` is empty; every other line as it was. */
export function withRole(source, role) {
  role = oneLine(role);
  const match = source.match(/^(\uFEFF?---(\r?\n))([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$)[\s\S]*)$/);
  if (!match) return role ? `---\nrole: ${yaml(role)}\n---\n${source}` : source;
  const lines = match[3].split(/\r?\n/).filter((line) => !/^role:/.test(line));
  if (role) {
    const kind = lines.findIndex((line) => /^kind:/.test(line));
    lines.splice(kind === -1 ? lines.length : kind + 1, 0, `role: ${yaml(role)}`);
  }
  return match[1] + lines.join(match[2]) + match[4];
}

export const DEFAULT_ABOUT = "A room where people and agents talk.";

/** Shown to whoever opens ROOM.md, and never to agents: Obsidian hides %% comments %% when reading, and so does a wake. */
const MANUAL_HINT = "%% This note is the room's manual. Every agent woken here is shown what you write below the title: what the room is for, " +
  "what each member does here, and what doesn't belong. A member's role can also go in its file in members/. %%";

export function roomText(name, about = "", manual = "") {
  return `---\ntitle: ${yaml(name)}\ndescription: ${yaml(oneLine(about) || DEFAULT_ABOUT)}\n---\n# ${name}\n\n${MANUAL_HINT}\n${manual.trim() ? `\n${manual.trim()}\n` : ""}`;
}

/**
 * What ROOM.md says: its title, a line on what the room is for, and its manual, the body below the title without
 * %% comments %%. A room started before manuals had its description there, which isn't repeated as a manual.
 */
export function parseRoom(source, folder) {
  const { fields, body } = parseFile(source ?? "");
  const description = text(fields.description).trim();
  const manual = body.replace(/%%[\s\S]*?%%/g, "").replace(/^\s*#[ \t].*(?:\r?\n|$)/, "").trim();
  return { title: text(fields.title).trim() || folder, description, manual: manual === description ? "" : manual };
}

/** A folder name for a room: the name without the characters file systems and Obsidian refuse. */
export const roomFolderName = (name) => name.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().replace(/^[._]+/, "");
