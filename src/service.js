// The relay as a login service, so it's running whenever this user is logged in: launchd on a Mac, a systemd
// user service on Linux. `rooms relay install | ensure | uninstall | status`; --dry-run prints what would be written.
// Where neither works (a container, a Bot's computer), the relay runs in the background until the machine restarts,
// and `rooms relay ensure`, run on a schedule, starts it again.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { configDir, loadConfig, readJson } from "./config.js";
import { fail, shown } from "./core.js";
import { binDir, which } from "./agents/shared.js";
import { moduleFor } from "./agents/index.js";
import { runningRelay } from "./lock.js";

const LABEL = "com.github.arminayat.agent-rooms.relay";
export const relayLog = () => join(configDir(), "relay.log");

/**
 * The Node to start the relay with. `process.execPath` has its links resolved, so it can point inside another
 * app's bundle (Hermes ships one) that moves on update; the `node` on the PATH is kept when it's the same program.
 */
function nodePath() {
  const found = which("node");
  try {
    if (found && realpathSync(found) === realpathSync(process.execPath)) return found;
  } catch {}
  return process.execPath;
}

/** How the relay is started, and the environment it gets: the agents' commands on its PATH. */
function relayCommand() {
  const node = nodePath();
  const commands = loadConfig().agents.map((agent) => moduleFor(agent)?.found()).filter(Boolean).map((command) => dirname(command));
  const env = {
    PATH: [...new Set([binDir, dirname(node), ...commands, join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"])].join(":"),
    ...(process.env.AGENT_ROOMS_HOME ? { AGENT_ROOMS_HOME: process.env.AGENT_ROOMS_HOME } : {}),
    ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}),
  };
  return { args: [node, join(binDir, "rooms"), "relay"], env };
}

function unit() {
  const { args, env } = relayCommand();
  if (process.platform === "darwin") {
    const file = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
    const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join("")}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(relayLog())}</string>
  <key>StandardErrorPath</key><string>${xml(relayLog())}</string>
</dict>
</plist>
`;
    const domain = `gui/${process.getuid()}`;
    return { file, text, start: [["launchctl", "bootout", domain, file], ["launchctl", "bootstrap", domain, file]], stop: [["launchctl", "bootout", domain, file]] };
  }
  if (process.platform === "linux") {
    const name = "agent-rooms-relay.service";
    const file = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", name);
    const quote = (s) => `"${s.replace(/(["\\])/g, "\\$1")}"`;
    const text = `[Unit]
Description=Agent Rooms relay: wakes agents when a room message is for them

[Service]
ExecStart=${args.map(quote).join(" ")}
${Object.entries(env).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`).join("\n")}
Restart=on-failure
StandardOutput=append:${relayLog()}
StandardError=append:${relayLog()}

