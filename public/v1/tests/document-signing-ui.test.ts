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

test("send dialog assigns separate roles, skips unassigned optional roles and sends the consent contact", async t => {
  const browser = await chromium.launch({ executablePath:await resolveBrowserExecutablePath(),headless:true }); t.after(()=>browser.close());
  const page = await browser.newPage(); await page.setContent('<!doctype html><body></body>');
  const source = await readFile(new URL('../../libraries/apps/documents/project.js',import.meta.url),'utf8');
  const start = source.indexOf('    async function openSendModal(docRecord){'), end = source.indexOf('    function renderSendSuccess(',start);
  assert.ok(start>0 && end>start);
  await page.addScriptTag({ content:`
    const objectValue=v=>v&&typeof v==='object'?v:{}; const arrayValue=v=>Array.isArray(v)?v:[];
    const cleanText=v=>String(v??'').trim(); const firstText=(...v)=>v.map(cleanText).find(Boolean)||'';
    const esc=v=>String(v??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    const projectContacts=()=>[{name:'Customer',email:'customer@example.test',role:'customer'}];
    const orgId=()=> 'org'; const state={}; const loadDocs=()=>{}; const errorMessage=e=>e.message;
    const showToast=(title,message)=>{window.lastError=message;}; const renderSendSuccess=()=>{window.sent=true;};
    const project=()=>({}); const api=()=>({documents:{settings:async()=>({settings:{}}),send:async(org,id,value)=>{window.sentValue=value;return{document:{id},emailed:[]};}}});
    const openModal=html=>{const el=document.createElement('div');el.innerHTML=html;document.body.appendChild(el);return{el};};
    ${source.slice(start,end)}
    openSendModal({id:'contract',output_defs:{sig_customer:{type:'signature',required:true},sig_second:{type:'signature',signer_id:'second',required:true},sig_company:{type:'signature',signer:'internal',required:false}}});
  ` });
  await page.waitForSelector('[data-send-go]');
  await page.locator('[data-signer-role="second"] [data-signer-email]').fill('second@example.test');
  // Order, capacity and the paper-copy contact are tucked away until wanted.
  await page.evaluate(() => document.querySelectorAll('details.fmdx-send-more').forEach(d => { (d as HTMLDetailsElement).open = true; }));
  await page.locator('[data-signer-role="second"] [data-signer-order]').fill('1');
  await page.locator('[data-consent-contact]').fill('support@example.test');
  await page.locator('[data-send-go]').click();
  await page.waitForFunction('window.sent === true');
  const value = await page.evaluate(()=>(window as any).sentValue);
  assert.deepEqual(value.recipients.map((r:any)=>[r.signer_id,r.order]),[['customer',0],['second',1]]);
  assert.equal(value.consent_contact,'support@example.test');
});
