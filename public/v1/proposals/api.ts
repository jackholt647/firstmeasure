import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { ZodError, z } from "zod";

import { PlatformError } from "../platform/errors.js";
import { requirePlatformAuth } from "../platform/auth.js";
import {
  archiveProposal,
  createProposal,
  createProposalSnapshot,
  duplicateProposal,
  findPublicProposalSnapshot,
  generateProposalPdf,
  listProjectProposals,
  listProposalEvents,
  listProposalSnapshots,
  patchProposal,
  completePublicProposalESign,
  publicProposalWorkflow,
  readProposal,
  readProposalPdfFile,
  readPublicProposalPdfFile,
  recordPublicProposalMockDepositPayment,
  recordPublicProposalPayLater,
  recordPublicProposalSignatureAdoption,
  recordPublicProposalSignatureSlot,
  recordPublicProposalSignature,
  recordPublicProposalView,
  sendProposal
} from "./storage.js";
import {
  archiveProposalSchema,
  createProposalSchema,
  createSnapshotSchema,
  duplicateProposalSchema,
  generatePdfSchema,
  patchProposalSchema,
  publicProposalEventSchema,
  sendProposalSchema
} from "./schemas.js";

const objectBodySchema = z.object({}).passthrough();

export const registerProposalsApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({ ok: false, error: "validation_error", issues: error.issues });
    }
    if (error instanceof PlatformError) {
      reply.code(error.statusCode);
      return reply.send({
        ok: false,
        error: error.code,
        message: error.message,
        details: error.details ?? null
      });
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
    api: "proposals",
    message: "proposals API is mounted",
    endpoints: {
      projectProposals: "/organizations/:orgId/projects/:projectId/proposals",
      proposal: "/organizations/:orgId/proposals/:proposalId",
      snapshots: "/organizations/:orgId/proposals/:proposalId/snapshots",
      duplicate: "/organizations/:orgId/proposals/:proposalId/duplicate",
      send: "/organizations/:orgId/proposals/:proposalId/send",
      pdf: "/organizations/:orgId/proposals/:proposalId/pdf",
      publicSnapshot: "/public/:token",
      publicPdf: "/public/:token/pdf"
    }
  }));

  app.get("/ping", async (request) => ({
    ok: true,
    api: "proposals",
    route: "/ping",
    method: request.method,
    receivedAt: new Date().toISOString()
  }));

  app.get("/organizations/:orgId/projects/:projectId/proposals", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const projectId = getParam(request.params, "projectId");
    const proposals = await listProjectProposals(orgId, projectId);
    return { ok: true, proposals, count: proposals.length };
  });

  app.post("/organizations/:orgId/projects/:projectId/proposals", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const projectId = getParam(request.params, "projectId");
    const body = createProposalSchema.parse(request.body ?? {});
    const proposal = await createProposal(orgId, projectId, body, ctx);
    reply.code(201);
    return { ok: true, proposal };
  });

  app.get("/organizations/:orgId/proposals/:proposalId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const proposal = await readProposal(orgId, getParam(request.params, "proposalId"));
    return { ok: true, proposal };
  });

  app.patch("/organizations/:orgId/proposals/:proposalId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = patchProposalSchema.parse(request.body ?? {});
    const proposal = await patchProposal(orgId, getParam(request.params, "proposalId"), body, ctx);
    return { ok: true, proposal };
  });

  app.post("/organizations/:orgId/proposals/:proposalId/duplicate", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = duplicateProposalSchema.parse(request.body ?? {});
    const proposal = await duplicateProposal(orgId, getParam(request.params, "proposalId"), body, ctx);
    reply.code(201);
    return { ok: true, proposal };
  });

  app.delete("/organizations/:orgId/proposals/:proposalId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = archiveProposalSchema.parse(request.body ?? {});
    const proposal = await archiveProposal(orgId, getParam(request.params, "proposalId"), body, ctx);
    return { ok: true, proposal };
  });

  app.get("/organizations/:orgId/proposals/:proposalId/snapshots", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const snapshots = await listProposalSnapshots(orgId, getParam(request.params, "proposalId"));
    return { ok: true, snapshots, count: snapshots.length };
  });

  app.post("/organizations/:orgId/proposals/:proposalId/snapshots", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = createSnapshotSchema.parse(request.body ?? {});
    const snapshot = await createProposalSnapshot(orgId, getParam(request.params, "proposalId"), body, ctx);
    reply.code(201);
    return { ok: true, snapshot };
  });

  app.post("/organizations/:orgId/proposals/:proposalId/send", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = sendProposalSchema.parse(request.body ?? {});
    const result = await sendProposal(orgId, getParam(request.params, "proposalId"), body, ctx);
    return { ok: true, ...result };
  });

  app.post("/organizations/:orgId/proposals/:proposalId/pdf", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "view_projects" });
    const body = generatePdfSchema.parse(request.body ?? {});
    const result = await generateProposalPdf(orgId, getParam(request.params, "proposalId"), body, ctx);
    const generated = result as Record<string, unknown>;
    return {
      ok: true,
      file_name: result.fileName,
      page_count: result.pageCount,
      media: result.media ?? null,
      media_ref: generated.media_ref ?? null,
      snapshot: result.snapshot ?? null
    };
  });

  app.get("/organizations/:orgId/proposals/:proposalId/pdf", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const query = asObject(request.query);
    const file = await readProposalPdfFile(orgId, getParam(request.params, "proposalId"), cleanText(query.media_id), cleanText(query.snapshot_id));
    return sendPdf(reply, file);
  });

  app.get("/organizations/:orgId/proposals/:proposalId/events", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const events = await listProposalEvents(orgId, getParam(request.params, "proposalId"));
    return { ok: true, events, count: events.length };
  });

  app.get("/public/:token/app", async (request, reply) => {
    const token = getParam(request.params, "token");
    reply.header("Content-Type", "text/html; charset=utf-8");
    return reply.send(publicProposalAppHtml(token));
  });

  app.get("/public/:token", async (request) => {
    const token = getParam(request.params, "token");
    const found = await publicProposalWorkflow(token);
    return { ok: true, snapshot: publicSnapshotView(found.snapshot, token, found.workflow), workflow: found.workflow };
  });

  app.get("/public/:token/pdf", async (request, reply) => {
    const file = await readPublicProposalPdfFile(getParam(request.params, "token"));
    return sendPdf(reply, file);
  });

  app.post("/public/:token/view", async (request) => {
    const body = publicProposalEventSchema.parse(request.body ?? {});
    const result = await recordPublicProposalView(getParam(request.params, "token"), body);
    const workflow = await publicProposalWorkflow(getParam(request.params, "token"));
    return { ok: true, snapshot: publicSnapshotView(result.snapshot, getParam(request.params, "token"), workflow.workflow), workflow: workflow.workflow };
  });

  app.post("/public/:token/esign/adopt", async (request) => {
    const body = objectBodySchema.parse(request.body ?? {});
    const result = await recordPublicProposalSignatureAdoption(getParam(request.params, "token"), body, publicRequestAudit(request));
    const workflow = await publicProposalWorkflow(getParam(request.params, "token"));
    return { ok: true, signature: result.signature, snapshot: publicSnapshotView(result.snapshot, getParam(request.params, "token"), workflow.workflow), workflow: workflow.workflow };
  });

  app.post("/public/:token/esign/slot", async (request) => {
    const body = objectBodySchema.parse(request.body ?? {});
    const result = await recordPublicProposalSignatureSlot(getParam(request.params, "token"), body, publicRequestAudit(request));
    const workflow = await publicProposalWorkflow(getParam(request.params, "token"));
    return { ok: true, slot: result.slot, snapshot: publicSnapshotView(result.snapshot, getParam(request.params, "token"), workflow.workflow), workflow: workflow.workflow };
  });

  app.post("/public/:token/esign/complete", async (request) => {
    const body = objectBodySchema.parse(request.body ?? {});
    const result = await completePublicProposalESign(getParam(request.params, "token"), body, publicRequestAudit(request));
    const workflow = await publicProposalWorkflow(getParam(request.params, "token"));
    return { ok: true, snapshot: publicSnapshotView(result.snapshot, getParam(request.params, "token"), workflow.workflow), workflow: workflow.workflow };
  });

  app.post("/public/:token/pay-later", async (request) => {
    const body = objectBodySchema.parse(request.body ?? {});
    const result = await recordPublicProposalPayLater(getParam(request.params, "token"), body, publicRequestAudit(request));
    const workflow = await publicProposalWorkflow(getParam(request.params, "token"));
    return { ok: true, snapshot: publicSnapshotView(result.snapshot, getParam(request.params, "token"), workflow.workflow), workflow: workflow.workflow };
  });

  app.post("/public/:token/payments/mock-deposit", async (request) => {
    const body = objectBodySchema.parse(request.body ?? {});
    const result = await recordPublicProposalMockDepositPayment(getParam(request.params, "token"), body, publicRequestAudit(request));
    const workflow = await publicProposalWorkflow(getParam(request.params, "token"));
    return {
      ok: true,
      payment: result.payment,
      allocations: result.allocations,
      snapshot: publicSnapshotView(result.snapshot, getParam(request.params, "token"), workflow.workflow),
      workflow: workflow.workflow
    };
  });

  app.post("/public/:token/sign", async (request) => {
    const body = objectBodySchema.parse(request.body ?? {});
    const result = await recordPublicProposalSignature(getParam(request.params, "token"), body);
    const workflow = await publicProposalWorkflow(getParam(request.params, "token"));
    return { ok: true, snapshot: publicSnapshotView(result.snapshot, getParam(request.params, "token"), workflow.workflow), workflow: workflow.workflow };
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

function sendPdf(reply: FastifyReply, file: { contentType: string; fileName: string; bytes: Buffer }) {
  reply.header("Content-Type", file.contentType || "application/pdf");
  reply.header("Content-Disposition", `inline; filename="${String(file.fileName || "proposal.pdf").replace(/"/g, "")}"`);
  return reply.send(file.bytes);
}

function publicRequestAudit(request: { ip?: string; headers?: Record<string, unknown> }) {
  const headers = request.headers || {};
  const header = (name: string) => cleanText(headers[name] || headers[name.toLowerCase()]);
  const forwarded = header("x-forwarded-for").split(",")[0]?.trim();
  return {
    ip_address: forwarded || header("cf-connecting-ip") || cleanText(request.ip),
    user_agent: header("user-agent"),
    accept_language: header("accept-language"),
    referrer: header("referer") || header("referrer"),
    forwarded_for: header("x-forwarded-for"),
    request_id: header("x-request-id") || header("cf-ray") || header("x-vercel-id"),
    geo: {
      country: header("cf-ipcountry") || header("x-vercel-ip-country") || header("x-appengine-country"),
      region: header("x-vercel-ip-country-region") || header("x-appengine-region"),
      city: header("x-vercel-ip-city") || header("x-appengine-city"),
      latitude: header("x-vercel-ip-latitude") || header("x-appengine-citylatlong").split(",")[0],
      longitude: header("x-vercel-ip-longitude") || header("x-appengine-citylatlong").split(",")[1],
      source: header("cf-ipcountry") ? "cloudflare_headers" : header("x-vercel-ip-country") ? "vercel_headers" : header("x-appengine-country") ? "appengine_headers" : ""
    }
  };
}

function publicProposalAppHtml(token: string) {
  const tokenJson = JSON.stringify(token);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proposal</title>
  <script>
    window.__APP = window.__APP || {};
    window.__APP.proposalsApiBase = (function(){
      var host = String(location.hostname || '').toLowerCase();
      if (host === '127.0.0.1' || host === 'localhost') return location.protocol + '//' + location.hostname + ':3111/v1/proposals';
      return '/v1/proposals';
    })();
    window.__PUBLIC_PROPOSAL_TOKEN = ${tokenJson};
  </script>
  <script defer src="/libraries/proposals-api/proposals-api.js"></script>
  <style>
    body{margin:0;background:#f4f6f8;color:#111827;font-family:Montserrat,Arial,sans-serif}
    main{max-width:920px;margin:0 auto;padding:28px 18px 52px}
    article{background:#fff;border:1px solid #d7dbe2;border-top:4px solid #2563eb;border-radius:8px;padding:18px;margin:14px 0}
    h1,h2,h3{margin:0 0 10px} p{color:#4b5563;line-height:1.55}
    button{border:0;border-radius:7px;padding:11px 14px;background:#2563eb;color:white;font-weight:800;cursor:pointer}
    button.secondary{background:#eef2f7;color:#111827}.row{display:flex;gap:10px;flex-wrap:wrap}.muted{color:#6b7280}
    .signature{font-family:"Brush Script MT","Segoe Script",cursive;font-size:28px;color:#111827}
    .pay{background:#ecfdf5;border-color:#86efac}
  </style>
</head>
<body>
<main id="app">Loading proposal...</main>
<script>
(function(){
  const token = window.__PUBLIC_PROPOSAL_TOKEN || '';
  const app = document.getElementById('app');
  const fmt = cents => (Number(cents || 0) / 100).toLocaleString(undefined,{style:'currency',currency:'USD'});
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let data = null, name = '';
  async function api(path, body){
    const res = await fetch(window.__APP.proposalsApiBase + '/public/' + encodeURIComponent(token) + path, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: body ? {'Content-Type':'application/json','Accept':'application/json'} : {'Accept':'application/json'},
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.message || json.error || 'Request failed');
    return json;
  }
  function pages(){
    const proposal = data.workflow?.proposal || {};
    return (proposal.pages || []).map((page) => '<article><h3>' + esc(page.title || page.kind || 'Page') + '</h3>' +
      (page.summary ? '<p>'+esc(page.summary)+'</p>' : '') +
      (page.body ? '<p>'+esc(page.body)+'</p>' : '') +
      (page.line_items ? '<div>' + page.line_items.map(i => '<p><b>'+esc(i.label)+'</b> '+esc(i.amount)+'</p>').join('') + '</div>' : '') +
      (['signature','fine_print'].includes(String(page.kind).toLowerCase()) ? '<p class="muted">' + (page.signed ? 'Signed' : 'Signature required') + '</p>' : '') +
      '</article>').join('');
  }
  function render(){
    const wf = data.workflow || {};
    const proposal = wf.proposal || {};
    const payment = wf.payment || {};
    const signed = !!wf.proposal?.workflow?.signed || data.snapshot?.status === 'signed';
    const paid = String(data.snapshot?.customer_payment?.status || '').includes('paid') || Number(payment.deposit_due_cents || 0) <= 0 && Number(payment.deposit_amount_cents || 0) > 0;
    app.innerHTML = '<h1>'+esc(proposal.title || data.snapshot?.title || 'Proposal')+'</h1>' +
      '<p class="muted">Review, sign, and pay the required deposit.</p>' + pages() +
      (!signed ? '<article><h2>Sign proposal</h2><p>Adopt your signature, then complete the document.</p><input id="signName" placeholder="Full legal name" value="'+esc(name)+'"><div class="row"><button id="adopt">Adopt signature</button><button id="complete" class="secondary">Complete document</button></div><p class="signature">'+esc(name || 'Your Signature')+'</p></article>' :
      !paid ? '<article class="pay"><h2>Deposit due</h2><p>Total '+fmt(payment.total_cents)+' includes sales tax '+fmt(payment.tax_cents)+'. Deposit due now: <b>'+fmt(payment.deposit_due_cents)+'</b>.</p><div class="row"><button id="pay">Pay deposit</button><button id="later" class="secondary">Pay later</button></div></article>' :
      '<article class="pay"><h2>Thank you</h2><p>Your proposal is signed and the deposit payment is recorded. The next step is waiting to schedule the work.</p></article>');
    document.getElementById('signName')?.addEventListener('input', e => { name = e.target.value; render(); });
    document.getElementById('adopt')?.addEventListener('click', adopt);
    document.getElementById('complete')?.addEventListener('click', complete);
    document.getElementById('pay')?.addEventListener('click', pay);
    document.getElementById('later')?.addEventListener('click', later);
  }
  async function load(){ data = await api(''); await api('/view', { path: location.pathname + location.search }).catch(()=>{}); render(); }
  async function adopt(){ name = document.getElementById('signName')?.value || name; data = await api('/esign/adopt', { signer_name: name, signature: { type:'typed', text:name, style:'signature' } }); render(); }
  async function complete(){ if (!name) name = document.getElementById('signName')?.value || ''; if (!name) return alert('Enter your full name first.'); await adopt().catch(()=>{}); data = await api('/esign/complete', { signer_name: name, signature: { type:'typed', text:name, style:'signature' } }); render(); }
  async function pay(){ app.insertAdjacentHTML('beforeend','<article class="pay"><h2>Processing payment...</h2></article>'); data = await api('/payments/mock-deposit', {}); render(); }
  async function later(){ data = await api('/pay-later', {}); render(); }
  load().catch(error => { app.innerHTML = '<article><h1>Proposal unavailable</h1><p>'+esc(error.message)+'</p></article>'; });
})();
</script>
</body>
</html>`;
}

function publicSnapshotView(snapshot: Record<string, unknown>, token = "", workflow: Record<string, unknown> | null = null) {
  const delivery = asObject(snapshot.delivery);
  const pdfPath = token ? `/v1/proposals/public/${encodeURIComponent(token)}/pdf` : "";
  return {
    id: cleanText(snapshot.id),
    proposal_id: cleanText(snapshot.proposal_id),
    project_id: cleanText(snapshot.project_id),
    title: cleanText(snapshot.title || "Proposal"),
    status: cleanText(snapshot.status || delivery.state || "sent"),
    snapshot_number: Number(snapshot.snapshot_number || 0),
    content: asObject(snapshot.content),
    resources: asObject(snapshot.resources),
    contacts: Array.isArray(snapshot.contacts) ? snapshot.contacts : Array.isArray(snapshot.participants) ? snapshot.participants : [],
    delivery: {
      state: cleanText(delivery.state || "sent"),
      sent_at: cleanText(delivery.sent_at),
      first_viewed_at: cleanText(delivery.first_viewed_at),
      last_viewed_at: cleanText(delivery.last_viewed_at),
      signed_at: cleanText(delivery.signed_at)
    },
    pdf: asObject(snapshot.pdf),
    pdf_url: pdfPath,
    app_url: token ? `/v1/proposals/public/${encodeURIComponent(token)}/app` : "",
    document_html: cleanText(snapshot.document_html),
    signatures: asObject(snapshot.signatures),
    customer_payment: asObject(snapshot.customer_payment),
    workflow: workflow ? asObject(workflow) : {},
    created_at: cleanText(snapshot.created_at),
    updated_at: cleanText(snapshot.updated_at)
  };
}
