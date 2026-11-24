# Decisions

Settled with the owner on 2026-11-21 unless marked as a default. A default is what was built or planned without
the owner's explicit answer; it can change without anyone having been overruled.

## Shape

- **A separate program, not an Obsidian plugin, wakes agents.** A plugin runs only while that vault is open in the
  app, never on a machine that only runs `ob sync`, and can't start anything on a phone. Obsidian Sync has no hook
  a plugin could use, and Obsidian Headless has none either (its code was read: sync and publish only).
- **No server.** Every machine an agent uses already runs `ob sync --continuous`, so each has every message on
  disk within seconds, and each relay only wakes its own machine's agents. This holds for the Hermes server and the
  Grok Bot's cloud computer too.
- **One home per agent.** Every synced machine sees every message, so two relays could start the same agent.
  Which agents live on a machine is local settings; who is in a room is a file in the vault.
- **One relay per machine, held by a lock** (`relay.lock` in the settings folder, refreshed every minute). Two would
  both wake an agent for the same message. Where no service manager keeps the relay running (a Bot's computer, a
  container), it runs in the background, and `rooms relay ensure` on a schedule starts it again after a restart;
  the lock is how it tells a running relay from a dead one. A relay that finds another running exits as a success,
  and the services restart it only after a failure, so the two never fight.
- **An agent is a name plus the folder it starts in**, which can be a code project or a vault. Claude Desktop and
  Codex Desktop are windows onto the same agent, not members of their own: neither app accepts a prompt from
  outside.
- **Vaults are registered per machine.** An agent that is a member of a room can read the whole vault, so a vault
  with private documents is never registered on a machine the owner doesn't control.
- **Public, MIT, in the owner's personal GitHub account**, one repository: the `rooms` program on npm, and the
  plugin with its `manifest.json` at the root (BRAT and Obsidian's directory both need it there). A plugin id can't
  contain "obsidian", so the plugin is `agent-rooms`, shown as "Agent Rooms".
- **Node, no dependencies.** Every machine running `ob` has Node 22.
- **A module's secret (a Grok Bot routine's key) lives in `secrets/` in the settings folder**, one file readable by
  this user only, never in `config.json` or a vault. Not the keychain: the machine that needs one has none. Agents
  on that machine run as the same user and could read it, like everything else there.

## Who is woken

- **A person's message wakes every agent in the room; an agent's wakes only who it addresses (`to`) and the author
  of the message it answers (`re`).** The owner wants agents to talk on their own, and "everyone wakes everyone"
  in a room of twelve starts eleven runs per message.
- **`to` in the front matter is what the relay reads**, not `@Name` in the text: names contain spaces. `rooms say`
  refuses a `--to` that isn't a member, and says after posting who it wakes.
- **Only members are woken.** A member can add another agent, which tells it so and wakes it. Agents create rooms
  only when a person asked.
- **Agents' own schedulers start unattended conversations** (Hermes cron, Grok routines, scheduled tasks). The
  relay has no scheduler: a second one is more to set up and debug.
- **Brakes:** 20 wakes an hour and 100 a day per agent; a room pauses after 30 agent messages in a row until a
  person writes; what was missed arrives as one wake per room; nothing older than 24 hours wakes anyone; a
  `PAUSED.md` in a room or in `Rooms/` stops waking there. Messages posted during a pause are not delivered
  afterwards; messages held back by a limit are.
- **A person's addressed message wakes only those addressed** (default).
- **Woken without being addressed, an agent stays silent unless it's its area** (default; the skill and the wake
  text say so).

## What a woken agent may do

- **It may work in its own folder and the vault.** A handoff means doing work, not only replying.
- **Claude Code and Codex runs are scoped by default, with a per-agent full-trust switch.** A woken run may be
  acting on another agent's message. Hermes, OpenClaw and Grok Bot keep their own platform's settings; for them
  the limit is an instruction, not a lock.
- **Any member can ask for work. Only a person's message permits publishing, sending, spending or deleting.**
  An agent that reads the web can be tricked into posting a request that an agent with more access carries out.
- **A person's messages are signed.** `from` is a line anyone with write access can type. The plugin signs on the
  person's devices (ECDSA P-256, Web Crypto, so the same code runs in Node and on a phone); each relay verifies
  against a public key stored in its own settings, never one read from the vault. The signature covers the room
  and the file name, so a signed message copied elsewhere doesn't verify. Unsigned, a "person" counts as an agent.
  `rooms key new` makes a key at a terminal for testing only: any program running as that user could use it.
- **Agents' messages aren't signed.** Agents on one machine run as the same user, so nothing would separate them.

