// Appointment confirmation API. Authenticated routes back the company settings
// section, the schedule popup's confirmation panel, and manual resend/override;
// the /public/:token routes are the customer-facing confirm page reached from
// the link in the email or text.

import type { FastifyPluginAsync } from "fastify";
import { ZodError, z } from "zod";

import { requirePlatformAuth } from "../platform/auth.js";
import { PlatformError } from "../platform/errors.js";
import {
  canViewConfirmations,
  organizationConfirmations,
  projectConfirmations,
  publicConfirmationView,
  readConfirmationSettings,
  runConfirmationTick,
  sendConfirmationGroup,
  setAppointmentConfirmation,
  startConfirmationScheduler,
  submitPublicConfirmation,
  writeConfirmationSettings
} from "./service.js";
import { readConfirmationByEvent, readConfirmationsByToken } from "./storage.js";
import {
  appointmentAvailability,
  commitAppointmentReschedule,
  holdAppointmentSlot,
  readSchedulingAvailabilitySettings,
  reviewAppointmentReschedule
} from "./availability.js";

const objectBodySchema = z.object({}).passthrough();

const outcomeSchema = z.object({
  outcome: z.enum(["confirmed", "declined", "reset"])
});

const publicOutcomeSchema = z.object({
  outcome: z.enum(["confirmed", "declined"]),
  note: z.string().max(1000).optional()
});

