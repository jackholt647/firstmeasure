/**
 * A full admin acting as another staff member
 * (docs/architecture/request-security.md#principals). The mark lives on the
 * server, keyed by the admin's session, so nothing a browser or PHP sends can
 * set it. Start and stop are written to the security audit log.
 */
import { createHash, randomBytes } from "node:crypto";

export const IMPERSONATION_TTL_MS = 4 * 60 * 60 * 1000;
const COLLECTION = "staff_impersonation";

function sessionKey(sessionId: string) {
  return createHash("sha256").update(`impersonation:${sessionId}`).digest("hex").slice(0, 48);
}

async function storage() {
  return await import("../../internal/storage.js");
}

export type ImpersonationMark = { target_email: string; admin_email: string; started_at: string; expires_at: string };

/** The admin's current mark (whom they are acting as, until when), or null. */
export async function impersonationMark(sessionId: string, adminEmail: string): Promise<ImpersonationMark | null> {
  if (!sessionId) return null;
  const { readInternalDocument } = await storage();
  const document = await readInternalDocument(COLLECTION, sessionKey(sessionId)).catch(() => null);
  const data = (document?.data ?? {}) as Record<string, unknown>;
  const target = String(data.target_email ?? "").trim().toLowerCase();
  if (!target || String(data.admin_email ?? "").toLowerCase() !== adminEmail.toLowerCase()) return null;
  if (!(Date.parse(String(data.expires_at ?? "")) > Date.now())) return null;
  return { target_email: target, admin_email: adminEmail.toLowerCase(), started_at: String(data.started_at ?? ""), expires_at: String(data.expires_at ?? "") };
}

/** The email the admin is acting as, or null. */
export async function activeImpersonation(sessionId: string, adminEmail: string) {
  return (await impersonationMark(sessionId, adminEmail))?.target_email ?? null;
}

export async function startImpersonation(sessionId: string, adminEmail: string, targetEmail: string) {
  const { saveInternalDocument } = await storage();
  const expires = new Date(Date.now() + IMPERSONATION_TTL_MS).toISOString();
  await saveInternalDocument(COLLECTION, sessionKey(sessionId), {
    data: { admin_email: adminEmail.toLowerCase(), target_email: targetEmail.toLowerCase(), started_at: new Date().toISOString(), expires_at: expires }
  }, { replace: true });
  await recordSecurityEvent("impersonation_started", { admin_email: adminEmail, target_email: targetEmail, expires_at: expires });
  return { target_email: targetEmail.toLowerCase(), expires_at: expires };
}

export async function stopImpersonation(sessionId: string, adminEmail: string) {
  const { saveInternalDocument } = await storage();
  const target = await activeImpersonation(sessionId, adminEmail);
  await saveInternalDocument(COLLECTION, sessionKey(sessionId), { data: { admin_email: adminEmail.toLowerCase(), target_email: "", expires_at: new Date(0).toISOString() } }, { replace: true });
  if (target) await recordSecurityEvent("impersonation_stopped", { admin_email: adminEmail, target_email: target });
  return { stopped: Boolean(target) };
}

/** Append one entry to the internal security audit log. Never throws. */
export async function recordSecurityEvent(type: string, details: Record<string, unknown>) {
  try {
    const { saveInternalDocument } = await storage();
    const at = new Date().toISOString();
    const id = `${at.replace(/[^0-9]/g, "").slice(0, 17)}_${randomBytes(6).toString("hex")}`;
    await saveInternalDocument("security_audit", id, { data: { type, at, ...details } }, { replace: true });
  } catch (error) {
    console.error("security audit write failed", type, error);
  }
}