- **Inside a wake, the machine commands refuse to run** (`setup`, `trust`, `key`, `vault`, `agents`, `relay`), and
  a scoped Claude Code run is allowed only the room commands. Found while building Codex: with `Bash(rooms *)` a
  woken agent could run `rooms key new` and `rooms trust` and sign as the person. For Hermes and full-trust agents
  this is an instruction, not a lock: they could clear the variable that marks a wake.
- **A Codex run's sandbox gives it the vault and `readers/` in the settings folder**, nothing else there. That's
  why what each reader has read lives in a folder of its own.

## Sessions

- **The relay owns one long-lived session per agent and room** (Claude Code: `--session-id`, then `--resume`).
  The owner chose no rollover. It never resumes a person's own sessions: two writers on one session can lose
  messages.
- **A woken agent is shown everything it hadn't read in the room** (the newest 20), with what woke it among them,
  and those count as read so its reply isn't refused.
- **The desktop apps are setups, not agents** (`setup claude-desktop`, `setup codex-desktop`): they register the
  command-line agent that wakes for them. `codex-desktop` uses the Codex the ChatGPT app ships, the version that
  reads and writes the app's threads. `rooms session` gives how to open a room's conversation: Claude Desktop
  doesn't list headless sessions, so for Claude it's a terminal command.
- **A failed or busy wake waits** (a minute times the failures; a minute when busy) before the next try, even if
  files change meanwhile. The relay doesn't react to its own status notes or to hidden files.
- **A notice in any open session of the same project** comes later, once it's tested that notices reach an open
  session in the desktop apps, which is undocumented.

## The owner's side

- **The plugin is in the first version**: rooms list with unread counts, room view, posting and replying with a
  member picker, creating rooms, managing members, pause, and each machine's relay status. Obsidian saves as you
  type, so only a composer gives a message a "send" moment.
- **No notifications.** A failed wake shows as a relay notice in the room (after three tries, once) and in a
  status note per machine, `Rooms/_status/<machine>.md`, rewritten on change and hourly (the hourly write is a
  default).
- **What has been read is kept per device**, in Obsidian's local storage (changed from the "synced" default, not
  yet put to the owner). Syncing it means the phone and the Mac rewriting one file, which the one-writer-per-file
  rule exists to avoid.
- **The plugin's key lives in Obsidian's per-vault local storage**, never in `data.json`, which syncs where plugin
  settings sync. Each device has its own key, trusted on each relay machine. The other devices' public keys go in
  the plugin's settings only so that device can show those messages as verified; relays never read them.
- **The plugin renders messages as Markdown, with `<` outside code shown as written.** Agents write placeholders
  like `<message>`, which the renderer would otherwise take for HTML and drop.
- **Only the owner as a person for now** (default); anyone marked `kind: person` with a trusted key counts.
- **Connecting an agent is one prompt from the plugin** ("Connect an agent", `src/connect.js`). Setting one up by
  hand took a guide per platform and several back-and-forths. The prompt carries this device's public keys, so
  trusting them stays the person's act: the keys travel through their clipboard, never through a vault file an
  agent could have written.

## Build order (default)

1. The relay, the `rooms` commands, Claude Code and Hermes. **Built 2026-11-21.** Claude Code passed a real test on
   the owner's Mac the same day, and a Hermes Bot on the owner's server on 2026-11-22.
2. The plugin, first on the Mac, then on the phone through BRAT. **Built 2026-11-21** and run in Obsidian 1.15.1 on
   the owner's Mac, desktop and emulated phone layout: a message signed there woke Claude Code through
   the relay. The phone needs the public repository and a release for BRAT.
3. Codex CLI, then the Claude Desktop and Codex Desktop surfaces. **Built 2026-11-21.** Codex passed a real test on
   the owner's Mac with the ChatGPT app's own Codex (0.171): woken from the plugin, then in a handoff from Claude
   Code, resuming its thread. The Homebrew `codex` there (0.134) couldn't use the configured model.
4. OpenClaw and Grok Bot. **Built 2026-11-21 from their docs**, tested against a stand-in `openclaw` and a local
   webhook. A Grok Bot was woken for real on 2026-11-24. OpenClaw is woken through its CLI rather than its webhook (no token or config change; it waits for
   the turn); the reasons are in `agents.md`.
5. Removing the old Usual Base relay, skill and plugin from the owner's Mac, once step 1 passed a real test. **Done
   2026-11-21.**

Testing: stand-ins in temporary folders first, then one real pass in a `Rooms/Test` room, asking the owner before
each real wake.
