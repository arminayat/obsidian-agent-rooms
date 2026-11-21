# Agents: how each is woken and set up

What's built, and for the rest what was learned on 2026-11-21 from each tool's own help on the owner's Mac or from
its docs. "Docs only" means nobody has run it.

## Built

### Claude Code (`src/agents/claude-code.js`)

- **Wake:** `claude -p <text> --session-id <uuid>` the first time, `--resume <uuid>` after, in the agent's folder,
  with `--add-dir <vault>`. Scoped: `--permission-mode acceptEdits --allowedTools "Bash(rooms *)"`; full trust:
  `--dangerously-skip-permissions`. Flags checked against Claude Code 2.1.328.
- **Known from the docs:** in `-p`, a call that needs approval is denied; project hooks run; plugin monitors don't.
  Resuming one session from two processes can lose messages. A missing session ends in "No conversation found",
  after which the module starts a new one.
- **Skill:** `~/.claude/skills/agent-rooms/`.
- **Not verified:** a real wake with this program. (The same command woke Claude Code for real in the owner's
  earlier project.)

### Hermes (`src/agents/hermes.js`)

- **Wake:** `hermes [-p <profile>] chat --in ~ -c "Bot Chat" --create-if-missing -Q --query-file -`, the text on
  stdin, in the Bot's workspace (`terminal.cwd` in its `config.yaml` when absolute, else `workspace/`). Full
  trust adds `--yolo`. Flags checked against Hermes 0.23.1.
- **Skill:** per profile, `<profile>/skills/knowledge/agent-rooms/`.
- **Not verified:** a real Hermes turn. The owner's Bots run on a Linux server (each profile's gateway is a
  systemd user service; lingering is on), where the relay would run as a user service beside `ob sync`.

## Not built

### Claude Desktop

- Its Code tab runs its own copy of Claude Code; each desktop session records a `cliSessionId`. Personal skills
  and plugins load there as in the CLI.
- **Nothing pushes a prompt in.** `claude://` links only prefill. Scheduled tasks are schedule-only and need the
  app open. The Chat and Cowork tabs have no trigger at all.
- **Plan:** the Claude Code wake does the work; the app's `/resume` picker lists CLI sessions, so the conversation
  can be opened there. For an open session: an `asyncRewake` hook (documented to wake an idle session on exit 2)
  or a plugin monitor, once tested inside the app.

### Codex CLI

- **Wake:** `codex exec --json -C <folder> --sandbox workspace-write --add-dir <vault> "<text>"`, reading
  `thread_id` from the `thread.started` event; then `codex exec resume <thread id> "<text>"`. Flags present in
  codex-cli 0.134. `exec` defaults to a read-only sandbox and never asks for approval.
- **Skill:** `~/.agents/skills/`; standing instructions in `~/.codex/AGENTS.md`; hooks in `~/.codex/hooks.json`
  (must be reviewed and trusted once).
- **Not verified:** whether `--sandbox` and `--add-dir` are accepted after `resume`; `writable_roots` in
  `config.toml` is the fallback.

### Codex Desktop (inside ChatGPT.app)

- Shares `~/.codex` with the CLI. **Nothing pushes a turn in:** `codex://threads/new?prompt=` only prefills, the
  app doesn't share the app-server daemon, and scheduled tasks are schedule-only.
- `codex://threads/<id>` opens a thread; the thread's folder has to be a project in the app.
- **Trap:** a thread the app has loaded holds a writer lock, and a headless `resume` then fails with "already has
  an active writer" (openai/codex issue 37403, open). The module should report that as busy, so the relay retries.

### OpenClaw (docs only; not installed on the owner's Mac)

- **Wake:** `POST http://127.0.0.1:18789/hooks/agent` with `Authorization: Bearer <hook token>` and
  `{ message, name, agentId, sessionKey: "hook:rooms:<room>", sessionMode: "persistent", deliver: false }`.
  200 with a `runId` means admitted; 429 carries `Retry-After`. Hook content is wrapped as untrusted.
- **Setup:** `hooks.enabled`, a dedicated `hooks.token`, `allowedAgentIds`, `allowRequestSessionKey: true`,
  `allowedSessionKeyPrefixes: ["hook:"]` in `~/.openclaw/openclaw.json`; they reload without a restart.
- **Skill:** `~/.agents/skills/` or `<workspace>/skills/`.
- Facts are from v2026.11.6; agents moved from `agents.list[]` to `agents.entries.<id>`, so check the version.

### Grok Bot (docs only; never tried with a real Bot)

- Lives on its own cloud computer, where the owner says `ob sync --continuous` already runs. So its relay runs
  there too and calls the Bot's routine webhook: `POST <the routine's "POST to" address>` with
  `Authorization: Bearer <key>` and a JSON body; 200 means a run started. Limit: 200 runs an hour per routine.
- Routines are created by asking the Bot in chat; its address and key are copied from the routine's details.
  Setup therefore goes through a prompt the owner pastes.
- Updates and resets of that computer remove installed packages; `/workspace` survives. The relay has to be kept
  running the same way `ob sync` is.
- Unattended commands pass an auto-review; an "Always allow" rule for `rooms` keeps runs from waiting.
