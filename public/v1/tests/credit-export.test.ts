import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {creditExportRow,creditExportPage} from '../internal/credit_export.js';
const org={id:'a',name:'Fixture'};
test('credit export separates paid and bonus without splitting transactions or guessing history',()=>{
 const row=creditExportRow(org,{delta:625,reason:'stripe_checkout_paid',meta:{paid_dollars:500,bonus_dollars:125}},1);
 assert.equal(row.delta_dollars,625);assert.equal(row.paid_dollars,500);assert.equal(row.bonus_dollars,125);
 assert.equal(creditExportRow(org,{delta:625,reason:'stripe_checkout_paid',meta:{amount_total:50000}},1).bonus_dollars,125);
 assert.equal(creditExportRow(org,{delta:625,reason:'stripe_checkout_paid'},1).paid_dollars,null);
 assert.equal(creditExportRow(org,{delta:100,reason:'stripe_auto_topup'},1).paid_dollars,100);
 assert.equal(creditExportRow(org,{delta:30,reason:'promotional_bonus'},1).bonus_dollars,30);
 assert.equal(creditExportRow(org,{delta:30,reason:'manual_adjustment'},1).paid_dollars,null);
 assert.equal(creditExportRow(org,{delta:-12,reason:'order_charge'},1).delta_dollars,-12);
 assert.equal(creditExportRow(org,{delta:12,reason:'cancellation_refund'},1).category,'refund_or_reversal');
 assert.equal(creditExportRow(org,{delta:625,reason:'stripe_checkout_paid',meta:{paid_dollars:700}},1).paid_bonus_basis,'inconsistent_metadata');
});

test('browser downloads complete ledger pages and refuses partial or repeated pages',async()=>{
 const source=readFileSync(new URL('../../measure/internal/portal_scripts/customers.js',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('  async function exportCreditLedger('),source.indexOf('  async function exportUsersTsv('));
 async function run(pages:any[]){
  let calls=0,downloaded=0;const errors:string[]=[];const button={innerHTML:'Export',disabled:false,textContent:''};
  const context=vm.createContext({document:{getElementById:()=>button,createElement:()=>({click:()=>downloaded++,remove(){}}),body:{appendChild(){}}},window:{Portal:{apiPost:async()=>pages[Math.min(calls++,pages.length-1)]}},apiServer:()=>'',alert:(s:string)=>errors.push(s),tsvCell:(v:any)=>String(v),Blob,URL:{createObjectURL:()=>'',revokeObjectURL(){}},setTimeout:(fn:()=>void)=>fn()});
  await vm.runInContext(code+';exportCreditLedger()',context);assert.equal(button.disabled,false);return {downloaded,errors,calls};
 }
 const first={success:true,rows:[{organization_id:'a',ledger_ordinal:1}],next_cursor:{org_id:'a',offset:1,resume:true}};
 assert.equal((await run([first,{success:true,rows:[{organization_id:'a',ledger_ordinal:2}],next_cursor:null}])).downloaded,1);
 for(const pages of [[first,{success:false,error:'timeout'}],[first,first],[{success:true,rows:[]}]] ){
  const result=await run(pages);assert.equal(result.downloaded,0);assert.equal(result.errors.length,1);
 }
});
test('ledger pagination covers large histories, exact boundaries, empty organizations, and duplicate timestamps',()=>{
 const orgs=Array.from({length:54},(_,i)=>({id:String(i).padStart(3,'0')}));
 const ledger=new Map(orgs.map((org,i)=>[org.id,Array.from({length:i===0?500:i===1?1001:i===26?0:3},()=>({ts:'2026-09-01',delta:1,reason:'fixture'}))]));
 let cursor:any=null;const keys:string[]=[];let pages=0;
 do{
  const candidates=orgs.filter(o=>!cursor || o.id>cursor.org_id || cursor.resume && o.id===cursor.org_id).slice(0,26);
  const page=creditExportPage(candidates.slice(0,25),ledger,cursor?.org_id??'',cursor?.offset??0,candidates.length>25);
  assert.ok(page.rows.length<=500);keys.push(...page.rows.map(r=>`${r.organization_id}:${r.ledger_ordinal}`));cursor=page.next_cursor;
  assert.ok(++pages<20);
 }while(cursor);
 const expected=orgs.flatMap(o=>(ledger.get(o.id)??[]).map((_,i)=>`${o.id}:${i+1}`));
 assert.deepEqual(keys,expected);assert.equal(new Set(keys).size,expected.length);
});
