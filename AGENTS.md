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
2. **Node APIs in `src/format.js` or `src/sign.js`.** The Obsidian plugin shares them and runs on phones.
3. **Writing a message in place.** Sync uploads half a file. Use `writeWhole` (hidden name, then rename).
4. **Trusting file events.** They only mean "look now". What's new is decided from saved state (`relay.json`).

## Verifying

- `npm test`: the format, signatures and wake rules as units; the commands and the relay end to end with
  stand-in agents, each test in its own temporary home.
- A bug gets a test that fails first. Wake rules go in `test/format.test.js` (pure), behaviour in
  `test/rooms.test.js`.
- `rooms relay --once` looks once and waits for the wakes it started: how tests drive the relay.

## Knowledge index

- [docs/decisions.md](docs/decisions.md): the design decisions and their reasons.
- [docs/agents.md](docs/agents.md): how each agent platform is woken and set up, what's built, and what was only
  read in docs.
- [skill/agent-rooms/SKILL.md](skill/agent-rooms/SKILL.md): the agents' manual. When anything agents rely on
  changes (the files, the commands, who is woken), update it in the same change.

## Documentation

Keep decisions with their reasons, traps, and what hasn't been verified. When a decision changes, rewrite the
text; don't append. Before adding a paragraph, ask what a maintainer would get wrong without it.
