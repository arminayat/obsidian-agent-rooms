// The rooms view: a list of rooms with what's new in each, and a room with its messages and a box to post in.
// A room's screen is built once when it opens; a change in the vault redraws its messages and header, and leaves
// what's being typed alone.

import { ItemView, MarkdownRenderer, Notice, moment, setIcon } from "obsidian";
import { fileOf, sameName } from "../src/format.js";
import { targets } from "../src/policy.js";
import { ConnectModal, MembersModal, NewRoomModal, RelaysModal } from "./modals.js";
import { shownText } from "./store.js";

export const VIEW = "agent-rooms";
const SHOWN = 60;
const KIND_LABEL = { person: "", unverified: "not verified", agent: "agent", notice: "relay" };

const ago = (ms) => (Number.isNaN(ms) ? "" : moment(ms).fromNow());
const exact = (ms) => (Number.isNaN(ms) ? "" : moment(ms).format("YYYY-MM-DD HH:mm"));

function iconButton(parent, icon, label, onClick) {
  const button = parent.createEl("button", { cls: "clickable-icon agent-rooms-icon", attr: { "aria-label": label } });
  setIcon(button, icon);
  button.addEventListener("click", onClick);
  return button;
}

export class RoomsView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.store = plugin.store;
    this.room = null;
    this.shown = SHOWN;
    this.to = new Set();
    this.re = null;
    this.drawing = Promise.resolve();
  }

  getViewType() {
    return VIEW;
  }

  getDisplayText() {
    return this.room ? `Room: ${this.room}` : "Rooms";
  }

  getIcon() {
    return "messages-square";
  }

  getState() {
    return { room: this.room };
  }

  async setState(state, result) {
    if (state?.room !== undefined && state.room !== this.room) await this.show(state.room);
    return super.setState(state, result);
  }

  async onOpen() {
    this.contentEl.addClass("agent-rooms");
    await this.show(this.room);
  }

  /** Opens a room, or the list when `room` is null. */
  async show(room) {
    this.room = room;
    this.shown = SHOWN;
    this.to = new Set();
    this.re = null;
    this.contentEl.empty();
    this.header = this.contentEl.createDiv({ cls: "agent-rooms-header" });
    this.banner = this.contentEl.createDiv({ cls: "agent-rooms-banners" });
    this.body = this.contentEl.createDiv({ cls: "agent-rooms-body" });
    if (room) this.#buildComposer();
    this.leaf.updateHeader?.();
    await this.refresh(true);
  }

  /** Redraws what may have changed. Draws run one after another, never two at once. */
  refresh(first = false) {
    this.drawing = this.drawing.then(() => (this.room ? this.#drawRoom(first) : this.#drawList())).catch((error) => {
      console.error("Agent Rooms:", error);
    });
    return this.drawing;
  }

  // --- The list of rooms --------------------------------------------------------------------------------

  async #drawList() {
    const { header, banner, body, store, plugin } = this;
    header.empty();
    header.createDiv({ cls: "agent-rooms-title", text: "Rooms" });
    const actions = header.createDiv({ cls: "agent-rooms-actions" });
    iconButton(actions, "plus", "New room", () => new NewRoomModal(plugin).open());
    iconButton(actions, "bot", "Connect an agent", () => new ConnectModal(plugin).open());
    iconButton(actions, "activity", "Relays: what each machine last did", () => new RelaysModal(plugin).open());
    const vaultPaused = await store.vaultPaused();
    iconButton(actions, vaultPaused ? "play" : "pause", vaultPaused ? "Resume every room" : "Pause every room", () => plugin.pauseAll(!vaultPaused));

    banner.empty();
    this.#nameBanner();
    if (vaultPaused) this.#banner("Every room is paused: nobody is woken.", "Resume", () => plugin.pauseAll(false));

    const rooms = await store.rooms();
    const rows = [];
    for (const room of rooms) {
      const paths = await store.messagePaths(room);
      const last = paths.length ? await store.message(room, paths.at(-1)) : null;
      rows.push({ room, about: await store.about(room), paths, last, unread: plugin.unread(room, paths), paused: await store.roomPaused(room) });
    }
    body.empty();
    if (!rows.length) {
      const empty = body.createDiv({ cls: "agent-rooms-empty" });
      empty.createEl("p", { text: "No rooms in this vault yet. A room is a folder under Rooms/ where you and your agents talk." });
      empty.createEl("button", { cls: "mod-cta", text: "New room" }).addEventListener("click", () => new NewRoomModal(plugin).open());
      return;
    }
    const list = body.createDiv({ cls: "agent-rooms-list" });
    for (const row of rows) {
      const item = list.createDiv({ cls: "agent-rooms-row" });
      item.addEventListener("click", () => this.show(row.room));
      const main = item.createDiv({ cls: "agent-rooms-row-main" });
      const top = main.createDiv({ cls: "agent-rooms-row-top" });
      top.createSpan({ cls: "agent-rooms-row-name", text: row.about.title });
      if (row.paused) setIcon(top.createSpan({ cls: "agent-rooms-paused-icon", attr: { "aria-label": "Paused" } }), "pause");
      const count = row.unread === null ? row.paths.length : row.unread.length;
      if (count) top.createSpan({ cls: "agent-rooms-badge", text: row.unread === null ? "new" : String(count) });
      if (row.about.description) main.createDiv({ cls: "agent-rooms-row-about", text: row.about.description });
      main.createDiv({ cls: "agent-rooms-row-last", text: row.last ? `${row.last.from}, ${ago(Date.parse(row.last.at))}: ${row.last.body.split("\n")[0]}` : "No messages yet" });
    }
  }

  // --- One room ---------------------------------------------------------------------------------------------

  #buildComposer() {
    const composer = this.contentEl.createDiv({ cls: "agent-rooms-composer" });
    this.reLine = composer.createDiv({ cls: "agent-rooms-re" });
    this.chips = composer.createDiv({ cls: "agent-rooms-chips" });
    this.input = composer.createEl("textarea", { cls: "agent-rooms-input", attr: { rows: "3", placeholder: "Write to the room…" } });
    const footer = composer.createDiv({ cls: "agent-rooms-composer-footer" });
    this.wakes = footer.createDiv({ cls: "agent-rooms-wakes" });
    this.sendButton = footer.createEl("button", { cls: "mod-cta", text: "Send" });
    this.sendButton.addEventListener("click", () => this.#send());
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.#send();
      }
    });
  }

  async #drawRoom(first) {
    const { store, plugin, room } = this;
    if (!(await store.rooms()).includes(room)) {
      new Notice(`The room ${room} is gone.`);
      window.setTimeout(() => this.show(null)); // not from inside a draw: show() waits for the draws before it
      return;
    }
    const [about, members, paths, roomPaused, vaultPaused] = await Promise.all([
      store.about(room), store.members(room), store.messagePaths(room), store.roomPaused(room), store.vaultPaused()]);
    this.members = members;
    const shownPaths = paths.slice(-this.shown);
    const messages = await store.messages(room, shownPaths);
    for (const m of messages) m.kind = await plugin.kindOf(room, members, m);
    this.messages = messages;
    this.byFile = new Map(messages.map((m) => [m.file, m]));
    this.paused = roomPaused || vaultPaused;

    // Header
    const { header } = this;
    header.empty();
    iconButton(header, "chevron-left", "All rooms", () => this.show(null));
    const titles = header.createDiv({ cls: "agent-rooms-titles" });
    titles.createDiv({ cls: "agent-rooms-title", text: about.title });
    if (about.description) titles.createDiv({ cls: "agent-rooms-subtitle", text: about.description });
    const actions = header.createDiv({ cls: "agent-rooms-actions" });
    const people = members.length;
    const membersButton = iconButton(actions, "users", `Members (${people})`, () => new MembersModal(plugin, room).open());
    membersButton.createSpan({ cls: "agent-rooms-count", text: String(people) });
    iconButton(actions, roomPaused ? "play" : "pause", roomPaused ? "Resume this room" : "Pause this room", async () => {
      if (roomPaused) await store.resume(room);
      else await store.pause(room, plugin.settings.name || "someone in Obsidian");
      this.refresh();
    });

    // Banners
    this.banner.empty();
    const name = plugin.settings.name;
    this.#nameBanner();
    if (vaultPaused) this.#banner("Every room in this vault is paused: nobody is woken.", "Resume", () => plugin.pauseAll(false));
    else if (roomPaused) this.#banner("This room is paused: nobody is woken.", "Resume", async () => (await store.resume(room), this.refresh()));
    const me = name ? members.find((m) => sameName(m.name, name)) : null;
    if (name && me?.kind !== "person") {
      this.#banner(me ? `${name} is a member here as an agent, so your messages count as an agent's.` : `You're not a member of this room, so your messages count as an agent's and wake only who you address.`,
        me ? null : "Join as a person", me ? null : async () => (await store.addMember(room, { name, kind: "person" }), this.refresh()));
    }

    // Messages
    const scroller = this.body;
    const atBottom = first || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
    scroller.empty();
    if (paths.length > shownPaths.length) {
      scroller.createEl("button", { cls: "agent-rooms-earlier", text: `Show earlier (${paths.length - shownPaths.length} more)` })
        .addEventListener("click", () => ((this.shown += SHOWN), this.refresh()));
    }
    if (!messages.length) scroller.createDiv({ cls: "agent-rooms-empty", text: "No messages yet. What you write here goes to every agent in the room, or only to those you pick." });
    for (const m of messages) await this.#drawMessage(scroller, m);
    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
    plugin.markRead(room, paths);

    this.#drawChips();
  }

  async #drawMessage(parent, m) {
    const mine = m.kind === "person" && sameName(m.from, this.plugin.settings.name);
    const card = parent.createDiv({ cls: `agent-rooms-message agent-rooms-${m.kind}${mine ? " agent-rooms-mine" : ""}`, attr: { "data-file": m.file } });
    const head = card.createDiv({ cls: "agent-rooms-message-head" });
    head.createSpan({ cls: "agent-rooms-from", text: m.from });
    if (KIND_LABEL[m.kind]) head.createSpan({ cls: "agent-rooms-kind", text: KIND_LABEL[m.kind] });
    head.createSpan({ cls: "agent-rooms-time", text: ago(Date.parse(m.at)), attr: { title: exact(Date.parse(m.at)) } });
    if (m.kind !== "notice") iconButton(head, "reply", "Reply", () => this.#replyTo(m));
    if (m.to.length || m.re) {
      const line = card.createDiv({ cls: "agent-rooms-message-meta" });
      if (m.to.length) line.createSpan({ text: `to ${m.to.join(", ")}` });
      if (m.re) {
        const answered = this.byFile.get(m.re);
        const link = line.createEl("a", { text: answered ? `re ${answered.from}: ${answered.body.split("\n")[0].slice(0, 60)}` : `re ${m.re}` });
        link.addEventListener("click", () => parent.querySelector(`[data-file="${CSS.escape(m.re)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
      }
    }
    const text = card.createDiv({ cls: "agent-rooms-text markdown-rendered" });
    await MarkdownRenderer.render(this.app, shownText(m.body), text, `${this.store.roomDir(this.room)}/${m.path}`, this);
  }

  #replyTo(m) {
    this.re = m;
    const author = this.members.find((member) => member.kind === "agent" && sameName(member.name, m.from));
    this.to = new Set(author ? [author.name] : []);
    this.#drawChips();
    this.input.focus();
  }

  /** Who the message would go to: the agents to pick from, the message it answers, and who it would wake. */
  #drawChips() {
    const agents = this.members.filter((m) => m.kind === "agent");
    for (const name of [...this.to]) if (!agents.some((a) => a.name === name)) this.to.delete(name);

    this.reLine.empty();
    this.reLine.toggleClass("is-hidden", !this.re);
    if (this.re) {
      this.reLine.createSpan({ text: `Replying to ${this.re.from}: ${this.re.body.split("\n")[0].slice(0, 80)}` });
      iconButton(this.reLine, "x", "Don't reply to it", () => ((this.re = null), (this.to = new Set()), this.#drawChips()));
    }

    this.chips.empty();
    if (agents.length) {
      const everyone = this.chips.createEl("button", { cls: `agent-rooms-chip${this.to.size ? "" : " is-active"}`, text: "Everyone" });
      everyone.addEventListener("click", () => ((this.to = new Set()), this.#drawChips()));
      for (const agent of agents) {
        const chip = this.chips.createEl("button", { cls: `agent-rooms-chip${this.to.has(agent.name) ? " is-active" : ""}`, text: agent.name });
        chip.addEventListener("click", () => {
          this.to.has(agent.name) ? this.to.delete(agent.name) : this.to.add(agent.name);
          this.#drawChips();
        });
      }
    }
    this.wakes.setText(this.#wakesNote(agents));
  }

  #wakesNote(agents) {
    if (this.paused) return "Paused: nobody is woken.";
    if (!agents.length) return "No agent is a member yet.";
    const name = this.plugin.settings.name;
    const me = this.members.find((m) => sameName(m.name, name));
    const kind = me?.kind === "person" ? "person" : "agent";
    const message = { from: name, to: [...this.to], re: this.re?.file ?? "", notice: false };
    const woken = targets({ message, kind, roomMembers: this.members, authorOf: (file) => this.byFile.get(file)?.from ?? "" });
    return woken.length ? `Wakes ${woken.map((m) => m.name).join(", ")}` : "Wakes nobody";
  }

  async #send() {
    const { plugin, store, room } = this;
    const text = this.input.value.trim();
    if (!text) return;
    const name = plugin.settings.name;
    if (!name) {
      new Notice("Set your name in rooms first.");
      return plugin.openSettings();
    }
    this.sendButton.disabled = true;
    try {
      const paths = await store.messagePaths(room);
      const seen = paths.length ? fileOf(paths.at(-1)) : "";
      const message = await store.post(room, { from: name, to: [...this.to], re: this.re?.file ?? "", seen }, text, plugin.signer(await plugin.key()));
      plugin.markRead(room, [...paths, message.path]);
      this.input.value = "";
      this.re = null;
      this.to = new Set();
      await this.refresh(true);
    } catch (error) {
      new Notice(`Not sent: ${error.message}`);
    } finally {
      this.sendButton.disabled = false;
    }
  }

  // --- Banners --------------------------------------------------------------------------------------------

  #nameBanner() {
    if (!this.plugin.settings.name) this.#banner("Set your name in rooms, so your messages are signed as yours.", "Settings", () => this.plugin.openSettings());
  }

  #banner(text, action, onClick) {
    const line = this.banner.createDiv({ cls: "agent-rooms-banner" });
    line.createSpan({ text });
    if (action) line.createEl("button", { text: action }).addEventListener("click", onClick);
  }
}