export const registerAppointmentsApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({ ok: false, error: "validation_error", issues: error.issues });
    }
    if (error instanceof PlatformError) {
      reply.code(error.statusCode);
      return reply.send({ ok: false, error: error.code, message: error.message, details: error.details ?? null });
    }
    app.log.error(error);
    reply.code(500);
    return reply.send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  startConfirmationScheduler();

  app.get("/", async () => ({
    ok: true,
    api: "appointments",
    message: "appointment confirmation API is mounted",
    endpoints: {
      settings: "/organizations/:orgId/branches/:branchId/confirmation-settings",
      projectConfirmations: "/organizations/:orgId/projects/:projectId/confirmations",
      eventConfirmation: "/organizations/:orgId/projects/:projectId/events/:eventId/confirmation",
      publicApp: "/public/:token/app"
    }
  }));

  // ── Settings ──────────────────────────────────────────────────────────────

  app.get("/organizations/:orgId/branches/:branchId/confirmation-settings", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings|manage_schedule|view_projects" });
    const result = await readConfirmationSettings(orgId, getParam(request.params, "branchId"));
    return { ok: true, ...result };
  });

  app.put("/organizations/:orgId/branches/:branchId/confirmation-settings", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings", csrf: true });
    const body = objectBodySchema.parse(request.body ?? {});
    const result = await writeConfirmationSettings(orgId, getParam(request.params, "branchId"), body);
    return { ok: true, ...result };
  });

  app.get("/organizations/:orgId/branches/:branchId/scheduling-settings", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings|manage_schedule|view_projects" });
    return { ok: true, ...(await readSchedulingAvailabilitySettings(orgId, getParam(request.params, "branchId"))) };
  });

  app.get("/organizations/:orgId/availability", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: "manage_schedule|view_projects", capability: "scheduling.appointment_slots" });
    return await appointmentAvailability(orgId, ctx.branchId || "default", asObject(request.query));
  });

  app.post("/organizations/:orgId/availability/holds", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: "manage_schedule|manage_projects", capability: "scheduling.appointment_slots", csrf: true });
    return await holdAppointmentSlot(orgId, ctx.branchId || "default", objectBodySchema.parse(request.body ?? {}));
  });

  app.post("/organizations/:orgId/availability/holds/:holdId/commit", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: "manage_schedule|manage_projects", capability: "scheduling.appointment_slots", csrf: true });
    return await commitAppointmentReschedule(orgId, getParam(request.params, "holdId"), { source: "staff", actor: ctx.userId });
  });

  app.post("/organizations/:orgId/projects/:projectId/events/:eventId/reschedule-review", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: "manage_schedule|manage_projects", capability: "scheduling.customer_rescheduling", csrf: true });
    const body = objectBodySchema.parse(request.body ?? {});
    const decision = cleanText(body.decision);
    if (decision !== "approved" && decision !== "declined") throw new PlatformError("invalid_reschedule_decision", 400, "Choose approved or declined.");
    return await reviewAppointmentReschedule(orgId, getParam(request.params, "projectId"), getParam(request.params, "eventId"), decision, { actor:ctx.userId, branch_id:ctx.branchId, note:cleanText(body.note) });
  });

  // ── Confirmation records ──────────────────────────────────────────────────

  app.get("/organizations/:orgId/confirmations", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: "view_projects|manage_schedule" });
    const { settings } = await readConfirmationSettings(orgId, ctx.branchId);
    if (!canViewConfirmations(settings, { permissions: ctx.permissions, roleIds: accessRoleIds(ctx) })) {
      return { ok: true, visible: false, confirmations: [] };
    }
    const query = asObject(request.query);
    const status = cleanText(query.status) ? cleanText(query.status).split(",").map((entry) => entry.trim()) : undefined;
    return { ok: true, visible: true, confirmations: (await organizationConfirmations(orgId, { status })) };
  });

  app.get("/organizations/:orgId/projects/:projectId/confirmations", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: "view_projects|manage_schedule" });
    const { settings } = await readConfirmationSettings(orgId, ctx.branchId);
    if (!canViewConfirmations(settings, { permissions: ctx.permissions, roleIds: accessRoleIds(ctx) })) {
      return { ok: true, visible: false, confirmations: [] };
    }
    return {
      ok: true,
      visible: true,
      confirmations: (await projectConfirmations(orgId, getParam(request.params, "projectId")))
    };
  });

  // Staff override — "the customer called and confirmed".
  app.post("/organizations/:orgId/projects/:projectId/events/:eventId/confirmation", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: "manage_schedule|manage_projects", csrf: true });
    const body = outcomeSchema.parse(request.body ?? {});
    const identity = asObject(ctx.identity);
    const result = await setAppointmentConfirmation(
      orgId,
      getParam(request.params, "projectId"),
      getParam(request.params, "eventId"),
      body.outcome,
      { user_id: cleanText(ctx.userId), name: cleanText(identity.name || identity.display_name || identity.email) }
    );
    return result;
  });

  // Manual send — "send it now" from the schedule popup.
  app.post("/organizations/:orgId/projects/:projectId/events/:eventId/confirmation/send", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_schedule|manage_projects", csrf: true });
    const row = (await readConfirmationByEvent(orgId, getParam(request.params, "projectId"), getParam(request.params, "eventId")));
    if (!row) {
      return { ok: false, error: "confirmation_not_scheduled", message: "This appointment is not set to request a confirmation." };
    }
    const group = (await readConfirmationsByToken(cleanText(row.token))).filter((entry) => cleanText(entry.status) !== "confirmed");
    return await sendConfirmationGroup(group.length ? group : [row], { base_url: requestBaseUrl(request) });
  });

  // Manual tick, for tests and the dev console.
  app.post("/organizations/:orgId/confirmations/run", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings", csrf: true });
    const result = await runConfirmationTick({ base_url: requestBaseUrl(request) });
    return { ok: true, sent: result.sent, expired: result.expired, skipped: result.skipped };
  });

  // ── Public confirm experience ─────────────────────────────────────────────

  app.get("/public/:token/app", async (request, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    return reply.send(publicConfirmAppHtml(getParam(request.params, "token")));
  });

  app.get("/public/:token", async (request) => {
    return { ok: true, ...(await publicConfirmationView(getParam(request.params, "token"))) };
  });

  app.post("/public/:token/respond", async (request) => {
    const body = publicOutcomeSchema.parse(request.body ?? {});
    return await submitPublicConfirmation(getParam(request.params, "token"), body.outcome, { note: body.note });
  });
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function getParam(params: unknown, key: string) {
  return cleanText(asObject(params)[key]);
}

function accessRoleIds(ctx: { accessProfile?: unknown; user?: unknown }) {
  const profile = asObject(ctx.accessProfile);
  const fromProfile = Array.isArray(profile.access_role_ids) ? profile.access_role_ids : [];
  const fromUser = Array.isArray(asObject(ctx.user).access_role_ids) ? asObject(ctx.user).access_role_ids as unknown[] : [];
  return [...fromProfile, ...fromUser].map(cleanText).filter(Boolean);
}

function requestBaseUrl(request: { headers?: Record<string, unknown>; protocol?: string }) {
  const headers = request.headers || {};
  const forwardedProto = cleanText(headers["x-forwarded-proto"]).split(",")[0];
  const forwardedHost = cleanText(headers["x-forwarded-host"]).split(",")[0];
  const host = forwardedHost || cleanText(headers.host);
  if (!host) return "";
  return `${forwardedProto || cleanText(request.protocol) || "https"}://${host}`;
}