[Install]
WantedBy=default.target
`;
    return { file, text, start: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", name], ["systemctl", "--user", "restart", name]],
      stop: [["systemctl", "--user", "disable", "--now", name]] };
  }
  return null;
}

/** Runs the service commands one after another; a failed one (stopping what isn't running) is fine. */
async function runAll(commands) {
  for (const [command, ...rest] of commands) {
    await new Promise((done) => spawn(command, rest, { stdio: "ignore" }).on("exit", done).on("error", done));
  }
}

/**
 * A systemd user service stops when its user's last session ends. Lingering keeps it running and starts it at
 * boot; it's turned on where that needs no password, and otherwise the command to run is printed.
 */
function lingering(enable) {
  if (process.platform !== "linux") return "";
  const user = userInfo().username;
  const state = spawnSync("loginctl", ["show-user", user, "--property=Linger", "--value"], { encoding: "utf8" });
  if (state.error || (state.status === 0 && state.stdout.trim() === "yes")) return "";
  if (enable && spawnSync("loginctl", ["--no-ask-password", "enable-linger"], { stdio: "ignore" }).status === 0) {
    return "Lingering is now on for your user, so the relay keeps running after you log out and starts at boot.";
  }
  return `The relay stops when you log out, since lingering is off for your user. To keep it running: sudo loginctl enable-linger ${user}`;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Waits up to ten seconds for a relay to hold the lock. */
async function cameUp() {
  for (let waited = 0; waited < 10_000; waited += 250) {
    if (runningRelay()) return true;
    await sleep(250);
  }
  return false;
}

/** Starts the relay on its own, outside any service manager: it runs until it's stopped or the machine restarts. */
function startDetached() {
  const { args: [node, ...args], env } = relayCommand();
  mkdirSync(configDir(), { recursive: true });
  const log = openSync(relayLog(), "a");
  spawn(node, args, { detached: true, stdio: ["ignore", log, log], env: { ...process.env, ...env } }).unref();
}

/** Stops a relay that runs outside the service (started by ensure, or by hand), so the service can take over. */
async function stopLoose() {
  const loose = runningRelay();
  if (!loose?.pid) return;
  try {
    process.kill(loose.pid, "SIGTERM");
  } catch {}
  for (let waited = 0; waited < 5_000 && runningRelay(); waited += 250) await sleep(250);
}

const ENSURE_NOTE = "After a restart, `rooms relay ensure` starts it again; it does nothing while the relay runs, so it's safe to run on a schedule.";

export async function installRelay(flags = {}) {
  const service = unit();
  if (flags["dry-run"]) {
    return console.log(service ? `Would write ${service.file}:\n\n${service.text}` : "Would start the relay in the background: this system has neither launchd nor systemd.");
  }
  await stopLoose();
  if (service) {
    mkdirSync(dirname(service.file), { recursive: true });
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(service.file, service.text);
    openSync(relayLog(), "a");
    await runAll(service.start);
    if (await cameUp()) {
      console.log(`The relay runs as a login service (${shown(service.file)}) and logs to ${shown(relayLog())}.`);
      const linger = lingering(true);
      if (linger) console.log(linger);
      return;
    }
    await runAll(service.stop);
    rmSync(service.file, { force: true });
  }
  startDetached();
  if (!(await cameUp())) fail(`The relay didn't start. Its log says why: ${shown(relayLog())}`);
  console.log(`${service ? "The login service didn't start here" : "This system has neither launchd nor systemd"}, so the relay runs in the background until this machine restarts. It logs to ${shown(relayLog())}.`);
  console.log(ENSURE_NOTE);
}

/** Starts the relay if it isn't running: through its service when there is one, otherwise in the background. */
export async function ensureRelay() {
  const live = runningRelay();
  if (live) return console.log(`The relay is running${live.pid ? ` (process ${live.pid})` : ""}.`);
  const service = unit();
  if (service && existsSync(service.file)) {
    await runAll(service.start);
    if (await cameUp()) return console.log("The relay wasn't running; its login service started it again.");
  }
  startDetached();
  if (!(await cameUp())) fail(`The relay wasn't running and didn't start. Its log says why: ${shown(relayLog())}`);
  console.log(`The relay wasn't running; it runs in the background again (process ${runningRelay()?.pid}).`);
}

export async function uninstallRelay(flags = {}) {
  const service = unit();
  const installed = Boolean(service && existsSync(service.file));
  if (flags["dry-run"]) return console.log(installed ? `Would stop the relay and remove ${service.file}.` : "Would stop the relay.");
  if (installed) {
    await runAll(service.stop);
    rmSync(service.file);
  }
  await stopLoose();
  console.log(installed ? `Removed ${shown(service.file)}; the relay is stopped.` : "The relay is stopped; it wasn't installed as a service.");
}

/** Whether the relay runs and how, and what it last did for each agent. */
export function relayStatus() {
  const service = unit();
  const installed = Boolean(service && existsSync(service.file));
  const running = runningRelay();
  console.log(running
    ? `Relay: running${running.pid ? ` (process ${running.pid})` : ""}${installed ? `, as a login service (${shown(service.file)})` : ", in the background until this machine restarts"}. Log: ${shown(relayLog())}.`
    : `Relay: not running. ${installed ? "`rooms relay ensure` starts it." : "`rooms relay install` starts it."}`);
  const linger = installed ? lingering(false) : "";
  if (linger) console.log(linger);
  const state = readJson("relay.json", { agents: {} });
  for (const agent of loadConfig().agents) {
    const record = state.agents?.[`${agent.kind}:${agent.name}`];
    const hour = (record?.wakes ?? []).filter((at) => Date.now() - at < 3_600_000).length;
    console.log(`"${agent.name}": ${record?.last ? `last ${record.last.result} in ${record.last.room}, ${new Date(record.last.at).toISOString()}` : "not woken yet"}; ${hour} in the last hour.`);
  }
  return { installed, running: Boolean(running) };
}
