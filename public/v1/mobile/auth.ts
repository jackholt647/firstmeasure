import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requirePlatformAuth, loginPlatformVerifiedIdentity, setPlatformAuthCookies, type PlatformAuthContext } from "../platform/auth.js";
import { createAuthSession, consumeMobileAuthSession, readIdentity, readDocument } from "../platform/storage.js";
import { badRequest, forbidden, unauthorized, PlatformError } from "../platform/errors.js";

const opaque = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** The browser sign-in page the app opens: the portal login's look (FM-418), one button that hands the session to the app. */
export function browserSignInPage(ctx: PlatformAuthContext, challenge: string, state: string) {
  const name = String(ctx.identity.name || ctx.user.name || "").trim();
  const email = String(ctx.identity.email || ctx.user.email || "").trim();
  const organization = String(ctx.organization.name || "").trim();
  const initial = (name || email || "?").charAt(0).toUpperCase();
  const account = `<div class="account"><span class="avatar" aria-hidden="true">${escapeHtml(initial)}</span><span class="who"><strong>${escapeHtml(name || email)}</strong>${name && email ? `<span>${escapeHtml(email)}</span>` : ""}${organization ? `<span>${escapeHtml(organization)}</span>` : ""}</span></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#d93025">
<title>Continue to FirstMate</title>
<link rel="icon" type="image/png" href="/images/icon.png">
<style>
@font-face{font-family:Montserrat;src:url(/fonts/Montserrat-Regular.ttf) format("truetype");font-weight:400}
@font-face{font-family:Montserrat;src:url(/fonts/Montserrat-SemiBold.ttf) format("truetype");font-weight:600}
@font-face{font-family:Montserrat;src:url(/fonts/Montserrat-Bold.ttf) format("truetype");font-weight:700}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px 16px calc(24px + env(safe-area-inset-bottom));background:#f0f2f5;color:#202124;font:15px/1.5 Montserrat,"Segoe UI",Roboto,sans-serif}
.card{width:100%;max-width:400px;background:#fff;border-radius:12px;box-shadow:0 10px 25px rgba(0,0,0,.1);overflow:hidden}
.header{background:#d93025;padding:25px;text-align:center}
.header img{display:block;height:70px;margin:0 auto}
.body{padding:28px 30px 30px}
h1{margin:0 0 8px;font-size:22px;line-height:1.25;font-weight:700;color:#111827}
p{margin:0;color:#5f6368;font-size:14px}
.account{display:flex;align-items:center;gap:12px;margin:22px 0 4px;padding:12px 14px;border:2px solid #eee;border-radius:8px}
.avatar{flex:none;width:40px;height:40px;border-radius:50%;background:#fff5f4;color:#d93025;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:17px}
.who{min-width:0;display:flex;flex-direction:column;line-height:1.35}
.who strong{font-weight:600;color:#202124;overflow-wrap:anywhere}
.who span{font-size:13px;color:#5f6368;overflow-wrap:anywhere}
.btn{display:block;width:100%;margin-top:22px;padding:14px 16px;min-height:48px;border:0;border-radius:6px;background:#d93025;color:#fff;font:inherit;font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent}
.btn:hover{background:#b0261e}
.btn:focus-visible{outline:3px solid rgba(217,48,37,.3);outline-offset:2px}
.btn:disabled{background:#e4837c;cursor:default}
.status{min-height:20px;margin-top:12px;color:#d93025;font-size:13px;text-align:center}
.done{margin-top:4px;color:#137333;font-size:13px;text-align:center}
.note{margin-top:6px;color:#8a9099;font-size:12px;text-align:center}
@media(max-width:360px){body{padding:16px 12px}.body{padding:24px 20px}}
</style>
</head>
<body>
<main class="card">
<div class="header"><img src="/images/logo_white.png" alt="FirstMate" height="70"></div>
<div class="body">
<h1>Continue to the app</h1>
<p>You're signed in. Continue only if you started this sign-in from the FirstMate app on your phone.</p>
${account}
<button class="btn" id="continue" type="button">Continue to FirstMate</button>
<p class="status" id="status" role="status"></p>
<p class="done" id="done" hidden>The app should be open now. You can close this page.</p>
<p class="note">Didn't start this? Close this page; nothing happens until you continue.</p>
</div>
</main>
<script>document.getElementById('continue').onclick=async function(){const label=this.textContent;this.disabled=true;this.textContent='Opening the app\u2026';document.getElementById('status').textContent='';try{const r=await fetch('/v1/mobile/auth/authorize',{method:'POST',headers:{'Content-Type':'application/json','x-platform-csrf':${JSON.stringify(ctx.csrfToken)}},body:JSON.stringify({challenge:${JSON.stringify(challenge)},state:${JSON.stringify(state)}})});const data=await r.json();if(!r.ok)throw Error(data.message||'Sign-in failed.');location.href=data.callback;setTimeout(()=>{this.textContent=label;this.disabled=false;document.getElementById('status').textContent='';document.getElementById('done').hidden=false;},1500);}catch(e){document.getElementById('status').textContent=e.message;this.disabled=false;this.textContent=label;}};</script>
</body>
</html>`;
}
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
    reply.header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    return reply.type("text/html").send(browserSignInPage(ctx, challenge!, state!));
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
