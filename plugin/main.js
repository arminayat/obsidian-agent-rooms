// Agent Rooms for Obsidian: read and post in rooms from the app, on a desktop or a phone. The relay on each
// machine does the waking; this plugin gives a person a "send" moment (Obsidian saves as you type, so a note
// written in a room folder would sync half-finished), signs what they post, and shows the relays' status.
//
// Kept on this device only, never synced: the signing key and what has been read (Obsidian's per-vault local
// storage). Synced with the vault's plugin settings: the name and the other devices' public keys.

import { Notice, Platform, Plugin, PluginSettingTab, Setting, debounce } from "obsidian";
import { fileOf, notIn, placeOf, slug } from "../src/format.js";
import { senderKind } from "../src/policy.js";
import { newKeyPair, sign } from "../src/sign.js";
import { RoomStore } from "./store.js";
import { RoomsView, VIEW } from "./view.js";
import { NewRoomModal } from "./modals.js";

const KEY = "agent-rooms-key";
const READ = "agent-rooms-read";
const DEFAULTS = { name: "", otherKeys: [] };

export default class AgentRooms extends Plugin {
  async onload() {
    this.settings = { ...DEFAULTS, ...(await this.loadData()) };
    this.store = new RoomStore(this.app.vault.adapter);
    this.kinds = new Map();

    this.registerView(VIEW, (leaf) => new RoomsView(leaf, this));
    this.addRibbonIcon("messages-square", "Open rooms", () => this.open());
    this.addCommand({ id: "open", name: "Open rooms", callback: () => this.open() });
    this.addCommand({ id: "new-room", name: "New room", callback: () => new NewRoomModal(this).open() });
    this.addCommand({ id: "pause-all", name: "Pause every room (nobody is woken)", callback: () => this.pauseAll(true) });
    this.addCommand({ id: "resume-all", name: "Resume every room", callback: () => this.pauseAll(false) });
    this.addSettingTab(new AgentRoomsSettings(this));

    // A change under Rooms/ (a message arriving through Sync, a member joining) redraws the open views.
    const changed = debounce(() => this.refresh(), 300, true);
    for (const event of ["create", "modify", "delete"]) {
      this.registerEvent(this.app.vault.on(event, (file) => this.store.covers(file.path) && changed()));
    }
    this.registerEvent(this.app.vault.on("rename", (file, old) => (this.store.covers(file.path) || this.store.covers(old)) && changed()));
    this.registerInterval(window.setInterval(() => this.refresh(), 60_000)); // times like "5 minutes ago", and a missed event
  }

  async open(room = null) {
    let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf(Platform.isMobile ? false : "tab");
      await leaf.setViewState({ type: VIEW, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    if (room && leaf.view instanceof RoomsView) await leaf.view.show(room);
  }

  refresh() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) if (leaf.view instanceof RoomsView) leaf.view.refresh();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.kinds.clear();
    this.refresh();
  }

  openSettings() {
    this.app.setting?.open();
    this.app.setting?.openTabById(this.manifest.id);
  }

  async pauseAll(pause) {
    if (pause) await this.store.pause(null, this.settings.name || "someone in Obsidian");
    else await this.store.resume(null);
    new Notice(pause ? "Every room is paused: nobody is woken until you resume." : "Rooms are no longer paused as a whole.");
    this.refresh();
  }

  // --- This device's key ---------------------------------------------------------------------------------

  /** This device's key pair, made the first time it's needed. The private half never leaves the device. */
  async key() {
    let pair = this.app.loadLocalStorage(KEY);
    if (!pair?.publicKey || !pair?.privateKey) {
      pair = await newKeyPair();
      this.app.saveLocalStorage(KEY, pair);
      this.kinds.clear();
    }
    return pair;
  }

  async replaceKey() {
    this.app.saveLocalStorage(KEY, null);
    return this.key();
  }

  signer(pair) {
    return (payload) => sign(pair.privateKey, payload);
  }

  /** Whose signatures this device recognises: the person using it, with this device's key and their others. */
  async people() {
    if (!this.settings.name) return {};
    const own = (await this.key()).publicKey;
    return { [this.settings.name]: [own, ...this.settings.otherKeys.filter(Boolean)] };
  }

  /** Who wrote a message, as this device can tell: person, unverified, agent or notice. Remembered per file. */
  async kindOf(room, members, message) {
    if (message.notice) return "notice";
    const id = `${room}/${message.file}/${message.sig}/${members.find((m) => m.name === message.from)?.kind ?? ""}`;
    if (!this.kinds.has(id)) this.kinds.set(id, await senderKind(await this.people(), room, members, message));
    return this.kinds.get(id);
  }

  // --- What has been read, on this device -----------------------------------------------------------------

  #places() {
    return this.app.loadLocalStorage(READ) ?? {};
  }

  /** Messages in `paths` this device hasn't shown, leaving out the person's own. Null if the room was never opened. */
  unread(room, paths) {
    const place = this.#places()[room];
    if (!place) return null;
    const mine = slug(this.settings.name || "\u0000");
    return notIn(place, paths).filter((path) => fileOf(path).split("_")[1] !== mine);
  }

  markRead(room, paths) {
    const places = this.#places();
    places[room] = placeOf(paths);
    this.app.saveLocalStorage(READ, places);
  }
}

class AgentRoomsSettings extends PluginSettingTab {
  constructor(plugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  async display() {
    const { containerEl } = this;
    const plugin = this.plugin;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Your name in rooms")
      .setDesc("Your messages are posted and signed under this name. In each room you're a member as a person under the same name.")
      .addText((text) => text.setPlaceholder("Your name").setValue(plugin.settings.name).onChange(async (value) => {
        plugin.settings.name = value.trim();
        await plugin.saveSettings();
      }));

    const pair = await plugin.key();
    const trust = `rooms trust "${plugin.settings.name || "<your name>"}" ${pair.publicKey}`;
    new Setting(containerEl).setName("This device's key").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "A message counts as yours only when it's signed with a key the agents' machines trust. Run this command on each machine that runs a relay. The private half of the key stays on this device and never syncs.",
    });
    containerEl.createEl("pre", { cls: "agent-rooms-key", text: trust });
    new Setting(containerEl)
      .addButton((button) => button.setButtonText("Copy command").setCta().onClick(async () => {
        await navigator.clipboard.writeText(trust);
        new Notice("Copied. Run it on each machine that runs a relay.");
      }))
      .addButton((button) => button.setButtonText("Make a new key").setWarning().onClick(async () => {
        await plugin.replaceKey();
        new Notice("This device has a new key. Trust it on each relay machine; the old one still works there until removed.");
        this.display();
      }));

    new Setting(containerEl)
      .setName("Your other devices' keys")
      .setDesc("One public key per line, from this setting on your other devices. Messages you post there then show as verified here too.")
      .addTextArea((area) => {
        area.setValue(plugin.settings.otherKeys.join("\n")).onChange(async (value) => {
          plugin.settings.otherKeys = value.split(/\s+/).map((key) => key.trim()).filter((key) => /^[A-Za-z0-9_-]{80,100}$/.test(key));
          await plugin.saveSettings();
        });
        area.inputEl.rows = 3;
        area.inputEl.addClass("agent-rooms-keys");
      });
    containerEl.createEl("p", { cls: "setting-item-description", text: `This device's public key: ${pair.publicKey}` });
  }
}
