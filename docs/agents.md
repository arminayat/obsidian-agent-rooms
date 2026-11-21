# Agents: how each is woken and set up

How to set each one up is in [setup.md](setup.md).

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

### OpenClaw (`src/agents/openclaw.js`; docs only, OpenClaw isn't installed on the owner's Mac)

- **Wake:** `openclaw agent --agent <id> --session-key rooms-<room> --message-file <file> --json --timeout 1800`
  in the agent's workspace, through the local Gateway; the key routes to `agent:<id>:rooms-<room>`. The text goes
  in a file under `outbox/` in the settings folder, removed after the turn. A refused connection is reported as
  "the Gateway isn't running"; 429 or 503 in the output as busy.
- **Why not the webhook** (`POST /hooks/agent` with a hook token and `sessionMode: "persistent"`): it needs
  `hooks.enabled`, a token, `allowRequestSessionKey` and a prefix allowlist written into OpenClaw's config, where an
  unknown key stops the Gateway; and it returns on admission, not completion. The CLI needs neither. Its input
  counts as operator input, not wrapped as untrusted, the same as a Claude Code or Codex prompt.
- **Setup:** registers the id (`main` by default) with its workspace (`~/.openclaw/workspace`, or
  `workspace-<id>`), and copies the skill into `<workspace>/skills/`, the first place OpenClaw loads skills from.
  Nothing in `~/.openclaw/openclaw.json` changes.
- **Not verified:** that `--message-file` and `--session-key` behave as documented, and that a turn may write the
  vault: `tools.fs.workspaceOnly` defaults to off, but issues #30927 and #40334 report builds that blocked writes
  outside the workspace. Facts are from v2026.11.6.

### Grok Bot (`src/agents/grok-bot.js`; docs only, never tried with a real Bot)

- **Wake:** `POST <the routine's "POST to" address>` with `Authorization: Bearer <key>` and a JSON body: `source`,
  `room`, `vault`, `you`, `addressed`, and `text`, the same wake text as other agents but with the full path of
  `rooms` and `--as "<name>"`, since the Bot runs the command outside the relay's environment. 200 means a run
  started; 429 is waited out; 401 or 403 means the key is wrong.
- **Where:** the relay runs on the Bot's own computer (a Debian microVM per user, shared by their Bots), where the
  owner says `ob sync --continuous` already runs. Bots there share `/workspace`, so the routine's address tells
  their setups apart.
- **Setup:** the person asks the Bot to create a routine whose instruction (in `docs/setup.md`) makes the body a
  request; setup stores the address in the settings and the key in `secrets/` (one file, this user only). The
  skill is copied to `/workspace/agent-rooms-skill/` for the Bot to save in chat. An "Always allow" rule for
  `rooms` keeps replies from waiting on auto-review, whose cards expire in 30 minutes.
- **Not verified:** everything that touches the Bot: the body reaching the run, the Bot running `rooms`, and
  whether a systemd user service (the relay) runs on that computer at all. Updates and resets remove installed
  packages, so the install lives in `/workspace`.
