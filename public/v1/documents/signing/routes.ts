import type { FastifyInstance } from "fastify";
import { badRequest } from "../../platform/errors.js";
import { pem, pemBlocks } from "./seal-ca.js";
import { documentSealer, sealTrustAnchors, verifySealedPdf } from "./seal.js";
import { ledgerEntryForSubject, verifyLedgerFrom } from "./ledger.js";
import { readSigningSetting } from "./store.js";

/**
 * Public seal endpoints: anyone holding an executed agreement can download our
 * root certificate and revocation list, and check a PDF is intact, sealed by
 * FirstMate and on record in the signing ledger. Nothing private is returned.
 */
export function registerSealRoutes(app: FastifyInstance) {
  app.get("/public/seal/root", async (_request, reply) => {
    const roots = await sealTrustAnchors();
    reply.header("Content-Type", "application/x-pem-file").header("Content-Disposition", 'attachment; filename="firstmate-document-root.pem"').header("Cache-Control", "public, max-age=3600");
    return roots.map(r => pem("CERTIFICATE", Buffer.from(r.raw))).join("");
  });
  app.get("/public/seal/crl", async (_request, reply) => {
    const crls = await documentSealer().then(s => s.crls).catch(async () => pemBlocks(String(((await readSigningSetting("development_seal_authority")) as any)?.crlPem || ""), "X509 CRL"));
    if (!crls[0]) throw badRequest("seal_crl_unavailable", "No revocation list is published.");
    reply.header("Content-Type", "application/pkix-crl").header("Cache-Control", "public, max-age=3600");
    return reply.send(crls[0]);
  });
  app.post("/public/seal/verify", { bodyLimit: 40 * 1024 * 1024 }, async request => {
    const body = (request.body && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>;
    const encoded = String(body.pdf_base64 || "");
    if (!encoded || encoded.length > 36 * 1024 * 1024) throw badRequest("seal_pdf_required", "Send the PDF as pdf_base64 (up to 25 MB).");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw badRequest("seal_pdf_required", "That file is not a PDF.");
    const result = await verifySealedPdf(bytes);
    const entry = await ledgerEntryForSubject(result.sha256);
    const ledger = entry ? await verifyLedgerFrom(entry.seq) : null;
    return { ok: true, verification: { ...result, on_record: !!entry && entry.kind === "sealed",
      ...(entry ? { recorded_at: entry.created_at, ledger: { ok: !!ledger?.ok, anchored_at: ledger?.anchor?.time || null, problem: ledger?.problem || null } } : {}) } };
  });
  app.get("/public/seal/verify", async (_request, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8").header("Cache-Control", "no-store");
    return VERIFY_PAGE;
  });
}

const VERIFY_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Check a signed agreement</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e2e2dc;--ok:#1f7a4a;--warn:#a15c00;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#1f1f1d;--ink:#ecece8;--muted:#a3a39c;--line:#33332f;--ok:#4cc38a;--warn:#f0a73c;--bad:#f97066}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:560px;margin:48px auto;padding:0 16px}h1{font-size:22px;margin:0 0 6px}p{color:var(--muted);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px}
label.drop{display:block;border:1.5px dashed var(--line);border-radius:10px;padding:28px;text-align:center;cursor:pointer}
input{display:none}#out{margin-top:18px}.row{display:flex;gap:8px;margin:6px 0}.row b{min-width:150px;font-weight:600}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.verdict{font-size:18px;font-weight:650;margin-bottom:10px}
a{color:inherit}</style></head><body><main>
<h1>Check a signed agreement</h1><p>Choose an executed agreement PDF. The file is checked on our server and is not stored.</p>
<div class="card"><label class="drop"><input id="f" type="file" accept="application/pdf"><span id="pick">Choose a PDF</span></label><div id="out"></div></div>
<p style="margin-top:16px"><a href="root">Download the FirstMate document root certificate</a></p>
</main><script>
const out=document.getElementById('out'),esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const row=(k,v)=>'<div class="row"><b>'+esc(k)+'</b><span>'+esc(v)+'</span></div>';
document.getElementById('f').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;document.getElementById('pick').textContent=file.name;out.textContent='Checking…';
const buf=new Uint8Array(await file.arrayBuffer());let bin='';for(let i=0;i<buf.length;i+=32768)bin+=String.fromCharCode.apply(null,buf.subarray(i,i+32768));
try{const r=await fetch('verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pdf_base64:btoa(bin)})});const j=await r.json();if(!r.ok)throw new Error(j.message||j.error||'Check failed');const v=j.verification;
let verdict=!v.sealed?['bad','Not sealed']:!v.intact?['bad','Changed after sealing']:!v.trusted?['warn','Intact, but not sealed by FirstMate']:v.certificate&&v.certificate.development?['warn','Intact; sealed with a development certificate']:['ok','Intact and sealed by FirstMate'];
let h='<div class="verdict '+verdict[0]+'">'+esc(verdict[1])+'</div>';if(v.reason)h+=row('Detail',v.reason);
if(v.certificate)h+=row('Sealed by',v.certificate.subject);if(v.timestamp)h+=row('Sealed at',new Date(v.timestamp.time).toLocaleString()+' (independent timestamp)');
h+=row('On record',v.on_record?'Yes, recorded '+new Date(v.recorded_at).toLocaleString():'No');if(v.ledger)h+=row('Signing ledger',v.ledger.ok?(v.ledger.anchored_at?'Intact; anchored '+new Date(v.ledger.anchored_at).toLocaleString():'Intact'):'Problem: '+v.ledger.problem);
h+=row('File SHA-256',v.sha256);out.innerHTML=h}catch(err){out.innerHTML='<div class="verdict bad">'+esc(err.message)+'</div>'}});
</script></body></html>`;
