import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../../libraries/apps/settings/platform-billing.js',import.meta.url),'utf8');
const root={};vm.runInNewContext(source,{window:root});
const {statementRows,statementCsv}=root.FirstMatePlatformBilling;
const period='2026-09';
const credits=[
  {id:'buy',ts:'2026-09-04T00:00:00Z',reason:'stripe_checkout_paid',delta:120,meta:{amount_total:10000,paid_dollars:100}},
  {id:'order',ts:'2026-09-05T00:00:00Z',reason:'order_submitted',delta:-25},
  {id:'refund',ts:'2026-09-06T00:00:00Z',reason:'cancellation_refund',delta:25,meta:{amount_total:2500}},
  {id:'auto',ts:'2026-09-07T00:00:00Z',reason:'stripe_auto_topup',delta:50},
  {id:'promo',ts:'2026-09-08T00:00:00Z',reason:'coupon_redeem',delta:10},
  {id:'unknown',ts:'2026-09-09T00:00:00Z',reason:'stripe_checkout_paid',delta:30},
];
const platform={recurring_invoices:[{id:'sub',created_at:'2026-09-12T00:00:00Z',status:'paid',total_cents:3000,amount_paid_cents:2500,lines:[{label:'SMS',amount_cents:3000}]}],invoices:[{id:'usage',period:'2026-08',created_at:'2026-09-04T00:00:00Z',status:'open',total_cents:700,lines:[]},{id:'future',period:'2026-09',created_at:'2026-10-04T00:00:00Z',status:'paid',total_cents:900}]};
test('one chronological statement combines credit ledger, subscription and usage invoices without double counting prepaid orders',()=>{
  const rows=statementRows(period,credits,platform);
  assert.equal(rows.length,8);assert.equal(rows[0].id,'subscriptions-sub');
  assert.equal(rows.reduce((sum,r)=>sum+(r.paid||0),0),17500);
  assert.equal(rows.reduce((sum,r)=>sum+r.due,0),700);
  assert.equal(rows.reduce((sum,r)=>sum+(r.credits||0),0),210);
  assert.equal(rows.find(r=>r.id==='credit-refund').paid,null);
  assert.equal(rows.find(r=>r.id==='credit-unknown').paid,null);
  assert.equal(rows.find(r=>r.id==='usage-usage').detail,'Service month 2026-08');
});
test('statement export includes all services and keeps unknown cash amounts blank',()=>{
  const csv=statementCsv(statementRows(period,credits,platform));
  for(const value of ['credits','subscriptions','usage','25.00','100.00'])assert.ok(csv.includes(value));
  assert.ok(csv.includes('Measurement credit change'));
  assert.ok(!csv.includes('future'));
});
test('CSV escapes formulas and quotes in user-controlled labels',()=>{
  const rows=statementRows(period,[credits[0]],{},()=>({title:'=HYPERLINK("bad")',detail:'@SUM(1)'}));
  const csv=statementCsv(rows);assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));assert.ok(csv.includes('"\'@SUM(1)"'));
});
test('month boundaries and duplicate invoice identifiers across systems are preserved',()=>{
  const rows=statementRows('2026-10',[],platform);assert.equal(rows.length,1);assert.equal(rows[0].id,'usage-future');
  assert.equal(statementRows(period,[],{invoices:[platform.invoices[0]],recurring_invoices:[{...platform.recurring_invoices[0],id:'usage'}]}).length,2);
});

test('cohesive workspace responds to filters, month races, failures, invoice details and read-only access',async()=>{
  const {chromium}=await import('playwright-core');
  const executablePath=process.env.CHROME_PATH || (process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium');
  const browser=await chromium.launch({executablePath,headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1400,height:1000}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent('<main style="padding:24px;font-family:Arial"><div id="billing"></div></main>');
    await page.addScriptTag({path:new URL('../../libraries/platform-commerce/platform-commerce.js',import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1')});
    await page.evaluate(()=>window.PlatformCommerce.set({currency:'USD',credit_display:'currency',report_prices:{residential:7}}));
    await page.addScriptTag({content:source});
    await page.evaluate(({credits,platform})=>{
      const month=new Date().toISOString().slice(0,7);const move=date=>month+date.slice(7);
      window.fixture={...platform,can_manage:true,operator:false,account:{},prices:[],subscriptions:[{id:'ai',product_id:'ai',price:{name:'AI access',description:'AI tools for your team',monthly_cents:2000,rates:[]}}],purchases:[],estimate:{total_cents:700,lines:[]},meters:[],late_usage:[]};
      for(const items of [fixture.invoices,fixture.recurring_invoices])items.forEach(item=>item.created_at=move(item.created_at));
      window.PlatformAPI={baseUrl:()=>'/v1/platform',request:async url=>{if(url.includes('2020-01'))await new Promise(r=>setTimeout(r,150));if(window.failPlatform)throw Error('offline');return structuredClone(fixture);}};
      window.creditOptions={statement:async()=>window.failCredits?{ok:false}:{ok:true,transactions:credits.map(c=>({...c,ts:move(c.ts)}))},settings:()=>({enabled:true,amount:100,threshold:25,card:'Visa ending in 4242'}),open:()=>window.topupOpened=true,refreshBalance:()=>{document.querySelectorAll('.credits-val-target').forEach(el=>el.textContent='$210');}};
      return window.FirstMatePlatformBilling.mountWorkspace(document.getElementById('billing'),{orgId:'test',credits:creditOptions});
    },{credits,platform});
    assert.equal(await page.getByRole('heading',{name:'Monthly statement',exact:true}).count(),1);
    assert.equal(await page.getByRole('navigation',{name:'Billing views'}).count(),0);
    await page.getByRole('button',{name:'Manage',exact:true}).click();assert.equal(await page.evaluate(()=>window.topupOpened),true);
    await page.getByLabel('Filter history').selectOption('subscriptions');assert.equal(await page.locator('tbody tr').count(),1);
    await page.getByRole('button',{name:'Details',exact:true}).click();await page.getByRole('dialog',{name:'Subscription invoice'}).waitFor();assert.ok((await page.getByRole('dialog').innerText()).includes('SMS'));await page.getByRole('button',{name:'Close Subscription invoice'}).click();
    await page.getByLabel('Filter history').selectOption('all');
    for(const width of [1400,900,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
    // A slow older-month response must not overwrite the latest selection.
    await page.getByLabel('Statement month').fill('2020-01');await page.getByLabel('Statement month').dispatchEvent('change');
    await page.getByLabel('Statement month').fill('2020-02');await page.getByLabel('Statement month').dispatchEvent('change');await page.waitForTimeout(200);
    assert.equal(await page.getByLabel('Statement month').inputValue(),'2020-02');
    await page.evaluate(()=>{window.failCredits=true;return document.getElementById('billing')._billingRefresh();});
    assert.ok((await page.locator('.bw-error').innerText()).includes('Totals are incomplete'));assert.equal(await page.getByRole('button',{name:'Export CSV'}).isDisabled(),true);
    await page.evaluate(()=>{window.failCredits=false;fixture.can_manage=false;return document.getElementById('billing')._billingRefresh();});
    assert.equal(await page.getByRole('button',{name:'Add subscription',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Cancel renewal'}).count(),0);
    await page.evaluate(()=>FirstMatePlatformBilling.mountWorkspace(document.getElementById('billing'),{orgId:'test'}));
    assert.equal(await page.getByRole('button',{name:'Add credit',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Manage',exact:true}).count(),0);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
