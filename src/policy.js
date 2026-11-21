// Who a message wakes. Pure, so every rule here is tested without files, clocks or agents.
//
// - A message from a person wakes every agent in the room, or only those it's addressed to (`to`).
// - A message from an agent wakes only the agents it's addressed to, and the author of the message it answers.
// - Nobody is woken by their own message, by a relay's notice, or in a room they aren't a member of.
// - A person is someone the room lists as one AND whose message carries a signature this machine trusts.
//   Anyone else counts as an agent, so a forged or mistyped name can't wake a whole room.

import { sameName, signedText } from "./format.js";
import { verify } from "./sign.js";

/**
 * Who wrote a message: "person" (listed as one, and the signature verifies), "unverified" (listed as a person,
 * but no trusted signature: treated as an agent), or "agent".
 * @param {Record<string, string[]>} people  names to the public keys trusted for them
 */
export async function senderKind(people, room, roomMembers, message) {
  const member = roomMembers.find((m) => sameName(m.name, message.from));
  if (member?.kind !== "person") return "agent";
  if (!message.sig) return "unverified";
  const keys = Object.entries(people).filter(([name]) => sameName(name, message.from)).flatMap(([, list]) => list);
  for (const key of keys) if (await verify(key, signedText(room, message), message.sig)) return "person";
  return "unverified";
}

/**
 * The agents a message wakes, among the room's members.
 * @param {(file: string) => string} authorOf  who wrote the message with this file name, or ""
 */
export function targets({ message, kind, roomMembers, authorOf }) {
  if (message.notice) return [];
  const agents = roomMembers.filter((m) => m.kind === "agent" && !sameName(m.name, message.from));
  const named = (names) => agents.filter((m) => names.some((name) => sameName(name, m.name)));
  if (kind === "person") return message.to.length ? named(message.to) : agents;
  const repliedTo = message.re ? authorOf(message.re) : "";
  return named(repliedTo ? [...message.to, repliedTo] : message.to);
}

/** Whether a room is on the brake: its last `brakeAfter` messages (notices aside) all came from agents. */
export const braked = (lastKinds, brakeAfter) => lastKinds.length >= brakeAfter && lastKinds.slice(-brakeAfter).every((kind) => kind !== "person");

/** Whether an agent has used up its wakes: `wakes` are the times of its earlier ones. */
export function overLimit(wakes, limits, now) {
  const within = (ms) => wakes.filter((at) => now - at < ms).length;
  if (within(3_600_000) >= limits.perHour) return `${limits.perHour} wakes in the last hour`;
  if (within(86_400_000) >= limits.perDay) return `${limits.perDay} wakes in the last day`;
  return "";
}
