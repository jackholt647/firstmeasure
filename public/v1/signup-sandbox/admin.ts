import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyPassword } from "../platform/auth.js";
import { findIdentityByEmail } from "../platform/storage.js";
import { forbidden, unauthorized } from "../platform/errors.js";
import { env } from "../src/config/env.js";

export const gatedAccounts = () => process.env.PUBLIC_REGISTRATION_ENABLED === "false";
export function requirePublicRegistration() {
  if (gatedAccounts()) throw forbidden("registration_disabled", "Account creation is available only through the Experimental admin console.");
}
const cookieName = "fm_experimental_admin";
const allowed = (email: string) => (process.env.EXPERIMENTAL_ACCOUNTS_ADMIN_EMAILS || "").split(",").map(x => x.trim().toLowerCase()).includes(email);
const sign = (value: string) => createHmac("sha256", env.platformSessionSecret).update(`experimental-admin:${value}`).digest("base64url");
const attempts = new Map<string, { count: number; until: number }>();
const active = (identity: any) => identity && String(identity.status || "active") === "active";

export function requireAdminOrigin(request: FastifyRequest) {
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.origin !== new URL(env.publicBaseUrl).origin) {
    throw forbidden("origin_required", "A same-origin admin request is required.");
  }
}
export async function experimentalAdmin(request: FastifyRequest) {
  const raw = String(request.headers.cookie || "").split(";").map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) || "";
  const [payload, signature] = raw.split(".");
  if (!payload || !signature) throw unauthorized("admin_login_required", "Experimental admin login required.");
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw unauthorized("admin_login_required", "Experimental admin login required.");
  let session: any;
  try { session = JSON.parse(Buffer.from(payload, "base64url").toString()); } catch { throw unauthorized("admin_login_required", "Experimental admin login required."); }
  if (!Number.isFinite(session.expires) || session.expires < Date.now() || !allowed(session.email)) throw unauthorized("admin_login_required", "Experimental admin login required.");
  const identity = await findIdentityByEmail(session.email).catch(() => null);
  if (!active(identity) || identity!.id !== session.id || sign(String(identity!.password_hash)) !== session.passwordVersion) throw unauthorized("admin_login_required", "Experimental admin login required.");
  return { email: session.email };
}
export async function loginExperimentalAdmin(request: FastifyRequest, reply: FastifyReply) {
  requireAdminOrigin(request);
  const key = request.ip;
  const now = Date.now();
  for (const [ip, item] of attempts) if (item.until < now) attempts.delete(ip);
  const attempt = attempts.get(key) || { count: 0, until: now + 600_000 };
  if (++attempt.count > 10) throw forbidden("login_throttled", "Too many attempts. Try again in ten minutes.");
  attempts.set(key, attempt);
  const body = (request.body || {}) as Record<string, unknown>;
  const email = String(body.email || "").trim().toLowerCase();
  const identity = allowed(email) ? await findIdentityByEmail(email).catch(() => null) : null;
  if (!active(identity) || !await verifyPassword(String(body.password || ""), String(identity?.password_hash || ""))) throw unauthorized("invalid_credentials", "Invalid admin credentials.");
  attempts.delete(key);
  const payload = Buffer.from(JSON.stringify({ email, id: identity!.id, passwordVersion: sign(String(identity!.password_hash)), expires: now + 8 * 3600_000 })).toString("base64url");
  reply.header("Set-Cookie", `${cookieName}=${payload}.${sign(payload)}; Path=/v1/signup-sandbox; HttpOnly; SameSite=Strict; Max-Age=28800${env.publicBaseUrl.startsWith("https:") ? "; Secure" : ""}`);
  return { ok: true };
}
export function logoutExperimentalAdmin(reply: FastifyReply) {
  reply.header("Set-Cookie", `${cookieName}=; Path=/v1/signup-sandbox; HttpOnly; SameSite=Strict; Max-Age=0${env.publicBaseUrl.startsWith("https:") ? "; Secure" : ""}`);
  return { ok: true };
}
