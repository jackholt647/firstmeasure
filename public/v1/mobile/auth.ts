import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requirePlatformAuth, loginPlatformVerifiedIdentity, setPlatformAuthCookies } from "../platform/auth.js";
import { createAuthSession, consumeMobileAuthSession, readIdentity, readDocument } from "../platform/storage.js";
import { badRequest, forbidden, unauthorized, PlatformError } from "../platform/errors.js";

const opaque = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
export function registerMobileAuth(app: FastifyInstance) {
  app.get<{ Querystring: { challenge?: string; state?: string } }>("/auth/browser", async (request, reply) => {
    const { challenge, state } = request.query;
    if (!opaque(challenge) || !opaque(state)) throw badRequest("handoff_invalid", "Open app sign-in from FirstMeasure.");
    let ctx;
    try { ctx = await requirePlatformAuth(request); }
    catch (error) {
      if (!(error instanceof PlatformError) || error.statusCode !== 401) throw error;
      return reply.redirect("/portal/login.php?redirect=" + encodeURIComponent(request.url));
    }
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    return reply.type("text/html").send(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Continue to FirstMeasure</title><style>body{font:17px system-ui;max-width:480px;padding:32px;margin:auto}button{padding:16px;font:inherit;cursor:pointer}p{line-height:1.5}</style><h1>Continue to FirstMeasure</h1><p>Your browser sign-in is ready. Continue only if you started this sign-in from the FirstMeasure phone app.</p><button id="continue">Continue to app</button><p id="status" role="status"></p><script>document.getElementById('continue').onclick=async function(){this.disabled=true;try{const r=await fetch('/v1/mobile/auth/authorize',{method:'POST',headers:{'Content-Type':'application/json','x-platform-csrf':${JSON.stringify(ctx.csrfToken)}},body:JSON.stringify({challenge:${JSON.stringify(challenge)},state:${JSON.stringify(state)}})});const data=await r.json();if(!r.ok)throw Error(data.message||'Sign-in failed.');location.href=data.callback;}catch(e){document.getElementById('status').textContent=e.message;this.disabled=false;}};</script></html>`);
  });
  app.post<{ Body: { challenge?: string; state?: string } }>("/auth/authorize", async request => {
    const ctx = await requirePlatformAuth(request, { csrf: true });
    const { challenge, state } = request.body || {};
    if (!opaque(challenge) || !opaque(state)) throw badRequest("handoff_invalid", "Open app sign-in from FirstMeasure.");
    const ticket = await createAuthSession({ identity_id: ctx.identityId, organization_id: ctx.orgId, user_id: ctx.userId, ttl_seconds: 120, metadata: { mobile_pkce: challenge } });
    const scheme = process.env.FIRSTMEASURE_DATA_ENVIRONMENT === "production" ? "ai.firstmeasure.mobile" : "ai.firstmeasure.mobile.dev";
    return { callback: `${scheme}://auth?code=${ticket.sessionId}&state=${state}` };
  });
  app.post<{ Body: { code?: string; verifier?: string } }>("/auth/exchange", async (request, reply) => {
    const { code, verifier } = request.body || {};
    if (!opaque(code) || !opaque(verifier)) throw badRequest("handoff_invalid", "App sign-in is invalid. Please try again.");
    const challenge = createHash("sha256").update(verifier!).digest("base64url");
    const ticket = await consumeMobileAuthSession(code!, challenge).catch(() => { throw unauthorized("handoff_invalid", "This app sign-in has expired or has already been used."); });
    const identity = await readIdentity(String(ticket.identity_id));
    const member = await readDocument(String(ticket.organization_id), "users", String(ticket.user_id)).catch(() => null);
    if (!member || (member.data as any)?.status === "disabled") throw forbidden("membership_required", "Your organization access has changed. Please sign in again.");
    const ctx = await loginPlatformVerifiedIdentity({ identity, organizationId: String(ticket.organization_id), metadata: { mobile_login: true } });
    if (ctx.orgId !== String(ticket.organization_id)) throw forbidden("membership_required", "Your organization access has changed.");
    setPlatformAuthCookies(request, reply, ctx.sessionId, ctx.csrfToken);
    return reply.code(303).redirect("/portal/");
  });
}
