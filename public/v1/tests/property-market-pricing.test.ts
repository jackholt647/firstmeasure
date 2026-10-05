import test from 'node:test';
import assert from 'node:assert/strict';
process.env.GOOGLE_MAPS_API_KEY = 'fixture-not-a-real-key';
const market = await import('../commerce/profile.js');
const pricing = await import('../firstmeasure/pricing.js');
const expedite = await import('../firstmeasure/expedite.js');
const property = await import('../commerce/property-market.js');
const {exteriorQuote} = await import('../firstmeasure/exteriors.js');
const {pricingContext,DEFAULT_EXPEDITE_PRICING} = await import('../firstmeasure/pricing_config.js');
function inMarket<T>(orgCountry:string,propertyCountry:string,fn:()=>T) {
 return market.commerceContext.run({profile:market.profileForCountry(orgCountry),policy:market.DEFAULT_COMMERCIAL_POLICY,revision:0},()=>market.reportPropertyCountry.run(propertyCountry,fn));
}
test('US/Canada boundary is shared; every international signup including UK uses EUR and metric',()=>{
 for(const country of ['GB','FR','JP','AU','MX','CH']) {
  const p=market.profileForCountry(country);assert.equal(p.currency,'EUR',country);assert.equal(p.credit_display,'currency');assert.equal(p.measurement_system,'metric');
 }
 assert.equal(market.profileForCountry('US').currency,'USD');assert.equal(market.profileForCountry('CA').currency,'USD');
});
test('property can raise domestic report price but never lower international price, for all roof types',()=>{
 for(const [org,country,base] of [['US','US',7],['US','CA',7],['CA','US',7],['US','FR',21],['US','GB',21],['GB','US',20],['FR','CA',20],['JP','JP',20]] as const) {
  inMarket(org,country,()=>{
   assert.equal(pricing.firstMeasureReportAmount({project_type:'residential'}),base,org+'/'+country);
   assert.equal(pricing.firstMeasureReportAmount({project_type:'residential',include_gutter_measurements:true}),base+2);
   const commercial=base===7?12:base;
   assert.equal(pricing.firstMeasureReportAmount({project_type:'commercial',pins:[{},{}]}),commercial*2);
   assert.equal(pricing.firstMeasureReportAmount({project_type:'multifamily'}),commercial);
  });
 }
});
test('international rush SURCHARGES are 2.5x US; free rush never discounts the international base',()=>{
 for(const type of ['residential','commercial','multifamily'])for(const option of ['rush_1_3','rush_under_1']) {
  const us=inMarket('US','US',()=>expedite.reportExpediteBaseUnitPrice(type,option,300)-expedite.reportExpediteBaseUnitPrice(type,'standard_3_6',300));
  for(const [org,country,base] of [['US','FR',21],['GB','US',20]] as const)inMarket(org,country,()=>{
   const price=expedite.reportExpediteBaseUnitPrice(type,option,300);assert.equal(price,Number(base)+Math.round(Math.round(us*100)*2.5)/100);
   const charge=pricing.firstMeasureReportCharge({project_type:type,report_expedite_option:option,free_expedite_uses:1,report_market_revision:1});assert.equal(charge.amount,base);
   assert.throws(()=>pricing.firstMeasureReportCharge({project_type:type}),{code:'pricing_changed'});
  });
 }
});
test('context does not leak between concurrent countries',async()=>{
 const results=await Promise.all(['US','FR','CA','JP'].map(country=>inMarket('US',country,async()=>{await new Promise(r=>setTimeout(r,5));return pricing.firstMeasureReportAmount({});})));
 assert.deepEqual(results,[7,21,7,21]);
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
