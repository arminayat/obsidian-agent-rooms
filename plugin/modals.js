// The plugin's dialogs: starting a room, a room's members, connecting a new agent, and what each machine's relay
// last did.

import { MarkdownRenderer, Modal, Notice, Setting, moment, setIcon } from "obsidian";
import { CONNECT_KINDS, connectPrompt } from "../src/connect.js";
import { sameName } from "../src/format.js";

const STALE_MS = 2 * 3_600_000; // a relay rewrites its note at least hourly, so two hours without one means trouble

/** Agent names already used in this vault's rooms: what the pickers suggest. */
async function knownAgents(store) {
  const names = [];
  for (const room of await store.rooms()) {
    for (const member of await store.members(room)) {
      if (member.kind === "agent" && !names.some((name) => sameName(name, member.name))) names.push(member.name);
    }
  }
  return names.sort((a, b) => a.localeCompare(b));
}

export class NewRoomModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  async onOpen() {
    const { contentEl, plugin } = this;
    this.setTitle("New room");
    let name = "";
    let about = "";
    const chosen = new Set();
    new Setting(contentEl).setName("Name").addText((text) => {
      text.setPlaceholder("Launch").onChange((value) => (name = value));
      window.setTimeout(() => text.inputEl.focus());
    });
    new Setting(contentEl).setName("What it's for").setDesc("Agents read this when they're added.")
      .addTextArea((area) => area.setPlaceholder("Getting 1.0 out").onChange((value) => (about = value)));
    const agents = await knownAgents(plugin.store);
    if (agents.length) {
      new Setting(contentEl).setName("Agents").setDesc("They become members. Nobody is woken until a message is posted.").setHeading();
      for (const agent of agents) new Setting(contentEl).setName(agent).addToggle((toggle) => toggle.onChange((on) => (on ? chosen.add(agent) : chosen.delete(agent))));
    }
    new Setting(contentEl).addButton((button) => button.setButtonText("Start the room").setCta().onClick(async () => {
      try {
        const room = await plugin.store.createRoom(name.trim(), about.trim());
        if (plugin.settings.name) await plugin.store.addMember(room, { name: plugin.settings.name, kind: "person" });
        for (const agent of chosen) await plugin.store.addMember(room, { name: agent, kind: "agent", addedBy: plugin.settings.name });
        this.close();
        await plugin.open(room);
      } catch (error) {
        new Notice(error.message);
      }
    }));
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class MembersModal extends Modal {
  constructor(plugin, room) {
    super(plugin.app);
    this.plugin = plugin;
    this.room = room;
  }

  onOpen() {
    this.setTitle(`Members of ${this.room}`);
    this.draw();
  }

  async draw() {
    const { contentEl, plugin, room } = this;
    const store = plugin.store;
    contentEl.empty();
    const members = await store.members(room);
    if (!members.length) contentEl.createEl("p", { text: "Nobody is a member yet." });
    for (const member of members) {
      new Setting(contentEl)
        .setName(member.name)
        .setDesc(member.kind === "person" ? "Person" : "Agent: woken by your messages, and by agents that address it")
        .addExtraButton((button) => button.setIcon("user-minus").setTooltip("Remove from the room").onClick(async () => {
          await store.removeMember(room, member.name);
          plugin.refresh();
          this.draw();
        }));
    }

    const name = plugin.settings.name;
    if (name && !members.some((m) => sameName(m.name, name))) {
      new Setting(contentEl).setName(`Join as ${name}`).setDesc("As a person, your signed messages wake every agent here.")
        .addButton((button) => button.setButtonText("Join").onClick(async () => {
          await store.addMember(room, { name, kind: "person" });
          plugin.refresh();
          this.draw();
        }));
    }

    new Setting(contentEl).setName("Add an agent").setHeading();
    new Setting(contentEl).setName("A new agent").setDesc("Not set up on its machine yet? Get one prompt that sets it up and joins it here.")
      .addButton((button) => button.setButtonText("Connect an agent").onClick(() => {
        this.close();
        new ConnectModal(plugin, room).open();
      }));
    let agent = "";
    let tell = true;
    const suggestions = (await knownAgents(store)).filter((known) => !members.some((m) => sameName(m.name, known)));
    new Setting(contentEl).setName("Its name in rooms").setDesc("As it was set up on its machine, for example \"Claude Code in api\".")
      .addText((text) => {
        text.onChange((value) => (agent = value.trim()));
        if (suggestions.length) {
          const list = contentEl.createEl("datalist", { attr: { id: "agent-rooms-agents" } });
          for (const known of suggestions) list.createEl("option", { attr: { value: known } });
          text.inputEl.setAttr("list", "agent-rooms-agents");
        }
      });
    new Setting(contentEl).setName("Tell it in the room").setDesc("Posts a message to it, which wakes it.")
      .addToggle((toggle) => toggle.setValue(true).onChange((on) => (tell = on)));
    new Setting(contentEl).addButton((button) => button.setButtonText("Add").setCta().onClick(async () => {
      if (!agent) return new Notice("Write the agent's name first.");
      if (!(await store.addMember(room, { name: agent, kind: "agent", addedBy: name }))) return new Notice(`${agent} is already a member.`);
      if (tell && name) {
        const paths = await store.messagePaths(room);
        await store.post(room, { from: name, to: [agent], seen: paths.at(-1)?.split("/")[1] ?? "" },
          "I added you to this room. Read ROOM.md and the recent messages to see what it's for.", plugin.signer(await plugin.key()));
      }
      plugin.refresh();
      this.draw();
    }));
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** One prompt that sets a new agent up on its machine, with this device's keys in it. */
export class ConnectModal extends Modal {
  constructor(plugin, room = "") {
    super(plugin.app);
    this.plugin = plugin;
    this.choice = { kind: "claude-code", name: "", room };
  }

  async onOpen() {
    const { contentEl, plugin, choice } = this;
    this.setTitle("Connect an agent");
    contentEl.addClass("agent-rooms-connect");
    if (!plugin.settings.name) {
      contentEl.createEl("p", { text: "First set your name in rooms: the prompt makes the agent trust your messages under it." });
      new Setting(contentEl).addButton((button) => button.setButtonText("Open settings").setCta().onClick(() => {
        this.close();
        plugin.openSettings();
      }));
      return;
    }
    const rooms = await plugin.store.rooms();
    const keys = [(await plugin.key()).publicKey, ...plugin.settings.otherKeys.filter(Boolean)];
    const folder = typeof this.app.vault.adapter.getBasePath === "function" ? this.app.vault.adapter.getBasePath() : "";

    let paste;
    let preview;
    let nameText;
    const draw = () => {
      const kind = CONNECT_KINDS[choice.kind];
      paste.setText(kind.paste);
      nameText.setPlaceholder(kind.needsName ? "Required, for example Scout" : "Optional: its setup names it");
      preview.setText(kind.needsName && !choice.name.trim() ? "Give it a name in rooms first." : this.prompt(keys, folder));
    };

    new Setting(contentEl).setName("Agent").addDropdown((dropdown) => {
      for (const [kind, { label }] of Object.entries(CONNECT_KINDS)) dropdown.addOption(kind, label);
      dropdown.setValue(choice.kind).onChange((kind) => {
        choice.kind = kind;
        draw();
      });
    });
    new Setting(contentEl).setName("Its name in rooms").addText((text) => {
      nameText = text;
      text.onChange((value) => {
        choice.name = value;
        draw();
      });
    });
    new Setting(contentEl).setName("Room to join").addDropdown((dropdown) => {
      dropdown.addOption("", "None yet");
      for (const room of rooms) dropdown.addOption(room, room);
      dropdown.setValue(rooms.includes(choice.room) ? choice.room : "").onChange((room) => {
        choice.room = room;
        draw();
      });
    });
    paste = contentEl.createEl("p", { cls: "setting-item-description" });
    preview = contentEl.createEl("pre", { cls: "agent-rooms-prompt" });
    new Setting(contentEl).addButton((button) => button.setButtonText("Copy prompt").setCta().onClick(async () => {
      if (CONNECT_KINDS[choice.kind].needsName && !choice.name.trim()) return new Notice("Give it a name in rooms first.");
      await navigator.clipboard.writeText(this.prompt(keys, folder));
      new Notice("Copied. Paste it into the agent.");
    }));
    draw();
  }

  prompt(keys, folder) {
    const { plugin, choice } = this;
    return connectPrompt({ ...choice, vault: this.app.vault.getName(), folder, person: plugin.settings.name, keys });
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class RelaysModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.component = null;
  }

  async onOpen() {
    const { contentEl, plugin } = this;
    this.setTitle("Relays");
    contentEl.addClass("agent-rooms-relays");
    contentEl.createEl("p", { cls: "setting-item-description", text: "Each machine that runs a relay writes what it last did here, at least once an hour." });
    const relays = await plugin.store.relays();
    if (!relays.length) {
      contentEl.createEl("p", { text: "No relay has written to this vault yet. On each machine with agents: rooms relay install" });
      return;
    }
    for (const relay of relays) {
      const section = contentEl.createDiv({ cls: "agent-rooms-relay" });
      const head = section.createDiv({ cls: "agent-rooms-relay-head" });
      const stale = Number.isNaN(relay.updated) || Date.now() - relay.updated > STALE_MS;
      setIcon(head.createSpan({ cls: stale ? "agent-rooms-stale" : "agent-rooms-fresh" }), stale ? "alert-triangle" : "check-circle");
      head.createSpan({ cls: "agent-rooms-relay-machine", text: relay.machine });
      head.createSpan({ cls: "agent-rooms-time", text: Number.isNaN(relay.updated) ? "never" : `updated ${moment(relay.updated).fromNow()}` });
      if (stale) section.createDiv({ cls: "agent-rooms-banner", text: "No sign of life for over two hours: the relay or the machine may be off, or its sync stopped." });
      const body = section.createDiv({ cls: "markdown-rendered" });
      await MarkdownRenderer.render(this.app, relay.body.replace(/^# .*\n+/, ""), body, relay.file, plugin);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
