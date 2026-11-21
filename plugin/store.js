// The plugin's view of a vault's rooms: the same files the `rooms` command reads and writes (see src/format.js),
// through Obsidian's file adapter, so it runs on a phone as well as on a desktop. No Node APIs here.
//
// `adapter` is Obsidian's DataAdapter, or anything with the same methods: list, read, write, exists, mkdir,
// rename, remove. Paths are vault-relative with `/`.

import { DAY, MESSAGE_FILE, PAUSED, ROOMS, STATUS, dayOf, fileOf, memberFileName, memberText, messageFileName, messageText,
  parseFile, parseMember, parseMessage, roomFolderName, roomText, sameName, signedText, timeOf } from "../src/format.js";

const randomId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return (((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0).toString(36).slice(-4);
};

/**
 * A message's text for the Markdown renderer, with `<` outside code shown as itself: agents write placeholders
 * like `<your message>`, which would otherwise be taken for HTML and vanish. The file keeps the text as written.
 */
export const shownText = (body) =>
  body.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/).map((part, i) => (i % 2 ? part : part.replace(/</g, "&lt;"))).join("");

const join = (...parts) => parts.filter(Boolean).join("/");

export class RoomStore {
  /** @param {any} adapter */
  constructor(adapter, folder = ROOMS) {
    this.adapter = adapter;
    this.folder = folder;
  }

  roomDir(room) {
    return join(this.folder, room);
  }

  /** Whether a vault path is part of the rooms: what makes the view look again. */
  covers(path) {
    return path === this.folder || path.startsWith(this.folder + "/");
  }

