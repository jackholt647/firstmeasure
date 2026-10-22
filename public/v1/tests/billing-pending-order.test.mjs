// 1M8-198 / 1M8-218: an order saved before a credit top-up is resubmitted
// against the quote the order screen showed, in the organization's currency,
// with both pricing revisions the server checks.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const commerceSource=await readFile(new URL('../../libraries/platform-commerce/platform-commerce.js',import.meta.url),'utf8');
const billingSource=await readFile(new URL('../../libraries/apps/billing/app.js',import.meta.url),'utf8');

function element(){
  return {style:{},dataset:{},classList:{add(){},remove(){},contains:()=>false,toggle(){}},innerHTML:'',textContent:'',value:'',
    querySelector:()=>element(),querySelectorAll:()=>[],appendChild(){},append(){},addEventListener(){},removeEventListener(){},setAttribute(){},removeAttribute(){},remove(){},closest:()=>null};
}
function storage(){const map=new Map();return {getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)};}

function loadBilling({profile,balance,fulfill}){
  const posts=[],toasts=[];
  const credits={lastCredits:balance,refreshCredits:async()=>({ok:true})};
  const window={
    Portal:{
      cfg:{},appFlags:{current:()=>({}),has:()=>true},
      util:{$:()=>null,injectCSS(){},hasPerm:()=>true,postAction:async(action,payload)=>{posts.push({action,payload});
        if(action==='queue')return {data:{success:true,folder:'f1',project:{id:'p1'}}};
        if(action==='stripe_fulfill_session')return {data:fulfill};
        return {data:{}};}},
      ui:{showToast:(title,body,ok)=>toasts.push({title,body,ok})},
      credits,
      navigation:{replace(){}}
    },
    addEventListener(){},dispatchEvent(){},location:{search:'',href:''},
    localStorage:storage(),sessionStorage:storage(),
    setTimeout:(fn)=>{fn();return 0;},clearTimeout(){},
  };
  window.window=window;window.globalThis=window;
  window.document={readyState:'complete',body:element(),head:element(),documentElement:element(),createElement:element,getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){}};
  window.CustomEvent=class{constructor(type,init){this.type=type;this.detail=init?.detail;}};
  window.queueMicrotask=fn=>fn();
  window.console=console;window.Intl=Intl;window.URLSearchParams=URLSearchParams;window.Date=Date;window.Promise=Promise;window.JSON=JSON;window.Math=Math;window.Number=Number;window.String=String;
  const context=vm.createContext(window);
  vm.runInContext(commerceSource,context);
  vm.runInContext(billingSource,context);
  window.PlatformCommerce.set(profile);
  return {window,posts,toasts,credits};
}

const EUR={currency:'EUR',credit_display:'currency',report_prices:{residential:25,commercial:50,multifamily:50,gutters:5,weather:10,instant_residential:5,instant_commercial:10,instant_multifamily:10}};

function pending(window,fields){
  window.localStorage.setItem('fm_pending_order_v1',JSON.stringify({v:3,ts:Date.now(),fields:{address:'1 Rue de Test, Paris',project_type:'residential',wants_roof_report:'1',report_mode:'standard',pins:'[{}]',...fields}}));
}

test('EUR resubmit after a top-up sends the server quote revisions and uses the shown quote',async()=>{
  const {window,posts,toasts}=loadBilling({profile:EUR,balance:35});
  pending(window,{include_weather_report:'1',weather_addon:'1',report_expedite_option:'standard_3_6',report_expedite_unit_price:'25',report_expedite_net_total_price:'35',report_pricing_revision:'2',report_market_revision:'3',order_original_amount:'35',order_quoted_amount:'35'});
  posts.length=0;
  assert.equal(await window.Portal.modules.billing.tryAutoSubmitPending('stripe_return'),true,JSON.stringify(toasts));
  const queued=posts.find(p=>p.action==='queue');
  assert.ok(queued,'order was resubmitted');
  assert.equal(queued.payload.report_market_revision,'3');
  assert.equal(queued.payload.report_pricing_revision,'2');
  assert.equal(window.localStorage.getItem('fm_pending_order_v1'),null);
});

test('a pending order is never priced above its server quote by local recomputation',async()=>{
  // Older pending orders carry only the expedite net total. Recomputing locally
  // (EUR 25 report + weather) must not override the EUR 20 server quote and
  // leave a topped-up order unsubmitted.
  const {window,posts}=loadBilling({profile:EUR,balance:20});
  pending(window,{include_weather_report:'1',report_expedite_option:'standard_3_6',report_expedite_unit_price:'25',report_expedite_net_total_price:'20',report_market_revision:'3'});
  posts.length=0;
  assert.equal(await window.Portal.modules.billing.tryAutoSubmitPending('stripe_return'),true);
  assert.ok(posts.some(p=>p.action==='queue'));
});

test('without a quote the fallback uses the organization prices, per structure for weather',async()=>{
  const {window,posts,toasts}=loadBilling({profile:EUR,balance:44});
  pending(window,{project_type:'residential',include_weather_report:'1',pins:'[{},{}]'});
  posts.length=0;
  // EUR 25 report + 2 x EUR 10 weather = EUR 45; EUR 44 is not enough.
  assert.equal(await window.Portal.modules.billing.tryAutoSubmitPending('stripe_return'),false);
  assert.equal(posts.some(p=>p.action==='queue'),false);
  const toast=toasts.at(-1);
  assert.equal(toast.title,'Order not submitted yet');
  assert.match(toast.body,/45/);assert.match(toast.body,/€/);assert.doesNotMatch(toast.body,/\$/);
});

test('a paid checkout held for review tells the customer and keeps the order',async()=>{
  const {window,posts,toasts}=loadBilling({profile:EUR,balance:0,fulfill:{success:false,needs_review:true,code:'amount_below_credit_value',customer_message:'We received your payment.'}});
  pending(window,{order_original_amount:'25',order_quoted_amount:'25'});
  posts.length=0;
  assert.equal(await window.Portal.modules.billing.reconcileStripeCheckout({paid:'1',sessionId:'cs_test_review'}),false);
  assert.equal(posts.filter(p=>p.action==='stripe_fulfill_session').length,1,'a held payment is not polled');
  assert.equal(posts.some(p=>p.action==='queue'),false);
  assert.ok(toasts.some(t=>t.title==='Payment received, under review'&&t.body==='We received your payment.'));
  assert.ok(window.localStorage.getItem('fm_pending_order_v1'));
});
