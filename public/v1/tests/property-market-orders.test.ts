import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('portal verifies property country before charging and persists account currency',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'property-market-orders-'));
 const keys=path.join(root,'keys.json');await writeFile(keys,JSON.stringify({application:{internal_api_secret:'property-fixture-secret'}}));
 Object.assign(process.env,{FIRSTMATE_ENV:'test',NODE_ENV:'test',V1_LOG_LEVEL:'error',FIRSTMEASURE_DATABASE_MODE:'sqlite',DATABASE_URL:'',PROVIDER_KEYS_PATH:keys,GOOGLE_MAPS_API_KEY:'property-geocoder-fixture',PUBLIC_FIRSTMEASURE_API_KEY_SECRET:'property-test-key-secret-at-least-32-characters',FIRSTMEASURE_JOB_WORKERS:'0',PLATFORM_HEARTBEAT_DISABLED:'1',EMAIL_OUTBOUND_DISABLED:'1',STATS_SCHEDULER_DISABLED:'1',WORK_SCHEDULER_DISABLED:'1',FIRSTMEASURE_INDEX_DB_PATH:path.join(root,'index.sqlite')});
 for(const name of ['FIRSTMEASURE','PLATFORM','INTERNAL','CRM','PRICEBOOK','MESSAGING','CHANNELS','CALLS','CANVASSING','WEATHER','CODE_REPORT'])process.env[name+'_STORAGE_ROOT']=path.join(root,name.toLowerCase());
 const original=globalThis.fetch;
 globalThis.fetch=(async(input:any)=>{const url=new URL(String(input));if(url.hostname==='maps.googleapis.com'){
  const coords=url.searchParams.get('latlng')||'';const country=coords.startsWith('48.')?'FR':coords.startsWith('40.')?'US':'';
  return new Response(JSON.stringify({status:country?'OK':'ZERO_RESULTS',results:country?[{address_components:[{short_name:country,types:['country']}]}]:[]}),{status:200});
 }if(url.hostname==='www.ecb.europa.eu')return new Response(`<Cube time='${new Date().toISOString().slice(0,10)}'><Cube currency='USD' rate='1.16'/></Cube>`);return new Response('{}',{status:503});}) as typeof fetch;
 const {buildApp}=await import('../src/app.js');const app=await buildApp();await app.ready();
 const store=await import('../platform/storage.js');const reports=await import('../firstmeasure/storage.js');
 try{
  const anonymous=await app.inject({method:'GET',url:'/v1/firstmeasure/report-expedite-options?lat=48.85&lng=2.35'});assert.equal(anonymous.statusCode,401);
  let index=0;
  for(const [account,lat,lng,amount,currency] of [['US',40.71,-74.00,7,'USD'],['US',48.85,2.35,29,'USD'],['GB',40.71,-74.00,25,'EUR'],['FR',48.85,2.35,25,'EUR']] as const){
   const reg=await app.inject({method:'POST',url:'/v1/platform/auth/register',headers:{'cf-ipcountry':account},payload:{email:`${account}-${lat}@example.test`,password:'Property-fixture-123!',phone:'+12025550'+String(++index).padStart(3,'0')}});assert.equal(reg.statusCode,201,reg.body);
   const cookie=String(reg.headers['set-cookie']).match(/fm_platform_session=[^;,]+/)![0];const session=(await app.inject({method:'GET',url:'/v1/platform/auth/session',headers:{cookie}})).json();const orgId=session.membership.organization_id;const headers={cookie,'x-platform-csrf':session.csrf_token};
   await store.saveGlobal(orgId,{data:{credits_balance:100}});
   const quote=await app.inject({method:'GET',url:`/v1/firstmeasure/report-expedite-options?project_type=residential&lat=${lat}&lng=${lng}`,headers});assert.equal(quote.statusCode,200,quote.body);assert.equal(quote.json().options[0].unit_price,amount);
   const keys=await import('../public-firstmeasure/keys.js');
   const key=await keys.createPublicFirstMeasureApiKey({orgId,mode:'test',requireBilling:false});
   const apiHeaders={authorization:`Bearer ${key.key}`};
   const apiQuote=await app.inject({method:'GET',url:`/v1/public/firstmeasure/pricing?lat=${lat}&lng=${lng}`,headers:apiHeaders});assert.equal(apiQuote.statusCode,200,apiQuote.body);assert.equal(apiQuote.json().options[0].unit_price,amount);assert.equal(apiQuote.json().add_ons.gutters.unit_price,amount===7?2:currency==='USD'?6:5);
   const apiOrder=await app.inject({method:'POST',url:'/v1/public/firstmeasure/reports',headers:apiHeaders,payload:{address:'Fixture API property',lat,lng,report_market_revision:apiQuote.json().report_market_revision}});assert.equal(apiOrder.statusCode,201,apiOrder.body);assert.equal(apiOrder.json().billing.quoted_amount,amount);
   const body={action:'queue',address:'Fixture property',project_type:'residential',lat,lng,pins:[{lat,lng}],report_market_revision:quote.json().report_market_revision,report_property_country:'US',address_components:{country:'US'}};
   assert.equal(quote.json().options.length,lat===48.85?1:3);
   const commercialQuote=await app.inject({method:'GET',url:`/v1/firstmeasure/report-expedite-options?project_type=commercial&structure_count=2&lat=${lat}&lng=${lng}`,headers});
   assert.equal(commercialQuote.statusCode,200,commercialQuote.body);
   assert.equal(commercialQuote.json().options[0].unit_price,amount===7?12:currency==='USD'?58:50);
   if(lat===48.85){
    const rushed=await app.inject({method:'POST',url:'/v1/platform/portal-action',headers,payload:{...body,report_expedite_option:'rush_under_1'}});
    assert.equal(rushed.statusCode,403,rushed.body);assert.equal(rushed.json().error,'international_expedite_disabled');
    assert.equal((await store.readGlobal(orgId)).data.credits_balance,100);
   }
   if(amount!==7){
    const stale=await app.inject({method:'POST',url:'/v1/platform/portal-action',headers,payload:{...body,report_market_revision:1}});
    assert.equal(stale.statusCode,409,stale.body);assert.equal((await store.readGlobal(orgId)).data.credits_balance,100);
   }
   const queued=await app.inject({method:'POST',url:'/v1/platform/portal-action',headers,payload:body});assert.equal(queued.statusCode,200,queued.body);assert.equal(queued.json().success,true,queued.body);
   const manifest=await reports.readManifest(queued.json().folder);assert.equal(manifest.amount_charged,amount);assert.equal(manifest.report_currency,currency);assert.equal(manifest.report_property_country,lat===48.85?'FR':'US');
   const global=(await store.readGlobal(orgId)).data;assert.equal(global.credits_balance,100-amount);const ledger=global.credits_ledger as any[];assert.equal(ledger.at(-1).meta.credit_currency,currency);
   const denied=await app.inject({method:'POST',url:'/v1/platform/portal-action',headers,payload:{...body,lat:0.1,lng:0.1,pins:[{lat:0.1,lng:0.1}]}});assert.equal(denied.statusCode,400,denied.body);assert.equal((await store.readGlobal(orgId)).data.credits_balance,100-amount);
  }
 }finally{globalThis.fetch=original;await app.close();await(await import('./helpers/platform-fixture.js')).closePlatformFixtureStores();}
});