function publicConfirmAppHtml(token: string) {
  const tokenJson = JSON.stringify(token);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Confirm your appointment</title>
  <style>
    :root{--brand:#2563EB;--brand-rgb:37,99,235;--ink:#101828;--muted:#667085}
    *{box-sizing:border-box}
    html,body{margin:0;min-height:100%}
    body{background:
      radial-gradient(1200px 600px at 50% -240px, rgba(var(--brand-rgb), .14), transparent 60%),
      #f7f8fa;
      color:var(--ink);font-family:Montserrat,-apple-system,"Segoe UI",Arial,sans-serif;
      display:flex;align-items:flex-start;justify-content:center;padding:28px 16px 56px}
    main{width:100%;max-width:470px}
    .brandbar{display:flex;flex-direction:column;align-items:center;gap:12px;padding:22px 0 20px}
    .brandbar img{max-height:52px;max-width:220px;object-fit:contain}
    .brandbar .name{font-size:14px;font-weight:900;letter-spacing:.02em}
    .card{background:#fff;border:1px solid #e8ebf0;border-radius:22px;padding:30px 26px 28px;
      box-shadow:0 18px 50px rgba(16,24,40,.08);text-align:center;
      animation:cardIn .5s cubic-bezier(.2,.9,.3,1.2) both}
    @keyframes cardIn{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}
    h1{margin:0;font-size:23px;line-height:1.25;letter-spacing:-.02em}
    .sub{margin:10px 0 0;color:var(--muted);font-size:13px;line-height:1.55;font-weight:600}
    .appt{margin-top:18px;border:1.5px solid #e4e7ec;border-radius:16px;padding:16px 18px;text-align:left;
      background:#fbfcfd}
    .appt + .appt{margin-top:10px}
    .appt .title{font-weight:900;font-size:14px}
    .appt .when{margin-top:5px;font-weight:800;font-size:13.5px;color:var(--brand)}
    .appt .addr{margin-top:5px;font-weight:600;font-size:12.5px;color:var(--muted);line-height:1.5}
    .cta{appearance:none;width:100%;margin-top:18px;border:0;border-radius:14px;background:var(--brand);
      color:#fff;font:900 14px/1 inherit;padding:16px;cursor:pointer;
      transition:filter .15s ease,transform .12s ease;box-shadow:0 10px 24px rgba(var(--brand-rgb),.28)}
    .cta:hover{filter:brightness(1.07)}
    .cta:active{transform:translateY(1px)}
    .cta:disabled{background:#e4e7ec;color:#98a2b3;cursor:default;box-shadow:none}
    .ghost{appearance:none;width:100%;margin-top:10px;border:1.5px solid #e4e7ec;border-radius:14px;
      background:#fff;color:var(--muted);font:800 13px/1 inherit;padding:15px;cursor:pointer;
      transition:border-color .15s ease,color .15s ease}
    .ghost:hover{border-color:#d0d5dd;color:var(--ink)}
    .check{width:64px;height:64px;margin:6px auto 18px;border-radius:50%;
      background:rgba(var(--brand-rgb),.10);display:grid;place-items:center;animation:pop .5s ease both}
    @keyframes pop{0%{transform:scale(.7);opacity:0}60%{transform:scale(1.08)}100%{transform:scale(1);opacity:1}}
    .check svg{width:30px;height:30px}
    .check path{stroke:var(--brand);stroke-width:3;fill:none;stroke-linecap:round;stroke-linejoin:round;
      stroke-dasharray:48;stroke-dashoffset:48;animation:draw .55s ease .25s forwards}
    @keyframes draw{to{stroke-dashoffset:0}}
    .portal{display:block;margin-top:16px;color:var(--brand);font-weight:800;font-size:13px;text-decoration:none}
    .foot{margin-top:26px;text-align:center;color:#b2bac6;font-size:10.5px;font-weight:700}
    .error{border:1px solid #fecdca;background:#fef3f2;color:#b42318;border-radius:14px;
      padding:14px;font-size:12.5px;font-weight:700;margin-top:14px}
    .loading{text-align:center;color:#98a2b3;font-weight:800;font-size:12px;padding:60px 0}
  </style>
</head>
<body>
<main>
  <div id="app"><div class="loading">Loading…</div></div>
  <div class="foot">Powered by FirstMate</div>
</main>
<script>
(function(){
  var token = ${tokenJson};
  var app = document.getElementById('app');
  var apiBase = (function(){
    var host = String(location.hostname || '').toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return location.protocol + '//' + location.hostname + ':3101/v1/appointments';
    return '/v1/appointments';
  })();
  var esc = function(value){ return String(value == null ? '' : value).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); };
  var view = null, submitting = false;

  function api(path, body){
    return fetch(apiBase + '/public/' + encodeURIComponent(token) + path, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: body ? {'Content-Type':'application/json','Accept':'application/json'} : {'Accept':'application/json'},
      body: body ? JSON.stringify(body) : undefined
    }).then(function(response){
      return response.json().catch(function(){ return null; }).then(function(json){
        if (!response.ok || (json && json.ok === false)) throw new Error((json && (json.message || json.error)) || 'Request failed');
        return json;
      });
    });
  }

  function hexToRgb(hex){
    var match = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!match) return '';
    var value = parseInt(match[1], 16);
    return ((value >> 16) & 255) + ',' + ((value >> 8) & 255) + ',' + (value & 255);
  }

  function applyBranding(branding){
    var primary = branding && branding.colors && branding.colors.primary;
    if (primary) {
      document.documentElement.style.setProperty('--brand', primary);
      var rgb = hexToRgb(primary);
      if (rgb) document.documentElement.style.setProperty('--brand-rgb', rgb);
    }
  }

  function brandbar(){
    var branding = view.branding || {};
    var name = branding.company_name || view.company_name || '';
    return '<div class="brandbar">'
      + (branding.logo ? '<img src="' + esc(branding.logo) + '" alt="' + esc(name) + '">' : '')
      + '<div class="name">' + esc(name) + '</div></div>';
  }

  function appointmentCards(){
    return (view.appointments || []).map(function(appointment){
      return '<div class="appt"><div class="title">' + esc(appointment.title) + '</div>'
        + '<div class="when">' + esc(appointment.when) + '</div>'
        + (appointment.address ? '<div class="addr">' + esc(appointment.address) + '</div>' : '')
        + '</div>';
    }).join('');
  }

  function portalLink(){
    return view.portal_url
      ? '<a class="portal" href="' + esc(view.portal_url) + '">View your project portal &rarr;</a>'
      : '';
  }

  function renderPrompt(){
    var many = (view.appointments || []).length > 1;
    var greeting = view.customer_first_name ? 'Hi ' + view.customer_first_name + ',' : 'Hi there,';
    app.innerHTML = brandbar() + '<div class="card">'
      + '<h1>' + (many ? 'Confirm your appointments' : 'Confirm your appointment') + '</h1>'
      + '<p class="sub">' + esc(greeting) + ' please let us know ' + (many ? 'these times still work' : 'this time still works') + ' for you.</p>'
      + appointmentCards()
      + '<button class="cta" id="yes" type="button">Yes, ' + (many ? 'they work' : 'it works') + '</button>'
      + '<button class="ghost" id="no" type="button">I need to reschedule</button>'
      + portalLink()
      + '</div>';
    document.getElementById('yes').addEventListener('click', function(){ respond('confirmed'); });
    document.getElementById('no').addEventListener('click', function(){ respond('declined'); });
  }

  function respond(outcome){
    if (submitting) return;
    submitting = true;
    var yes = document.getElementById('yes');
    var no = document.getElementById('no');
    if (yes) yes.disabled = true;
    if (no) no.disabled = true;
    api('/respond', { outcome: outcome })
      .then(function(){ renderResult(outcome); })
      .catch(function(error){
        submitting = false;
        if (yes) yes.disabled = false;
        if (no) no.disabled = false;
        showError(error);
      });
  }

  function renderResult(outcome){
    var confirmed = outcome === 'confirmed';
    app.innerHTML = brandbar() + '<div class="card">'
      + (confirmed ? '<div class="check"><svg viewBox="0 0 32 32"><path d="M7 17l6 6 12-13"/></svg></div>' : '')
      + '<h1>' + (confirmed ? 'You\\'re all set' : 'Thanks for letting us know') + '</h1>'
      + '<p class="sub">' + (confirmed
        ? 'Your appointment is confirmed and our team has been notified.'
        : 'We\\'ve let our team know you need a different time — someone will reach out shortly to reschedule.') + '</p>'
      + appointmentCards()
      + portalLink()
      + '</div>';
  }

  function showError(error){
    var existing = app.querySelector('.error');
    if (existing) existing.remove();
    var div = document.createElement('div');
    div.className = 'error';
    div.textContent = (error && error.message) || 'Something went wrong. Please try again.';
    (app.querySelector('.card') || app).appendChild(div);
  }

  api('')
    .then(function(result){
      view = result;
      applyBranding(view.branding);
      if (view.state && view.state.answered) renderResult(view.state.outcome);
      else renderPrompt();
    })
    .catch(function(error){
      app.innerHTML = '<div class="card"><h1>Link unavailable</h1><p class="sub">'
        + esc((error && error.message) || 'This confirmation link is no longer available.') + '</p></div>';
    });
})();
</script>
</body>
</html>`;
}
