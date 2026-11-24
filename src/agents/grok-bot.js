// Grok Bot: an agent is one Bot. A Bot can't be started from a program except through a routine's webhook
// (cursor.com/help/grok-bot/routines, read 2026-11-11): a POST to the routine's "POST to" address with
// `Authorization: Bearer <key>` and a JSON body, which "the Bot receives with the routine instruction". A 200 means
// a run started; a run that fails isn't retried; 200 runs an hour per routine. Docs only: never tried with a Bot.
//
// The relay runs on the Bot's own computer, beside `ob sync`, and the Bot replies by running `rooms say` there.
// The routine's instruction, which the person writes, is what makes the body a request; the body is data.

import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadSecret, saveSecret } from "../config.js";
import { routineInstruction } from "../connect.js";
import { fail, shown } from "../core.js";
import { binDir, installSkill, skillInstalled, wakeText } from "./shared.js";

const keyName = (agent) => `grok-bot-${agent.name}`;
const skillDir = (folder) => join(folder, "agent-rooms-skill");
const WORKSPACE = "/workspace"; // where a Grok computer keeps what survives an update or a reset

export default {
  kind: "grok-bot",
  label: "Grok Bot",
  ask: "routine",
  usage: 'rooms setup grok-bot --name "<the Bot\'s name in rooms>" --url <the routine\'s "POST to" address> --key <its key, or - to read it from stdin> [--folder <where the Bot works>]',
  found: () => null,

  async setup({ flags }) {
    const name = typeof flags.name === "string" && flags.name.trim() ? flags.name.trim() : fail(this.usage);
    const url = typeof flags.url === "string" ? flags.url.trim() : fail(this.usage);
    if (!/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])\S+$/.test(url)) fail("--url is the routine's \"POST to\" address, starting with https://.");
    let key = flags.key === "-" ? readFileSync(0, "utf8").trim() : typeof flags.key === "string" ? flags.key.trim() : "";
    const agent = { kind: this.kind, name, folder: "", url, profile: url }; // the routine tells Bots apart: they share a folder
    if (!key) key = loadSecret(keyName(agent)) ?? fail("--key is the routine's key, from its details (or - to paste it on stdin).");
    const given = typeof flags.folder === "string" ? flags.folder : existsSync(WORKSPACE) ? WORKSPACE : process.cwd();
    mkdirSync(given, { recursive: true });
    agent.folder = realpathSync(resolve(given));
    saveSecret(keyName(agent), key);
    const notes = [
      "The routine's key is kept on this machine only, readable by this user.",
      `The routine's instruction, if it doesn't say this already:\n  ${routineInstruction(name)}`,
      'In the Bot\'s chat, add an "Always allow" rule for running the rooms command, or each reply waits for a review that expires.',
    ];
    if (!flags["no-skill"]) notes.push(`A copy of the skill in ${shown(skillDir(agent.folder))} (${installSkill(skillDir(agent.folder))}); ask the Bot to save it as a skill.`);
    return { agents: [agent], notes };
  },

  async wake(agent, wake) {
    const key = loadSecret(keyName(agent));
    if (!key) return { ok: false, error: "the routine's key isn't on this machine; run setup again with --key" };
    // The Bot runs `rooms` itself, outside the relay's environment: give it the full command and its name.
    const text = wakeText(agent, wake, { command: join(binDir, "rooms"), as: true });
    const body = { source: "agent-rooms", room: wake.room, vault: wake.vault, you: agent.name, addressed: wake.addressed, text };
    let response;
    try {
      response = await fetch(agent.url, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      return { ok: false, error: `couldn't reach the routine: ${error.cause?.code ?? error.message}` };
    }
    console.log(`posted to ${agent.name}'s routine: ${response.status}`);
    if (response.ok) return { ok: true };
    const said = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 120);
    if (response.status === 429) return { ok: false, busy: true, error: "the routine's hourly limit is reached" };
    if (response.status === 401 || response.status === 403) return { ok: false, error: "the routine refused its key; copy it again from the routine's details and run setup with --key -" };
    return { ok: false, error: `the routine answered ${response.status}${said ? `: ${said}` : ""}` };
  },

  check(agent) {
    const problems = [];
    if (!agent.url) problems.push("It has no routine address; run setup again with --url.");
    if (!loadSecret(keyName(agent))) problems.push("The routine's key isn't on this machine; run setup again with --key -.");
    if (!skillInstalled(skillDir(agent.folder))) problems.push(`The skill's copy isn't in ${shown(skillDir(agent.folder))}; run setup again.`);
    return problems;
  },
};
