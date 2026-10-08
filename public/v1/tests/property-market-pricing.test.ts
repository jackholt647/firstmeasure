import test from 'node:test';
import assert from 'node:assert/strict';
process.env.GOOGLE_MAPS_API_KEY = 'fixture-not-a-real-key';
const market = await import('../commerce/profile.js');
const pricing = await import('../firstmeasure/pricing.js');
const expedite = await import('../firstmeasure/expedite.js');
const property = await import('../commerce/property-market.js');
const {exteriorQuote} = await import('../firstmeasure/exteriors.js');
const {pricingContext,DEFAULT_EXPEDITE_PRICING} = await import('../firstmeasure/pricing_config.js');
function inMarket<T>(orgCountry:string,propertyCountry:string,fn:()=>T,enableRush=false) {
 return market.commerceContext.run({profile:market.profileForCountry(orgCountry),policy:{...market.DEFAULT_COMMERCIAL_POLICY,international_expedite_enabled:enableRush},revision:0},()=>market.reportPropertyCountry.run(propertyCountry,()=>market.reportEuroExchange.run({rate:1.16,date:'2026-10-08'},fn)));
}
test('US/Canada boundary is shared; every international signup including UK uses EUR and metric',()=>{
 for(const country of ['GB','FR','JP','AU','MX','CH']) {
  const p=market.profileForCountry(country);assert.equal(p.currency,'EUR',country);assert.equal(p.credit_display,'currency');assert.equal(p.measurement_system,'metric');
 }
 assert.equal(market.profileForCountry('US').currency,'USD');assert.equal(market.profileForCountry('CA').currency,'USD');
});
test('property can raise domestic report price but never lower international price, for all roof types',()=>{
 for(const [org,country,base] of [['US','US',7],['US','CA',7],['CA','US',7],['US','FR',29],['US','GB',29],['GB','US',25],['FR','CA',25],['JP','JP',25]] as const) {
  inMarket(org,country,()=>{
   assert.equal(pricing.firstMeasureReportAmount({project_type:'residential'}),base,org+'/'+country);
   assert.equal(pricing.firstMeasureReportAmount({project_type:'residential',include_gutter_measurements:true}),base+(base===7?2:org==='US'?6:5));
   const commercial=base===7?12:org==='US'?58:50;
   assert.equal(pricing.firstMeasureReportAmount({project_type:'commercial',pins:[{},{}]}),commercial*2);
   assert.equal(pricing.firstMeasureReportAmount({project_type:'multifamily'}),commercial);
  });
 }
});
test('international rush uses the US surcharge-to-base ratio; free rush retains the international base',()=>{
 for(const type of ['residential','commercial','multifamily'])for(const option of ['rush_1_3','rush_under_1']) {
  const us=inMarket('US','US',()=>expedite.reportExpediteBaseUnitPrice(type,option,300)-expedite.reportExpediteBaseUnitPrice(type,'standard_3_6',300));
  for(const [org,country,base] of [['US','FR',type==='residential'?29:58],['GB','US',type==='residential'?25:50]] as const)inMarket(org,country,()=>{
   const price=expedite.reportExpediteBaseUnitPrice(type,option,300);assert.equal(price,Number(base)+Math.round(base*us/(type==='residential'?7:12)*100)/100);
   const charge=pricing.firstMeasureReportCharge({project_type:type,report_expedite_option:option,free_expedite_uses:1,report_market_revision:market.reportMarketRevision()});assert.equal(charge.amount,base);
   assert.throws(()=>pricing.firstMeasureReportCharge({project_type:type}),{code:'pricing_changed'});
  },true);
 }
});
test('context does not leak between concurrent countries',async()=>{
 const results=await Promise.all(['US','FR','CA','JP'].map(country=>inMarket('US',country,async()=>{await new Promise(r=>setTimeout(r,5));return pricing.firstMeasureReportAmount({});})));
 assert.deepEqual(results,[7,29,7,29]);
});

test('international launch hides and rejects rush by property country, with an explicit re-enable switch',()=>{
 for(const org of ['US','FR'])inMarket(org,'FR',()=>{
  const quote=expedite.buildReportExpediteOptions({projectType:'residential'});
  assert.deepEqual(quote.options.map(o=>o.key),['standard_3_6']);
  assert.equal(exteriorQuote().options.length,1);
  assert.throws(()=>expedite.reportExpediteBaseUnitPrice('residential','rush_under_1',300),{code:'international_expedite_disabled'});
 });
 inMarket('FR','US',()=>assert.equal(expedite.buildReportExpediteOptions({projectType:'residential'}).options.length,3));
 inMarket('US','FR',()=>assert.equal(expedite.buildReportExpediteOptions({projectType:'residential'}).options.length,3),true);
});

