import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { badRequest, forbidden, unauthorized } from "../platform/errors.js";
import { createAccessKey } from "./access.js";
import { libraryStore } from "./store.js";

/**
 * Agent machines get their config library key by themselves (docs/architecture/config-library.md, "Agent machines").
 * Each machine is listed in `agent-machines.json` with the public half of an SSH key that lives only on that machine.
 * `tools/config-library/enroll.sh` signs a short enrollment message with it (`ssh-keygen -Y sign`, namespace
 * `fm-config-library`); this checks the signature against the listed key, revokes the machine's earlier key and mints
 * a new one, returned once in the response body to that machine, which writes it mode 600. The key never appears in a
 * transcript, a chat, a form or a log: only its id is logged. Development data environment only.
 */

export const ENROLL_NAMESPACE = "fm-config-library";
const MAX_SKEW_MS = 5 * 60 * 1000;
type Machine = { name: string; public_key: string };

const here = path.dirname(fileURLToPath(import.meta.url));
export function agentMachines(): Machine[] {
  // A compiled build (dist/config-library) reads the source tree's list.
  const file = [String(process.env.CONFIG_LIBRARY_AGENT_MACHINES || "").trim(), path.join(here, "agent-machines.json"), path.resolve(here, "..", "..", "config-library", "agent-machines.json")].find((candidate) => !!candidate && existsSync(candidate));
  if (!file) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { machines?: Machine[] };
  return (parsed.machines || []).filter((machine) => /^agents:[a-z0-9][a-z0-9.-]{0,60}$/.test(machine.name) && /^ssh-ed25519 [A-Za-z0-9+/=]+/.test(machine.public_key));
}

/** The message a machine signs. */
export function enrollMessage(machine: string, timestamp: number, nonce: string) {
  return `fm-config-library-enroll\n${machine}\n${timestamp}\n${nonce}`;
}

function reader(buffer: Buffer) {
  let offset = 0;
  const take = (length: number) => {
    if (offset + length > buffer.length) throw badRequest("enroll_signature_invalid", "The signature is malformed.");
    const out = buffer.subarray(offset, offset + length); offset += length; return out;
  };
  const string = () => take(take(4).readUInt32BE(0));
  return { take, string, uint32: () => take(4).readUInt32BE(0), done: () => offset === buffer.length };
}
const sshString = (value: Buffer | string) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); return Buffer.concat([length, bytes]); };

/** The raw 32-byte key of an `ssh-ed25519 AAAA...` public key line. */
function ed25519Raw(publicKeyLine: string) {
  const blob = Buffer.from(publicKeyLine.trim().split(/\s+/)[1] || "", "base64");
  const read = reader(blob);
  if (read.string().toString() !== "ssh-ed25519") throw new Error("not an ed25519 key");
  const raw = read.string();
  if (raw.length !== 32) throw new Error("bad ed25519 key");
  return { blob, raw };
}

/** Verifies an armored SSHSIG (`ssh-keygen -Y sign`) over `message` by `publicKeyLine`, in `namespace`. */
export function verifySshSignature(armored: string, message: string, publicKeyLine: string, namespace = ENROLL_NAMESPACE) {
  const body = armored.replace(/-----(BEGIN|END) SSH SIGNATURE-----/g, "").replace(/\s+/g, "");
  const read = reader(Buffer.from(body, "base64"));
  if (read.take(6).toString() !== "SSHSIG" || read.uint32() !== 1) return false;
  const signer = read.string(), signedNamespace = read.string().toString(), reserved = read.string(), hashAlgorithm = read.string().toString(), signature = read.string();
  if (!read.done() || signedNamespace !== namespace || !["sha512", "sha256"].includes(hashAlgorithm)) return false;
  const expected = ed25519Raw(publicKeyLine);
  if (!signer.equals(expected.blob)) return false;
  const sig = reader(signature);
  if (sig.string().toString() !== "ssh-ed25519") return false;
  const bytes = sig.string();
  if (bytes.length !== 64) return false;
  const signed = Buffer.concat([Buffer.from("SSHSIG"), sshString(namespace), sshString(reserved), sshString(hashAlgorithm), sshString(createHash(hashAlgorithm).update(message).digest())]);
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: expected.raw.toString("base64url") }, format: "jwk" });
  return verify(null, signed, key, bytes);
}

/** Checks a machine's enrollment and mints its key (the earlier one is revoked). */
export async function enrollMachine(input: { machine: string; timestamp: number; nonce: string; signature: string }) {
  const machine = agentMachines().find((entry) => entry.name === input.machine);
  if (!machine) throw forbidden("enroll_machine_unknown", `${input.machine} is not a listed agent machine (config-library/agent-machines.json).`);
  if (!/^[a-f0-9]{16,64}$/.test(input.nonce)) throw badRequest("enroll_nonce_invalid", "The nonce is 16 to 64 hex digits.");
  if (Math.abs(Date.now() - input.timestamp) > MAX_SKEW_MS) throw unauthorized("enroll_stale", "The enrollment is older than five minutes, or this machine's clock is off.");
  let valid = false;
  try { valid = verifySshSignature(input.signature, enrollMessage(machine.name, input.timestamp, input.nonce), machine.public_key); } catch { valid = false; }
  if (!valid) throw unauthorized("enroll_signature_invalid", "The signature does not match this machine's listed key.");
  const db = libraryStore();
  // A signed enrollment is used once: it must be newer than the machine's last key.
  const last = Number((await db.prepare("SELECT MAX(created_at) AS at FROM config_library_keys WHERE name=?").get(machine.name))?.at || 0);
  if (input.timestamp <= last) throw unauthorized("enroll_replayed", "This enrollment was already used.");
  await db.prepare("UPDATE config_library_keys SET revoked_at=?, revoked_by=? WHERE name=? AND revoked_at=0").run(Date.now(), `enroll:${machine.name}`, machine.name);
  const created = await createAccessKey({ name: machine.name, createdBy: `enroll:${machine.name}`, days: 365, createdAt: input.timestamp });
  return created;
}
