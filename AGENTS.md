Rooms where a person and their agents talk, as Markdown files in an Obsidian vault. Obsidian Sync carries the
files; a relay on each machine wakes the agents a message is for. Code is the source of truth; `docs/` holds what
the code can't show.

## What it won't compromise on

- **No server.** Every machine with agents runs `ob sync --continuous` and one relay. Nothing else is shared.
- **One file per message.** Nobody edits anyone else's file, so sync never merges and nothing conflicts.
- **Nothing private in a vault.** Settings, read positions, sessions and keys stay in `~/.config/agent-rooms/`.
  The only things the program writes into a vault are rooms, members, messages, `PAUSED.md` and the status notes.
- **A name isn't proof.** A message is a person's only with a signature this machine trusts; otherwise it wakes and
  permits what an agent's would.
- **Plain.** Text says what happened and what to do next.

## Ways to hurt yourself

1. **Testing against a real vault.** Every change in one reaches the owner's phone in seconds, and a real wake
   spends their usage. Tests run in temporary folders with `test/stub-agent.mjs`; a real vault or a real agent
   needs the owner's go-ahead each time.
2. **Node APIs in `src/format.js`, `src/sign.js`, `src/policy.js` or `plugin/`.** The plugin bundles them and runs
   on phones. `npm run build` must leave only `require("obsidian")` in `main.js`.
3. **Writing a message in place.** Sync uploads half a file. Use `writeWhole` (hidden name, then rename).
4. **Trusting file events.** They only mean "look now". What's new is decided from saved state (`relay.json`).

5. **`activeWindow` in Obsidian 1.15.** Settings opens as its own window, and a modal opens in whichever window was
   active. A script that opens Settings and doesn't close it sends later modals there, out of sight.
6. **`obsidian dev:screenshot` can show the frame before a change** while the window is in the background. Take it
   twice, or read the DOM with `obsidian eval`.

## Verifying

- `npm test`: the format, signatures and wake rules as units; the commands and the relay end to end with
  stand-in agents, each test in its own temporary home.
- A bug gets a test that fails first. Wake rules go in `test/format.test.js` (pure), behaviour in
  `test/rooms.test.js`.
- `rooms relay --once` looks once and waits for the wakes it started: how tests drive the relay.
- The plugin: `npm run check`, then in a vault the owner has agreed to: copy `main.js`, `manifest.json` and
  `styles.css` into `.obsidian/plugins/agent-rooms/`, and drive it with the Obsidian CLI (`obsidian
  plugin:reload id=agent-rooms`, `eval`, `dev:errors`, `dev:screenshot`, `dev:mobile` for the phone layout).

## Knowledge index

- [docs/decisions.md](docs/decisions.md): the design decisions and their reasons.
- [docs/agents.md](docs/agents.md): how each agent platform is woken and set up, what's built, and what was only
  read in docs.
- [docs/setup.md](docs/setup.md): the person's guide to setting up each agent, with prompts to paste. When setup
  or a module's flags change, update it in the same change.
- `plugin/`: the Obsidian plugin. `store.js` reads and writes rooms through Obsidian's file adapter (tested in
  `test/plugin.test.js` over a file system adapter); `view.js`, `modals.js` and `main.js` are the app side.
- [skill/agent-rooms/SKILL.md](skill/agent-rooms/SKILL.md): the agents' manual. When anything agents rely on
  changes (the files, the commands, who is woken), update it in the same change.

## Documentation

Keep decisions with their reasons, traps, and what hasn't been verified. When a decision changes, rewrite the
text; don't append. Before adding a paragraph, ask what a maintainer would get wrong without it.