  async #list(path) {
    try {
      if (!(await this.adapter.exists(path))) return { files: [], folders: [] };
      const listed = await this.adapter.list(path);
      return { files: listed.files.map(fileOf), folders: listed.folders.map(fileOf) };
    } catch {
      return { files: [], folders: [] };
    }
  }

  async #read(path) {
    try {
      return await this.adapter.read(path);
    } catch {
      return null;
    }
  }

  /** Writes a file so that it appears whole: under a hidden name first, then renamed. */
  async #writeWhole(path, text) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    await this.#ensureDir(dir);
    const temp = join(dir, `.tmp-${randomId()}${randomId()}`);
    await this.adapter.write(temp, text);
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
    await this.adapter.rename(temp, path);
  }

  /** Makes a folder and those above it, one at a time: not every adapter makes parents. */
  async #ensureDir(dir) {
    let path = "";
    for (const part of dir.split("/").filter(Boolean)) {
      path = join(path, part);
      if (!(await this.adapter.exists(path))) await this.adapter.mkdir(path);
    }
  }

  /** Folders under Rooms/ that are rooms: not hidden ones, and not `_status`. */
  async rooms() {
    return (await this.#list(this.folder)).folders.filter((name) => !/^[._]/.test(name)).sort();
  }

  /** What ROOM.md says: its title and description. */
  async about(room) {
    const text = await this.#read(join(this.roomDir(room), "ROOM.md"));
    const { fields } = parseFile(text ?? "");
    return { title: String(fields.title || room), description: String(fields.description || "") };
  }

  /** A room's messages, oldest first, as `<day>/<file>`. */
  async messagePaths(room) {
    const days = (await this.#list(this.roomDir(room))).folders.filter((name) => DAY.test(name)).sort();
    const found = [];
    for (const day of days) {
      const { files } = await this.#list(join(this.roomDir(room), day));
      for (const file of files.filter((name) => MESSAGE_FILE.test(name)).sort()) found.push(`${day}/${file}`);
    }
    return found;
  }

  /** A message, or null while its file isn't whole yet (no `from`), or is gone. */
  async message(room, path) {
    const text = await this.#read(join(this.roomDir(room), path));
    if (text === null) return null;
    const message = parseMessage(text, fileOf(path));
    return message.from ? { ...message, path } : null;
  }

  async messages(room, paths) {
    return (await Promise.all(paths.map((path) => this.message(room, path)))).filter(Boolean);
  }

  async members(room) {
    const dir = join(this.roomDir(room), "members");
    const files = (await this.#list(dir)).files.filter((name) => name.endsWith(".md") && !name.startsWith(".")).sort();
    const out = [];
    for (const file of files) {
      const text = await this.#read(join(dir, file));
      if (text !== null) out.push(parseMember(text, file));
    }
    return out;
  }

  async vaultPaused() {
    return this.adapter.exists(join(this.folder, PAUSED));
  }

  async roomPaused(room) {
    return this.adapter.exists(join(this.roomDir(room), PAUSED));
  }

  /**
   * Posts a message: names the file, stamps it at least 1 ms after the newest message here (so a slow clock can't
   * sort it before what it answers), signs it if `signer` is given, and writes it whole.
   * @param {(text: string) => Promise<string>} [signer]
   */
  async post(room, { from, to = [], re = "", seen = "" }, body, signer) {
    const paths = await this.messagePaths(room);
    const latest = paths.length ? await this.message(room, paths.at(-1)) : null;
    const at = new Date(Math.max(Date.now(), ((latest && timeOf(latest)) || 0) + 1));
    const file = messageFileName(at, from, randomId());
    const message = { file, from, at: at.toISOString(), to, seen, re, sig: "", notice: false, body: body.trim() };
    if (signer) message.sig = await signer(signedText(room, message));
    const path = `${dayOf(file)}/${file}`;
    await this.#writeWhole(join(this.roomDir(room), path), messageText(message, body));
    return { ...message, path };
  }

  async createRoom(name, about = "") {
    const folder = roomFolderName(name);
    if (!folder) throw new Error("That name leaves nothing to call the room's folder.");
    const taken = (await this.rooms()).find((room) => room.toLowerCase() === folder.toLowerCase());
    if (taken) throw new Error(`There's already a room called ${taken}.`);
    await this.#writeWhole(join(this.roomDir(folder), "ROOM.md"), roomText(name, about));
    return folder;
  }

  /** Adds a member, one file each. False if they're one already. */
  async addMember(room, { name, kind, addedBy = "" }) {
    if ((await this.members(room)).some((member) => sameName(member.name, name))) return false;
    await this.#writeWhole(join(this.roomDir(room), "members", memberFileName(name)),
      memberText({ name, kind, joined: new Date().toISOString(), addedBy }));
    return true;
  }

  async removeMember(room, name) {
    const member = (await this.members(room)).find((m) => sameName(m.name, name));
    if (!member) return false;
    await this.adapter.remove(join(this.roomDir(room), "members", member.file));
    return true;
  }

  /** Pauses one room, or every room in the vault when `room` is null. */
  async pause(room, who) {
    const where = room ? this.roomDir(room) : this.folder;
    await this.#writeWhole(join(where, PAUSED), `Paused by ${who} at ${new Date().toISOString()}. Nobody is woken ${room ? "in this room" : "in any room of this vault"} while this note exists. Delete it to resume.\n`);
  }

  async resume(room) {
    const file = join(room ? this.roomDir(room) : this.folder, PAUSED);
    if (await this.adapter.exists(file)) await this.adapter.remove(file);
  }

  /** Each machine's relay status note: who it serves and what it last did. */
  async relays() {
    const dir = join(this.folder, STATUS);
    const out = [];
    for (const file of (await this.#list(dir)).files.filter((name) => name.endsWith(".md") && !name.startsWith(".")).sort()) {
      const text = await this.#read(join(dir, file));
      if (text === null) continue;
      const { fields, body } = parseFile(text);
      out.push({ file: join(dir, file), machine: String(fields.machine || file.replace(/\.md$/, "")), relay: String(fields.relay || ""),
        updated: Date.parse(String(fields.updated || "")), body: body.trim() });
    }
    return out;
  }
}
