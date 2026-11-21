// Signatures on a person's messages. Anyone who can write to the vault can put any name in `from`, so a message
// counts as a person's only when its `sig` verifies against a public key this machine was told to trust.
// Web Crypto only (ECDSA P-256), so the same code runs in Node and in the Obsidian plugin on a phone.

const subtle = globalThis.crypto.subtle;
const CURVE = { name: "ECDSA", namedCurve: "P-256" };
const HASH = { name: "ECDSA", hash: "SHA-256" };

const encode = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const decode = (value) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const utf8 = (value) => new TextEncoder().encode(value);

/** A new key pair: the public key as text to hand to relays, the private key as a JWK to keep on the device. */
export async function newKeyPair() {
  const pair = await subtle.generateKey(CURVE, true, ["sign", "verify"]);
  return { publicKey: encode(await subtle.exportKey("raw", pair.publicKey)), privateKey: await subtle.exportKey("jwk", pair.privateKey) };
}

export async function sign(privateKey, payload) {
  const key = await subtle.importKey("jwk", privateKey, CURVE, false, ["sign"]);
  return encode(await subtle.sign(HASH, key, utf8(payload)));
}

/** Whether `signature` is `payload` signed by the holder of `publicKey`. False for anything malformed. */
export async function verify(publicKey, payload, signature) {
  try {
    const key = await subtle.importKey("raw", decode(publicKey), CURVE, false, ["verify"]);
    return await subtle.verify(HASH, key, decode(signature), utf8(payload));
  } catch {
    return false;
  }
}
