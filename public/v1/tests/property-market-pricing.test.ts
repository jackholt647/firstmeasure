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
 return market.commerceContext.run({profile:market.profileForCountry(orgCountry),policy:market.DEFAULT_COMMERCIAL_POLICY,revision:0},()=>market.reportPropertyCountry.run(propertyCountry,()=>market.reportEuroExchange.run({rate:1.16,date:'2026-10-08'},fn)));
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
   // Outside the US and Canada: €40 per commercial or multifamily structure (a USD account pays the reference rate).
   const commercial=base===7?12:org==='US'?46:40;
   assert.equal(pricing.firstMeasureReportAmount({project_type:'commercial',pins:[{},{}]}),commercial*2);
   assert.equal(pricing.firstMeasureReportAmount({project_type:'multifamily'}),commercial);
  });
 }
});
test('international rush uses the US surcharge numbers in euros; free rush retains the international base',()=>{
 for(const type of ['residential','commercial','multifamily'])for(const option of ['rush_1_3','rush_under_1']) {
  const us=inMarket('US','US',()=>expedite.reportExpediteBaseUnitPrice(type,option,300)-expedite.reportExpediteBaseUnitPrice(type,'standard_3_6',300));
  for(const [org,country,base] of [['US','FR',type==='residential'?29:46],['GB','US',type==='residential'?25:40]] as const)inMarket(org,country,()=>{
   const surcharge=Math.round(us*100)/100,charged=org==='US'?Math.round(surcharge*1.16*100)/100:surcharge;
   const price=expedite.reportExpediteBaseUnitPrice(type,option,300);assert.equal(price,Math.round((Number(base)+charged)*100)/100);
   const charge=pricing.firstMeasureReportCharge({project_type:type,report_expedite_option:option,free_expedite_uses:1,report_market_revision:market.reportMarketRevision()});assert.equal(charge.amount,base);
   assert.throws(()=>pricing.firstMeasureReportCharge({project_type:type}),{code:'pricing_changed'});
  });
 }
});
test('context does not leak between concurrent countries',async()=>{
 const results=await Promise.all(['US','FR','CA','JP'].map(country=>inMarket('US',country,async()=>{await new Promise(r=>setTimeout(r,5));return pricing.firstMeasureReportAmount({});})));
 assert.deepEqual(results,[7,29,7,29]);
});

test('rush is offered in every market (the international expedite switch is retired)',()=>{
 for(const [org,country] of [['US','FR'],['FR','FR'],['FR','US'],['US','US']] as const)inMarket(org,country,()=>{
  assert.deepEqual(expedite.buildReportExpediteOptions({projectType:'residential'}).options.map(o=>o.key),['standard_3_6','rush_under_1','rush_1_3']);
  assert.ok(expedite.reportExpediteBaseUnitPrice('residential','rush_under_1',300)>expedite.reportExpediteBaseUnitPrice('residential','standard_3_6',300));
 });
});

test('international USD price rounding and quote revisions track the reference rate',()=>{
 inMarket('US','FR',()=>{
  const prior=market.reportMarketRevision();
  market.reportEuroExchange.run({rate:1.171,date:'2026-10-08'},()=>{
   assert.equal(market.reportBasePrice(7),29);
   assert.equal(market.reportBasePrice(12),47);
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
test('Full Exterior outside the US and Canada uses the international list by property address, whatever the org country (FM-593)',()=>{
 const amounts=(org:string,country:string,count=1)=>pricingContext.run({config:{...DEFAULT_EXPEDITE_PRICING},revision:2,now:new Date('2026-10-06T18:00:00Z')},()=>inMarket(org,country,()=>{const q=exteriorQuote(count);return {keys:q.options.map(o=>o.key),fees:q.options.map(o=>o.fee),amounts:q.options.map(o=>o.amount),base:q.base_price,revision:q.pricing_revision};}));
 const us={keys:['exteriors_standard','exteriors_same_day','exteriors_priority'],fees:[0,5,10],amounts:[25,30,35],base:25,revision:2};
 // US/Canada: the expedite settings' US numbers, revision unchanged.
 for(const [org,country] of [['US','US'],['US','CA'],['CA','US']] as const)assert.deepEqual(amounts(org,country),us,org+'/'+country);
 // Outside them: €60, +€10 under 6 hours, +€25 under 3 hours, not the old 2x of the US numbers.
 for(const [org,country] of [['FR','FR'],['GB','DE'],['FR','US'],['JP','JP']] as const)assert.deepEqual(amounts(org,country),{...us,fees:[0,10,25],amounts:[60,70,85],base:60,revision:3002},org+'/'+country);
 assert.deepEqual(amounts('FR','FR',2).amounts,[120,140,170]);
 // A US account ordering for a European property pays the euro prices at the reference rate (1.16): whole dollars for the base, cents for fees.
 const usd=amounts('US','FR');
 assert.deepEqual(usd.fees,[0,11.6,29]);assert.deepEqual(usd.amounts,[70,81.6,99]);assert.equal(usd.base,70);
 assert.notEqual(usd.revision,us.revision);
 // A quote priced at another euro rate has another revision, so an order on it is refused as "prices changed".
 const moved=pricingContext.run({config:{...DEFAULT_EXPEDITE_PRICING},revision:2,now:new Date('2026-10-06T18:00:00Z')},()=>inMarket('US','FR',()=>market.reportEuroExchange.run({rate:1.2,date:'2026-10-09'},()=>exteriorQuote().pricing_revision)));
 assert.notEqual(moved,usd.revision);
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
