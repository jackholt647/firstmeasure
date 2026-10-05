import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../src/config/env.js";
import { conflict, forbidden, badRequest } from "../platform/errors.js";
import { db, read, save, id, now } from "./storage.js";
import type { Connector, Obj } from "./contracts.js";

async function encryptionKey() {
  const configured = process.env.CONNECTIONS_ENCRYPTION_KEY;
  if (configured) {
    const key = Buffer.from(configured, "base64");
    if (key.length !== 32)
      throw new Error("CONNECTIONS_ENCRYPTION_KEY must encode 32 bytes.");
    return key;
  }
  if (
    env.deploymentTopology === "cluster" ||
    process.env.NODE_ENV === "production"
  )
    throw conflict(
      "connection_vault_unconfigured",
      "Configure CONNECTIONS_ENCRYPTION_KEY on all application and worker hosts.",
    );
  const file = path.resolve(env.platformStorageRoot, ".connections-key");
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, randomBytes(32), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const key = await readFile(file);
  if (key.length !== 32) throw new Error("Invalid local vault key.");
  return key;
}
export const authIdentity = (c: Connector) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        origin: new URL(c.baseUrl).origin,
        auth: c.auth,
        fields: c.credentialFields,
      }),
    )
    .digest("hex");
export async function storeCredentials(
  org: string,
  connection: string,
  definition: Connector,
  values: Obj,
) {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", await encryptionKey(), nonce);
  cipher.setAAD(Buffer.from(`${org}:${connection}`));
  const encrypted = Buffer.concat([
    cipher.update(
      JSON.stringify({ authIdentity: authIdentity(definition), values }),
      "utf8",
    ),
    cipher.final(),
  ]);
  const payload = JSON.stringify({
    iv: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  });
  await db()
    .prepare(
      "INSERT INTO integration_secrets(organization_id,connection_id,encrypted_json) VALUES(?,?,?) ON CONFLICT(organization_id,connection_id) DO UPDATE SET encrypted_json=excluded.encrypted_json",
    )
    .run(org, connection, payload);
}
export async function secrets(
  org: string,
  connection: string,
  definition: Connector,
): Promise<Obj> {
  if (definition.auth.kind === "none" && !definition.credentialFields.length)
    return {};
  const row = await db()
    .prepare(
      "SELECT encrypted_json FROM integration_secrets WHERE organization_id=? AND connection_id=?",
    )
    .get(org, connection);
  if (!row)
    throw conflict(
      "connection_credentials_required",
      "Enter credentials using the secure form.",
    );
  const e = JSON.parse(String(row.encrypted_json));
  const decipher = createDecipheriv(
    "aes-256-gcm",
    await encryptionKey(),
    Buffer.from(e.iv, "base64"),
  );
  decipher.setAAD(Buffer.from(`${org}:${connection}`));
  decipher.setAuthTag(Buffer.from(e.tag, "base64"));
  const payload = JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(e.data, "base64")),
      decipher.final(),
    ]).toString("utf8"),
  );
  if (payload.authIdentity !== authIdentity(definition))
    throw conflict(
      "connection_credentials_changed",
      "The destination or authentication changed. Re-enter credentials for this configuration.",
    );
  return payload.values;
}
export async function hasCredentials(org: string, connection: string) {
  return !!(await db()
    .prepare(
      "SELECT connection_id FROM integration_secrets WHERE organization_id=? AND connection_id=?",
    )
    .get(org, connection));
}
export async function createCredentialRequest(
  org: string,
  user: string,
  connection: string,
  definition: Connector,
) {
  await encryptionKey();
  const key = id("credential");
  await save(
    org,
    "credential-request",
    key,
    {
      user,
      connection,
      identity: authIdentity(definition),
      expiresAt: Date.now() + 10 * 60_000,
      used: false,
    },
    0,
  );
  return {
    id: key,
    connectionId: connection,
    fields: definition.credentialFields,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}
export async function credentialRequest(
  org: string,
  user: string,
  key: string,
) {
  const r = await read(org, "credential-request", key);
  if (!r || r.user !== user || r.used || r.expiresAt < Date.now())
    throw forbidden(
      "credential_request_expired",
      "This credential form expired. Open a new form.",
    );
  return r;
}
export async function submitCredentials(
  org: string,
  user: string,
  key: string,
  definition: Connector,
  values: Obj,
) {
  return db().transaction(async () => {
    const r = await credentialRequest(org, user, key);
    if (r.identity !== authIdentity(definition))
      throw conflict(
        "credential_request_changed",
        "Connection setup changed. Open a new form.",
      );
    const allowed = new Set(definition.credentialFields.map((f) => f.key));
    if (Object.keys(values).some((k) => !allowed.has(k)))
      throw badRequest("credential_fields", "Unexpected credential field.");
    for (const f of definition.credentialFields)
      if (
        (f.required || values[f.key] !== undefined) &&
        (typeof values[f.key] !== "string" ||
          values[f.key].length > 16000 ||
          (f.required && !values[f.key]))
      )
        throw badRequest("credential_fields", `Enter ${f.label}.`);
    await storeCredentials(org, r.connection, definition, values);
    await save(
      org,
      "credential-request",
      key,
      { ...r, used: true, completedAt: now() },
      r.revision,
    );
    return { saved: true, connectionId: r.connection };
  }, `${org}:credentials:${key}`);
}
