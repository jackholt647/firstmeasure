import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { resolveBrowserExecutablePath } from "../documents/pdf.js";
import { inferSignatureDefinitions, signerPlan, validateSignature } from "../documents/signing/model.js";

test("shared-position fields retain independent signer identities and repeated placements share their field", async () => {
  const node = { type:"widget", props:{ widget:"doc.signature", config:{ output_keys:"primary,coowner", signer_ids:"owner,coowner", required:true } } };
  const defs = inferSignatureDefinitions({ pages:[{ children:[node,node] }] },{});
  assert.deepEqual(Object.keys(defs),["primary","coowner"]);
  const plan = signerPlan(defs,[{ signer_id:"owner",email:"person@example.test" },{ signer_id:"coowner",email:"person@example.test",capacity:"Trustee" }]);
  assert.deepEqual(plan.map(s=>s.fields),[["primary"],["coowner"]]);
  await assert.rejects(validateSignature({ type:"drawn", signer_name:"Person", image_data:"data:image/png;base64,AAAA" }), { code:"signature_image" });
});

test("signature modal requires PDF access and consent, and retains the form when persistence fails", async t => {
  const browser = await chromium.launch({ executablePath: await resolveBrowserExecutablePath(), headless:true });
  t.after(()=>browser.close());
  const page = await browser.newPage({ viewport:{width:1000,height:1000} });
  await page.route('http://signing.test/**', route => route.fulfill({contentType:'text/html',body:'<!doctype html><div id="signature" style="width:300px;height:100px"></div>'}));
  await page.goto('http://signing.test/');
  await page.addScriptTag({ content:"window.__name = fn => fn;" });
  for (const file of ["doc-model/firstmate-doc-model.js","doc-widgets/firstmate-doc-widgets.js"]) await page.addScriptTag({ content:await readFile(new URL(`../../libraries/${file}`,import.meta.url),"utf8") });
  await page.evaluate(()=>{
    const w = window as any; w.alert=()=>{}; w.open=()=>({location:{href:""},close(){}}); w.saved=0; w.outputs={};
    w.fetch=async (url:string)=>url.endsWith('/signing/prepare') ? new Response(JSON.stringify({ fields:["sig_customer"], challenge:"challenge", content_hash:"hash", disclosure:{text:"Review and retain the agreement.",hash:"disclosure"}, signer:{id:"customer",name:"Alice"} }),{status:200,headers:{"Content-Type":"application/json"}}) : new Response('%PDF-1.7\n',{status:200,headers:{"Content-Type":"application/pdf"}});
    w.FMDocWidgets.get('doc.signature',1).renderInteractive(document.getElementById('signature'),{ config:{ output_key:"sig_customer",signer:"customer" },outputs:w.outputs,api:{publicToken:"invitation"}, submitOutput:async (_key:string,value:any)=>{ w.saved++; if(w.saved===1) throw new Error('Network interruption'); w.accepted=value; return true; } });
  });
  await page.getByText('Click to sign',{exact:true}).click();
  await page.getByText('Open and save the agreement PDF',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Adopt & sign',exact:true}).click();
  assert.equal(await page.evaluate(()=>(window as any).saved),0);
  await page.getByText('Open and save the agreement PDF',{exact:true}).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button',{name:'Adopt & sign',exact:true}).click();
  await page.getByText('Network interruption',{exact:true}).waitFor();
  assert.equal(await page.locator('.fmdoc-modal-overlay').count(),1);
  assert.deepEqual(await page.evaluate(()=>(window as any).outputs),{});
  await page.getByRole('button',{name:'Adopt & sign',exact:true}).click();
  await page.locator('.fmdoc-modal-overlay').waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>(window as any).accepted.__signing.consent.disclosure_hash),'disclosure');
  assert.equal(await page.evaluate(()=>(window as any).outputs.sig_customer.__signing),undefined);
});

/** The send dialog's code from project.js, run on a blank page with the few things it uses stubbed (GP-27 preview included). */
async function mountSendDialog(t: any, preview: Record<string, unknown>, documentRecord: Record<string, unknown>, guides = "") {
  const browser = await chromium.launch({ executablePath:await resolveBrowserExecutablePath(),headless:true }); t.after(()=>browser.close());
  const page = await browser.newPage(); await page.setContent('<!doctype html><body></body>');
  const source = await readFile(new URL('../../libraries/apps/documents/project.js',import.meta.url),'utf8');
  const start = source.indexOf('    async function openSendModal(docRecord){'), end = source.indexOf('    function renderSendSuccess(',start);
  assert.ok(start>0 && end>start);
  await page.addScriptTag({ content:`
    ${guides}
    const objectValue=v=>v&&typeof v==='object'?v:{}; const arrayValue=v=>Array.isArray(v)?v:[];
    const cleanText=v=>String(v??'').trim(); const firstText=(...v)=>v.map(cleanText).find(Boolean)||'';
    // Trims, like the portal's escapeHtml (it cleans the text): the email preview must not lose its spaces to it.
    const esc=v=>String(v??'').trim().replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    const projectContacts=()=>[{name:'Customer',email:'customer@example.test',role:'customer'}];
    const orgId=()=> 'org'; const state={}; const loadDocs=()=>{}; const errorMessage=e=>e.message;
    const showToast=(title,message)=>{window.lastError=message;}; const renderSendSuccess=()=>{window.sent=true;};
    window.previewReads=0;
    const project=()=>({}); const api=()=>({request:async(path)=>{window.previewPath=path;window.previewReads++;return ${JSON.stringify(preview)};},documents:{settings:async()=>({settings:{}}),send:async(org,id,value)=>{window.sentValue=value;return{document:{id},emailed:[]};}}});
    const openModal=html=>{const el=document.createElement('div');el.innerHTML=html;document.body.appendChild(el);return{el,close(){el.remove();}};};
    ${source.slice(start,end)}
    openSendModal(${JSON.stringify(documentRecord)});
  ` });
  return page;
}

