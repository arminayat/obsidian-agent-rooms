// The relay as a login service, so it's running whenever this user is logged in: launchd on a Mac, a systemd
// user service on Linux. `rooms relay install | uninstall | status`; --dry-run prints what would be written.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { configDir, loadConfig, readJson } from "./config.js";
import { shown } from "./core.js";
import { binDir, which } from "./agents/shared.js";
import { moduleFor } from "./agents/index.js";

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

function unit() {
  const node = nodePath();
  const args = [node, join(binDir, "rooms"), "relay"];
  const config = loadConfig();
  const commands = config.agents.map((agent) => moduleFor(agent)?.found()).filter(Boolean).map((command) => dirname(command));
  const env = {
    PATH: [...new Set([binDir, dirname(node), ...commands, join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"])].join(":"),
    ...(process.env.AGENT_ROOMS_HOME ? { AGENT_ROOMS_HOME: process.env.AGENT_ROOMS_HOME } : {}),
    ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}),
  };
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
  <key>KeepAlive</key><true/>
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
Restart=always
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

export async function installRelay(flags = {}) {
  const service = unit();
  if (!service) return console.log("This system has neither launchd nor systemd: run `rooms relay` yourself and keep it running.");
  if (flags["dry-run"]) return console.log(`Would write ${service.file}:\n\n${service.text}`);
  mkdirSync(dirname(service.file), { recursive: true });
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(service.file, service.text);
  openSync(relayLog(), "a");
  await runAll(service.start);
  console.log(`The relay runs as a login service (${shown(service.file)}) and logs to ${shown(relayLog())}.`);
  const linger = lingering(true);
  if (linger) console.log(linger);
}

export async function uninstallRelay(flags = {}) {
  const service = unit();
  if (!service || !existsSync(service.file)) return console.log("The relay isn't installed as a service.");
  if (flags["dry-run"]) return console.log(`Would stop the relay and remove ${service.file}.`);
  await runAll(service.stop);
  rmSync(service.file);
  console.log(`Removed ${shown(service.file)}; the relay is stopped.`);
}

/** Whether the service file is there, and what the relay last did for each agent. */
export function relayStatus() {
  const service = unit();
  const installed = Boolean(service && existsSync(service.file));
  console.log(installed ? `Service: ${shown(service.file)}. Log: ${shown(relayLog())}.` : "Service: not installed (`rooms relay install`).");
  const linger = installed ? lingering(false) : "";
  if (linger) console.log(linger);
  const state = readJson("relay.json", { agents: {} });
  for (const agent of loadConfig().agents) {
    const record = state.agents?.[`${agent.kind}:${agent.name}`];
    const hour = (record?.wakes ?? []).filter((at) => Date.now() - at < 3_600_000).length;
    console.log(`"${agent.name}": ${record?.last ? `last ${record.last.result} in ${record.last.room}, ${new Date(record.last.at).toISOString()}` : "not woken yet"}; ${hour} in the last hour.`);
  }
  return installed;
}
