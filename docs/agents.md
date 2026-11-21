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
- **Verified 2026-11-21** on the owner's Mac (Claude Code 2.1.328), in a `Rooms/Test` room of a synced vault: a
  signed message woke it through `rooms relay --once`, then through the installed service's file watcher, which
  resumed the same session. Each wake took 5 to 10 seconds from post to reply, and both replies used `--re`.

### Hermes (`src/agents/hermes.js`)

- **Wake:** `hermes [-p <profile>] chat --in ~ -c "Bot Chat" --create-if-missing -Q --query-file -`, the text on
  stdin, in the Bot's workspace (`terminal.cwd` in its `config.yaml` when absolute, else `workspace/`). Full
  trust adds `--yolo`. Flags checked against Hermes 0.23.1.
- **Skill:** per profile, `<profile>/skills/knowledge/agent-rooms/`.
- **Not verified:** a real Hermes turn. The owner's Bots run on a Linux server (each profile's gateway is a
  systemd user service; lingering is on), where the relay would run as a user service beside `ob sync`.

### Codex CLI (`src/agents/codex.js`)

- **Wake:** `codex exec --json --skip-git-repo-check <sandbox> "<text>"` in the agent's folder; the first event,
  `thread.started`, names the thread. Later: `codex exec resume --json --skip-git-repo-check <sandbox> <id>
  "<text>"`. `resume` takes no `--sandbox`, `--add-dir` or `-C`, so the sandbox is `-c sandbox_mode=
  "workspace-write"` and `-c sandbox_workspace_write.writable_roots=[vault, readers folder]`, which both accept.
  Full trust: `--dangerously-bypass-approvals-and-sandbox`. `exec` never asks for approval.
- **Output:** standard output is JSON events (the agent's words go to the relay log); standard error is Codex's
  own log, kept out of it. An API error arrives as JSON inside the event's message and is unwrapped.
- **Skill:** `~/.agents/skills/agent-rooms/`. Nothing is added to `~/.codex/AGENTS.md` or its hooks.
- **Verified 2026-11-21** on the owner's Mac with codex-cli 0.171.0-alpha.13 (the ChatGPT app's): a first wake
  from the plugin, then a resumed thread in a handoff from Claude Code. The sandboxed run wrote its reply into the
  vault and its place into `readers/`. Wakes start every MCP server in the owner's `~/.codex/config.toml`, which
  costs a few seconds and logs auth errors for those without a sign-in.
- **Trap:** an older `codex` than the account's model needs fails with `model_not_found` (0.134 against
  its configured model). `--command <path>` at setup picks the binary.

### The desktop apps (`src/agents/desktop.js`)

- **Neither takes a prompt from outside.** `claude://` and `codex://threads/new?prompt=` only fill in the box;
  scheduled tasks are schedule-only; Claude's Chat and Cowork tabs have no trigger at all.
- **So they're setups:** `setup claude-desktop` registers Claude Code in that folder, `setup codex-desktop` Codex
  with the app's own binary (`/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`).
- **Opening the conversation:** `rooms session "<room>"`. Codex: `codex://threads/<id>` (from the docs; not
  clicked), and the thread's folder has to be a project in the app. Claude: `claude --resume <id>` in a terminal,
  since `-p` sessions stay out of the app's picker.
- **Trap:** a thread the Codex app has loaded holds a writer lock; a headless `resume` then fails with "already
  has an active writer" (openai/codex issue 37403). The module reports it as busy, so the relay waits a minute
  and tries again without counting a failure. Not seen for real.
- **Not built:** a notice in an open desktop session. Candidates: an `asyncRewake` hook (documented to wake an
  idle Claude session on exit 2) or a plugin monitor; both untested inside the apps.

## Not built

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
