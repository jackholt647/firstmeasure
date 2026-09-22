// Feedback system API. Authenticated routes power the Feedback System company
// settings page; the /public/:token routes serve the customer-facing rating
// experience (a server-rendered, company-branded page — same pattern as the
// public proposal app).

import type { FastifyPluginAsync } from "fastify";
import { ZodError, z } from "zod";

import { requirePlatformAuth } from "../platform/auth.js";
import { PlatformError } from "../platform/errors.js";
import {
  feedbackRequestSummary,
  publicFeedbackView,
  readFeedbackSettings,
  recordFeedbackDestinationClick,
  recordFeedbackOpen,
  requestProjectFeedback,
  submitFeedbackRating,
  writeFeedbackSettings
} from "./service.js";

const objectBodySchema = z.object({}).passthrough();

const sendRequestSchema = z.object({
  project_id: z.string().trim().min(1).max(180),
  branch_id: z.string().trim().max(180).optional(),
  channels: z.array(z.enum(["sms", "email"])).max(2).optional(),
  source_key: z.string().trim().max(240).optional(),
  resend: z.boolean().optional()
});

const ratingSchema = z.object({
  rating: z.number().int().min(1).max(10),
  comment: z.string().max(4000).optional()
});

export const registerFeedbackApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({ ok: false, error: "validation_error", issues: error.issues });
    }
    if (error instanceof PlatformError) {
      reply.code(error.statusCode);
      return reply.send({ ok: false, error: error.code, message: error.message, details: error.details ?? null });
    }
    if (typeof (error as { statusCode?: unknown }).statusCode === "number") {
      reply.code(Number((error as { statusCode: number }).statusCode));
      return reply.send({
        ok: false,
        error: String((error as { code?: unknown }).code ?? "request_error"),
        message: String((error as { message?: unknown }).message ?? "The request could not be processed.")
      });
    }
    app.log.error(error);
    reply.code(500);
    return reply.send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  app.get("/", async () => ({
    ok: true,
    api: "feedback",
    message: "feedback API is mounted",
    endpoints: {
      settings: "/organizations/:orgId/branches/:branchId/settings",
      requests: "/organizations/:orgId/requests",
      publicApp: "/public/:token/app"
    }
  }));

  // ── Settings ──────────────────────────────────────────────────────────────

  app.get("/organizations/:orgId/branches/:branchId/settings", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings" });
    const result = await readFeedbackSettings(orgId, getParam(request.params, "branchId"));
    return { ok: true, ...result };
  });

  app.put("/organizations/:orgId/branches/:branchId/settings", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings", csrf: true });
    const body = objectBodySchema.parse(request.body ?? {});
    const result = await writeFeedbackSettings(orgId, getParam(request.params, "branchId"), body);
    return { ok: true, ...result };
  });

  // ── Requests ──────────────────────────────────────────────────────────────

  app.get("/organizations/:orgId/requests", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const query = asObject(request.query);
    const result = await feedbackRequestSummary(orgId, { project_id: cleanText(query.project_id) });
    return { ok: true, ...result };
  });

  app.post("/organizations/:orgId/requests", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: "manage_projects", csrf: true });
    const body = sendRequestSchema.parse(request.body ?? {});
    const result = await requestProjectFeedback(orgId, {
      ...body,
      source: { type: "user", user_id: cleanText(ctx.userId) }
    });
    return { ok: true, ...result };
  });

  // ── Public rating experience ──────────────────────────────────────────────

  app.get("/public/:token/app", async (request, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    return reply.send(publicFeedbackAppHtml(getParam(request.params, "token")));
  });

  app.get("/public/:token", async (request) => {
    const view = await publicFeedbackView(getParam(request.params, "token"));
    return { ok: true, ...view };
  });

  app.post("/public/:token/view", async (request) => {
    return await recordFeedbackOpen(getParam(request.params, "token"), publicRequestAudit(request));
  });

  app.post("/public/:token/rating", async (request) => {
    const body = ratingSchema.parse(request.body ?? {});
    const result = await submitFeedbackRating(getParam(request.params, "token"), body, publicRequestAudit(request));
    return result;
  });

  app.post("/public/:token/click", async (request) => {
    const body = objectBodySchema.parse(request.body ?? {});
    const result = await recordFeedbackDestinationClick(getParam(request.params, "token"), cleanText(body.destination_id));
    return result;
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

function publicRequestAudit(request: { ip?: string; headers?: Record<string, unknown> }) {
  const headers = request.headers || {};
  const header = (name: string) => cleanText(headers[name] || headers[name.toLowerCase()]);
  return {
    ip_address: header("x-forwarded-for").split(",")[0]?.trim() || header("cf-connecting-ip") || cleanText(request.ip),
    user_agent: header("user-agent"),
    referrer: header("referer") || header("referrer"),
    at: new Date().toISOString()
  };
}

function publicFeedbackAppHtml(token: string) {
  const tokenJson = JSON.stringify(token);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Share your feedback</title>
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
    .brandbar .name{font-size:14px;font-weight:900;letter-spacing:.02em;color:var(--ink)}
    .card{background:#fff;border:1px solid #e8ebf0;border-radius:22px;padding:30px 26px 28px;
      box-shadow:0 18px 50px rgba(16,24,40,.08);text-align:center;
      animation:cardIn .5s cubic-bezier(.2,.9,.3,1.2) both}
    @keyframes cardIn{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}
    h1{margin:0;font-size:23px;line-height:1.25;letter-spacing:-.02em}
    .sub{margin:10px 0 0;color:var(--muted);font-size:13px;line-height:1.55;font-weight:600}
    .stars{display:flex;justify-content:center;gap:8px;margin:26px 0 6px}
    .star{appearance:none;border:0;background:transparent;padding:4px;cursor:pointer;line-height:1;
      transition:transform .12s ease}
    .star svg{width:42px;height:42px;display:block}
    .star .fill{fill:#e4e7ec;transition:fill .15s ease}
    .star.lit .fill{fill:#f6b83c}
    .star:hover{transform:scale(1.14)}
    .star.pop{animation:pop .34s cubic-bezier(.2,1.2,.4,1) both}
    @keyframes pop{0%{transform:scale(1)}45%{transform:scale(1.32)}100%{transform:scale(1)}}
    .scale-hint{color:#98a2b3;font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase}
    .followup{max-height:0;overflow:hidden;opacity:0;transition:max-height .4s ease,opacity .35s ease .08s}
    .followup.open{max-height:320px;opacity:1}
    textarea{width:100%;margin-top:18px;border:1px solid #d8dde4;border-radius:14px;background:#fbfcfd;
      padding:13px 14px;min-height:88px;resize:vertical;color:var(--ink);
      font:600 13px/1.55 inherit;outline:0;transition:border-color .15s ease,box-shadow .15s ease}
    textarea:focus{border-color:var(--brand);box-shadow:0 0 0 4px rgba(var(--brand-rgb),.10);background:#fff}
    .cta{appearance:none;width:100%;margin-top:14px;border:0;border-radius:14px;background:var(--brand);
      color:#fff;font:900 14px/1 inherit;padding:16px;cursor:pointer;letter-spacing:.01em;
      transition:filter .15s ease,transform .12s ease;box-shadow:0 10px 24px rgba(var(--brand-rgb),.28)}
    .cta:hover{filter:brightness(1.07)}
    .cta:active{transform:translateY(1px)}
    .cta:disabled{background:#e4e7ec;color:#98a2b3;cursor:default;box-shadow:none}
    .check{width:64px;height:64px;margin:6px auto 18px;border-radius:50%;
      background:rgba(var(--brand-rgb),.10);display:grid;place-items:center;animation:pop .5s ease both}
    .check svg{width:30px;height:30px}
    .check path{stroke:var(--brand);stroke-width:3;fill:none;stroke-linecap:round;stroke-linejoin:round;
      stroke-dasharray:48;stroke-dashoffset:48;animation:draw .55s ease .25s forwards}
    @keyframes draw{to{stroke-dashoffset:0}}
    .dest{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;
      margin-top:12px;border:1.5px solid #e4e7ec;border-radius:15px;background:#fff;padding:15px 17px;
      cursor:pointer;text-align:left;font:800 14px/1.2 inherit;color:var(--ink);
      transition:border-color .15s ease,box-shadow .15s ease,transform .12s ease}
    .dest:hover{border-color:var(--brand);box-shadow:0 8px 22px rgba(var(--brand-rgb),.14);transform:translateY(-1px)}
    .dest .go{color:var(--brand);font-size:13px}
    .note{margin-top:18px;color:var(--muted);font-size:12px;line-height:1.6;font-weight:600}
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
    if (host === '127.0.0.1' || host === 'localhost') return location.protocol + '//' + location.hostname + ':3101/v1/feedback';
    return '/v1/feedback';
  })();
  var esc = function(value){ return String(value == null ? '' : value).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); };
  var view = null, selected = 0, submitting = false;

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
    return '<div class="brandbar">'
      + (branding.logo ? '<img src="' + esc(branding.logo) + '" alt="' + esc(branding.company_name) + '">' : '')
      + '<div class="name">' + esc(branding.company_name || '') + '</div></div>';
  }

  function starSvg(){
    return '<svg viewBox="0 0 24 24"><path class="fill" d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.4L12 17.4l-5.8 3 1.1-6.4L2.6 9.4l6.5-.9z"/></svg>';
  }

  function renderSurvey(){
    var survey = view.survey || {};
    var scale = Number(survey.scale) || 5;
    var stars = '';
    for (var i = 1; i <= scale; i += 1) {
      stars += '<button class="star' + (i <= selected ? ' lit' : '') + '" type="button" data-star="' + i + '" aria-label="' + i + ' of ' + scale + '">' + starSvg() + '</button>';
    }
    var first = view.state && view.state.contact_first_name;
    app.innerHTML = brandbar() + '<div class="card">'
      + '<h1>' + esc(survey.question || 'How did we do?') + '</h1>'
      + (first ? '<p class="sub">' + esc('Thanks for choosing us, ' + first + ' — it only takes a few seconds.') + '</p>' : '<p class="sub">It only takes a few seconds.</p>')
      + '<div class="stars">' + stars + '</div>'
      + '<div class="scale-hint" id="hint">Tap a star</div>'
      + '<div class="followup" id="followup">'
      +   '<textarea id="comment" placeholder="' + esc(survey.comment_prompt || 'Anything you\\'d like us to know?') + '"></textarea>'
      +   '<button class="cta" id="submit" type="button">Send feedback</button>'
      + '</div>'
      + '</div>';
    var buttons = app.querySelectorAll('[data-star]');
    Array.prototype.forEach.call(buttons, function(button){
      button.addEventListener('click', function(){
        selected = Number(button.dataset.star);
        Array.prototype.forEach.call(buttons, function(other){
          var lit = Number(other.dataset.star) <= selected;
          other.classList.toggle('lit', lit);
          other.classList.remove('pop');
        });
        button.classList.add('pop');
        document.getElementById('hint').textContent = ratingLabel(selected, Number((view.survey || {}).scale) || 5);
        var comment = document.getElementById('comment');
        if (comment) {
          var below = selected < Number((view.survey || {}).low_comment_below || 0);
          comment.placeholder = below
            ? String((view.survey || {}).low_comment_prompt || 'What could we have done better?')
            : String((view.survey || {}).comment_prompt || 'Anything you\\'d like us to know?');
        }
        document.getElementById('followup').classList.add('open');
      });
    });
    document.getElementById('submit').addEventListener('click', submit);
  }

  function ratingLabel(rating, scale){
    var ratio = rating / scale;
    if (ratio >= 0.99) return 'Excellent!';
    if (ratio >= 0.75) return 'Great';
    if (ratio >= 0.55) return 'Okay';
    if (ratio >= 0.35) return 'Not great';
    return 'Poor';
  }

  function submit(){
    if (!selected || submitting) return;
    submitting = true;
    var button = document.getElementById('submit');
    if (button) { button.disabled = true; button.textContent = 'Sending…'; }
    api('/rating', { rating: selected, comment: String((document.getElementById('comment') || {}).value || '') })
      .then(function(result){ renderResult(result); })
      .catch(function(error){
        submitting = false;
        if (button) { button.disabled = false; button.textContent = 'Send feedback'; }
        showError(error);
      });
  }

  function renderResult(result){
    var review = (result && result.review) || {};
    var message = (result && result.message) || 'Thank you for your feedback!';
    var html = brandbar() + '<div class="card">'
      + '<div class="check"><svg viewBox="0 0 32 32"><path d="M7 17l6 6 12-13"/></svg></div>'
      + '<h1>Thank you!</h1>'
      + '<p class="sub">' + esc(message) + '</p>';
    if (review.show_review && (review.destinations || []).length) {
      (review.destinations || []).forEach(function(destination){
        html += '<button class="dest" type="button" data-dest="' + esc(destination.id) + '"><span>' + esc(destination.label) + '</span><span class="go">&rarr;</span></button>';
      });
    }
    html += '</div>';
    app.innerHTML = html;
    Array.prototype.forEach.call(app.querySelectorAll('[data-dest]'), function(button){
      button.addEventListener('click', function(){
        api('/click', { destination_id: button.dataset.dest })
          .then(function(result){ if (result && result.url) window.location.href = result.url; })
          .catch(function(){ /* stay on the page */ });
      });
    });
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
      document.title = 'Share your feedback' + (view.branding && view.branding.company_name ? ' — ' + view.branding.company_name : '');
      if (view.state && view.state.rated) {
        renderResult({ message: view.message, review: view.review || {} });
      } else {
        renderSurvey();
      }
      api('/view', {}).catch(function(){ /* analytics only */ });
    })
    .catch(function(error){
      app.innerHTML = '<div class="card"><h1>Link unavailable</h1><p class="sub">' + esc((error && error.message) || 'This feedback link is no longer available.') + '</p></div>';
    });
})();
</script>
</body>
</html>`;
}