const PREVIEW = { from:{ name:"Acme Roofing", address:"acme@firstmatemail.com", kind:"firstmate_mail" }, subject:"Proposal: Smith roof", text:"Hi {name},\n\n{message}\n\nReview and respond here: {link}", default_message:"Your proposal is ready to review.", attachment:"Smith roof.pdf", email:{ on:true, can_set_up:true } };

test("send dialog assigns separate roles, skips unassigned optional roles and leaves the paper-copy contact to the server", async t => {
  const page = await mountSendDialog(t, PREVIEW, {id:'contract',title:'Smith roof',output_defs:{sig_customer:{type:'signature',required:true},sig_second:{type:'signature',signer_id:'second',required:true},sig_company:{type:'signature',signer:'internal',required:false}}});
  await page.waitForSelector('[data-send-go]');
  // GP-27: the e-sign "contact for paper copies" is the company's (signing/service.ts companyConsentContact): not asked here.
  assert.equal(await page.locator('[data-consent-contact]').count(),0);
  assert.equal(await page.evaluate(()=>(window as any).previewPath),'/organizations/org/documents/contract/send/preview');
  // The only contact signs as the customer, so their copy starts unticked; signing needs the link.
  assert.equal(await page.locator('[data-send-contact="0"]').isChecked(),false);
  assert.equal(await page.locator('[data-send-portal]').isDisabled(),true);
  await page.locator('[data-signer-role="second"] [data-signer-email]').fill('second@example.test');
  // Order and capacity are tucked away until wanted.
  await page.evaluate(() => document.querySelectorAll('details.fmdx-send-more').forEach(d => { (d as HTMLDetailsElement).open = true; }));
  await page.locator('[data-signer-role="second"] [data-signer-order]').fill('1');
  await page.locator('[data-send-go]').click();
  await page.waitForFunction('window.sent === true');
  const value = await page.evaluate(()=>(window as any).sentValue);
  assert.deepEqual(value.recipients.map((r:any)=>[r.signer_id,r.order]),[['customer',0],['second',1]]);
  assert.equal('consent_contact' in value, false);
});

test("send dialog previews the email as it will be sent: from the company's address, the note, the link and the PDF", async t => {
  const page = await mountSendDialog(t, PREVIEW, {id:'estimate',title:'Smith roof',output_defs:{}});
  await page.waitForSelector('[data-send-preview] .fmdx-send-mail');
  const mail = page.locator('[data-send-preview]');
  assert.match(await mail.locator('.fmdx-send-mail-head').innerText(), /acme@firstmatemail\.com/);
  assert.match(await mail.locator('.fmdx-send-mail-head').innerText(), /customer@example\.test/);
  assert.equal(await mail.locator('.fmdx-send-subject').innerText(),'Proposal: Smith roof');
  assert.equal(await mail.locator('.fmdx-send-mail-body').textContent(), 'Hi Customer,\n\nYour proposal is ready to review.\n\nReview and respond here: their own link to view it online');
  await page.locator('[data-send-message]').fill('Thanks for meeting with us today.');
  assert.match(await mail.locator('.fmdx-send-mail-body').innerText(), /Thanks for meeting with us today\./);
  assert.equal(await mail.locator('.fmdx-send-attach').innerText(),'Smith roof.pdf');
  // Without the link the email has no link line; without the PDF, no attachment.
  await page.locator('[data-send-portal]').uncheck();
  await page.locator('[data-send-pdf]').uncheck();
  assert.doesNotMatch(await mail.locator('.fmdx-send-mail-body').innerText(), /Review and respond/);
  assert.equal(await mail.locator('.fmdx-send-attach').count(),0);
  assert.equal(await mail.locator('.fmdx-send-warn').count(),1);
});

test("send dialog offers the company email setup once, before the dialog, where email is not set up", async t => {
  const guides = "window.played=[];window.FirstMateGuides={play:async(id,options)=>{window.played.push([id,options]);return{status:'dismissed'};},experience:()=>null};";
  const page = await mountSendDialog(t, { ...PREVIEW, from:{ name:"Acme Roofing", address:"", kind:"" }, email:{ on:false, can_set_up:true } }, {id:'estimate',title:'Smith roof',output_defs:{}}, guides);
  await page.waitForSelector('[data-send-preview] .fmdx-send-mail');
  assert.deepEqual(await page.evaluate(()=>(window as any).played),[['documents.send_email_setup',{}]]);
  // Skipped: the dialog reads where its email comes from again, and still offers the setup from the preview.
  assert.equal(await page.evaluate(()=>(window as any).previewReads),2);
  await page.locator('[data-send-email-setup]').click();
  await page.waitForFunction('window.played.length === 2');
  assert.deepEqual(await page.evaluate(()=>(window as any).played[1]),['documents.send_email_setup',{replay:true}]);
});