test('international USD price rounding and quote revisions track the reference rate',()=>{
 inMarket('US','FR',()=>{
  const prior=market.reportMarketRevision();
  market.reportEuroExchange.run({rate:1.171,date:'2026-10-08'},()=>{
   assert.equal(market.reportBasePrice(7),29);
   assert.equal(market.reportBasePrice(12),59);
   assert.equal(market.reportGutterPrice(),6);
   assert.notEqual(market.reportMarketRevision(),prior);
   assert.throws(()=>pricing.firstMeasureReportCharge({report_market_revision:prior}),{code:'pricing_changed'});
  });
 });
 market.commerceContext.run({profile:market.profileForCountry('US'),policy:market.DEFAULT_COMMERCIAL_POLICY,revision:0},()=>market.reportPropertyCountry.run('FR',()=>{
  assert.throws(()=>market.reportBasePrice(7),{code:'exchange_rate_unavailable'});
 }));
});
test('country verification ignores client claims and rejects missing geocoder country',async()=>{
 const original=globalThis.fetch;
 try{
  globalThis.fetch=(async()=>new Response(JSON.stringify({status:'OK',results:[{address_components:[{types:['country'],short_name:'FR'}]}]}),{status:200})) as typeof fetch;
  assert.equal(await property.resolveReportPropertyCountry({lat:48.85,lng:2.35,country:'US',address_components:{country:'US'}}),'FR');
  globalThis.fetch=(async()=>new Response(JSON.stringify({status:'OK',results:[{address_components:[{types:['country'],short_name:'US'}]}]}),{status:200})) as typeof fetch;
  await assert.rejects(property.resolveReportPropertyCountry({pins:[{lat:48.85,lng:2.35},{lat:40.71,lng:-74}]}),{code:'property_market_mismatch'});
  globalThis.fetch=(async()=>new Response(JSON.stringify({status:'OK',results:[]}),{status:200})) as typeof fetch;
  await assert.rejects(property.resolveReportPropertyCountry({lat:51.5,lng:-0.12,country:'US'}),{code:'property_country_unavailable'});
  assert.equal(await property.resolveReportPropertyCountry({},false),'');
  await assert.rejects(property.resolveReportPropertyCountry({}),{code:'property_country_required'});
 }finally{globalThis.fetch=original;}
});
test('exterior ordering stays open after 8pm Pacific and overnight',()=>{
 for(const hour of [3,4,6,10])pricingContext.run({config:{...DEFAULT_EXPEDITE_PRICING},revision:0,now:new Date(`2026-10-06T${String(hour).padStart(2,'0')}:00:00Z`)},()=>assert.equal(exteriorQuote().ordering_closed,false));
});

test('configured Azure verifies coordinates and addresses when Google Geocoding is unavailable',async()=>{
 const {env}=await import('../src/config/env.js');const originalFetch=globalThis.fetch,originalKey=env.azureMapsSubscriptionKey;
 Object.assign(env,{azureMapsSubscriptionKey:'azure-country-fixture'});const seen:URL[]=[];
 try{
  globalThis.fetch=(async(input,options)=>{
   const url=new URL(String(input));
   if(url.hostname==='maps.googleapis.com')return new Response(JSON.stringify({status:'REQUEST_DENIED'}));
   assert.equal(url.hostname,'atlas.microsoft.com');assert.equal(new Headers(options?.headers).get('subscription-key'),'azure-country-fixture');seen.push(url);
   return new Response(JSON.stringify({features:[{properties:{address:{countryRegion:{ISO:'GB'}}}}]}));
  }) as typeof fetch;
  assert.equal(await property.resolveReportPropertyCountry({lat:51.51,lng:-0.13,country:'US'}),'GB');
  assert.equal(seen[0]!.pathname,'/reverseGeocode');assert.equal(seen[0]!.searchParams.get('coordinates'),'-0.13,51.51');
  assert.equal(await property.resolveReportPropertyCountry({address:'10 Downing Street, London'}),'GB');
  assert.equal(seen[1]!.pathname,'/geocode');assert.equal(seen[1]!.searchParams.get('query'),'10 Downing Street, London');
  globalThis.fetch=(async()=>new Response(JSON.stringify({features:[]}))) as typeof fetch;
  await assert.rejects(property.resolveReportPropertyCountry({lat:52.1,lng:0.1}),{code:'property_country_unavailable'});
 }finally{globalThis.fetch=originalFetch;Object.assign(env,{azureMapsSubscriptionKey:originalKey});}
});
