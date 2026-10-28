import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Agent machines fetch their own config library key (config-library/enroll.ts): an SSH signature by the machine's
// listed key, used once and only while fresh, mints a key and revokes the machine's earlier one.
const dir = await mkdtemp(path.join(os.tmpdir(), "config-library-enroll-"));
Object.assign(process.env, { NODE_ENV: "test", FIRSTMEASURE_DATA_ENVIRONMENT: "development", CONFIG_LIBRARY_SOURCE: "store", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), CONFIG_LIBRARY_AGENT_MACHINES: path.join(dir, "machines.json"), PLATFORM_HEARTBEAT_DISABLED: "1" });
after(async () => { const { closeSqlStores } = await import("../platform/sql_store.js"); await closeSqlStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

let sshKeygen = true;
try { execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" }); } catch (error) { sshKeygen = (error as { status?: number }).status !== undefined && (error as { code?: string }).code !== "ENOENT"; }

function sign(keyFile: string, message: string, namespace = "fm-config-library") {
  const file = path.join(dir, `msg-${Math.random().toString(16).slice(2)}`);
  execFileSync("node", ["-e", `require('fs').writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(message)})`]);
  execFileSync("ssh-keygen", ["-Y", "sign", "-f", keyFile, "-n", namespace, file], { stdio: "ignore" });
  return execFileSync("node", ["-p", `require('fs').readFileSync(${JSON.stringify(file + ".sig")}, 'utf8')`]).toString();
}

test("an agent machine enrolls with its SSH key; replays, stale, unknown and forged enrollments are refused", { skip: !sshKeygen && "ssh-keygen is not installed" }, async () => {
  const keyFile = path.join(dir, "machine_ed25519"), otherFile = path.join(dir, "other_ed25519");
  for (const file of [keyFile, otherFile]) execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", file]);
  await writeFile(path.join(dir, "machines.json"), JSON.stringify({ machines: [{ name: "agents:test-box", public_key: (await readFile(keyFile + ".pub", "utf8")).trim() }] }));
  const enroll = await import("../config-library/enroll.js");
  const access = await import("../config-library/access.js");

  const now = Date.now(), nonce = "0123456789abcdef0123456789abcdef";
  const message = enroll.enrollMessage("agents:test-box", now, nonce);
  const signature = sign(keyFile, message);
  assert.equal(enroll.verifySshSignature(signature, message, (await readFile(keyFile + ".pub", "utf8"))), true);
  assert.equal(enroll.verifySshSignature(signature, message + "x", (await readFile(keyFile + ".pub", "utf8"))), false, "another message");
  assert.equal(enroll.verifySshSignature(sign(keyFile, message, "other-namespace"), message, (await readFile(keyFile + ".pub", "utf8"))), false, "another namespace");
  assert.equal(enroll.verifySshSignature(sign(otherFile, message), message, (await readFile(keyFile + ".pub", "utf8"))), false, "another key");

  const first = await enroll.enrollMachine({ machine: "agents:test-box", timestamp: now, nonce, signature });
  assert.match(first.key, /^fmck_/);
  assert.equal((await access.verifyAccessKey(first.key))?.name, "agents:test-box", "the key works");
  await assert.rejects(() => enroll.enrollMachine({ machine: "agents:test-box", timestamp: now, nonce, signature }), /already used/);
  await assert.rejects(() => enroll.enrollMachine({ machine: "agents:unknown", timestamp: now, nonce, signature }), /not a listed agent machine/);
  const stale = now - 10 * 60 * 1000;
  await assert.rejects(() => enroll.enrollMachine({ machine: "agents:test-box", timestamp: stale, nonce, signature: sign(keyFile, enroll.enrollMessage("agents:test-box", stale, nonce)) }), /older than five minutes/);
  const later = now + 1000;
  await assert.rejects(() => enroll.enrollMachine({ machine: "agents:test-box", timestamp: later, nonce, signature: sign(otherFile, enroll.enrollMessage("agents:test-box", later, nonce)) }), /does not match/);

  const second = await enroll.enrollMachine({ machine: "agents:test-box", timestamp: later, nonce, signature: sign(keyFile, enroll.enrollMessage("agents:test-box", later, nonce)) });
  assert.equal(await access.verifyAccessKey(first.key), null, "enrolling again revokes the earlier key");
  assert.equal((await access.verifyAccessKey(second.key))?.name, "agents:test-box");
});
