import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('Prices authorization, validation, concurrency, shared quote/charge settings and isolation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fm-prices-'));
  Object.assign(process.env, { FIRSTMATE_ENV: 'test', FIRSTMEASURE_DATABASE_MODE: 'sqlite',
    FIRSTMEASURE_STORAGE_ROOT: root, FIRSTMEASURE_INDEX_DB_PATH: path.join(root,'index.sqlite'),
    INTERNAL_STORAGE_ROOT: path.join(root,'internal'), PLATFORM_STORAGE_ROOT: path.join(root,'platform'),
    CRM_STORAGE_ROOT: path.join(root,'crm'), FIRSTMEASURE_JOB_WORKERS:'0', PLATFORM_HEARTBEAT_DISABLED:'1' });
  const { buildApp } = await import('../src/app.js');
  const { saveInternalUser } = await import('../internal/storage.js');
  const { pricingContext, readExpeditePricing, DEFAULT_EXPEDITE_PRICING } = await import('../firstmeasure/pricing_config.js');
  const { firstMeasureReportAmount, firstMeasureReportCharge } = await import('../firstmeasure/pricing.js');
  const { buildReportExpediteOptions } = await import('../firstmeasure/expedite.js');
  const app = await buildApp(); await app.ready();
  const otherApp = await buildApp(); await otherApp.ready();
  const endpoint = '/v1/firstmeasure/admin/prices/';
  try {
    const users: Record<string, Record<string,string>> = {};
    for (const [name,role] of [['admin','admin'],['manager','manager'],['qa','qa'],['customer','owner']]) {
      const email = name+'@prices.example.test';
      const register = await app.inject({method:'POST',url:'/v1/platform/auth/register',payload:{email,name,password:'test-pricing-password-176',phone:'+1 555 103 210'+Object.keys(users).length}});
      assert.equal(register.statusCode,201,register.body);
      const cookie = String(register.headers['set-cookie']).match(/fm_platform_session=[^;,]+/)?.[0] || '';
      const session = await app.inject({method:'GET',url:'/v1/platform/auth/session',headers:{cookie}});
      users[name!] = {cookie, 'x-platform-csrf':session.json().csrf_token};
      if (name !== 'customer') await saveInternalUser({email,name,role,status:'active',permissions:role==='manager'?{manage_queue:true,manage_sales_users:true}:{}});
    }
    assert.equal((await app.inject({method:'GET',url:endpoint,headers:{'x-internal-user-email':'admin@prices.example.test'}})).statusCode,401);
    for (const name of ['manager','qa','customer']) {
      for (const method of ['GET','PUT','POST'] as const) {
        const response = await app.inject({method,url:endpoint+(method==='POST'?'preview':''),headers:users[name],...(method==='GET'?{}:{payload:{actor:{email:'admin@prices.example.test'},config:DEFAULT_EXPEDITE_PRICING,revision:0}})});
        assert.equal(response.statusCode,403,response.body);
      }
    }
    const initial = await app.inject({method:'GET',url:endpoint,headers:users.admin});
    assert.equal(initial.statusCode,200,initial.body); assert.deepEqual(initial.json().config,DEFAULT_EXPEDITE_PRICING);
    assert.equal(initial.headers['cache-control'],'no-store');
    assert.equal((await app.inject({method:'PUT',url:endpoint,headers:{cookie:users.admin!.cookie!},payload:{config:DEFAULT_EXPEDITE_PRICING,revision:0}})).statusCode,403);
    const config = {...DEFAULT_EXPEDITE_PRICING,fee_multiplier:2,rush_adder:1,fast_adder:2};
    for (const invalid of [{...config,base_fee:-1},{...config,fee_multiplier:1e300},{...config,wait_max_minutes:240},{...config,fast_multiplier:0},{...config,unknown:3}]) {
      assert.equal((await app.inject({method:'PUT',url:endpoint,headers:users.admin,payload:{config:invalid,revision:0}})).statusCode,400);
    }
    const preview = await app.inject({method:'POST',url:endpoint+'preview',headers:users.admin,payload:config});
    assert.equal(preview.statusCode,200,preview.body); assert.deepEqual(preview.json().samples[0].residential,[7,10,15]);
    assert.equal((await readExpeditePricing()).revision,0,'preview must not persist');
    const saves = await Promise.all([1,2].map(()=>app.inject({method:'PUT',url:endpoint,headers:users.admin,payload:{config,revision:0}})));
    assert.deepEqual(saves.map(r=>r.statusCode).sort(),[200,409]);
    const current = await readExpeditePricing(); assert.equal(current.revision,1); assert.equal(current.updated_by,'admin@prices.example.test');
    const otherQuote = await otherApp.inject({method:'GET',url:'/v1/firstmeasure/report-expedite-options'});
    assert.equal(otherQuote.json().pricing_revision,1,'another app instance reads the saved shared configuration');
    const quote = await app.inject({method:'GET',url:'/v1/firstmeasure/report-expedite-options?project_type=residential'});
    assert.equal(quote.statusCode,200,quote.body); assert.equal(quote.json().pricing_revision,1,'request hook must propagate current settings');
    const standardWait = quote.json().options[0].estimated_wait_minutes;
    const expectedFee = Math.round((Math.round((1+Math.min(1,Math.max(0,(standardWait-240)/180))*2)*10)/10)*2*100)/100 + 1;
    assert.equal(quote.json().options.find((o:any)=>o.key==='rush_1_3').unit_price,7+expectedFee);
    await pricingContext.run({...current,now:new Date('2026-08-16T08:00:00Z')},async()=>{
      for (const type of ['residential','commercial','multifamily']) {
        const pins = [{},{},{}];
        const options = buildReportExpediteOptions({projectType:type,structureCount:3});
        const rush = options.options.find(o=>o.key==='rush_1_3')!;
        const input = {project_type:type,pins,report_expedite_option:'rush_1_3',report_pricing_revision:1};
        assert.equal(firstMeasureReportAmount(input),rush.unit_price*(type==='residential'?1:3));
        assert.equal(firstMeasureReportCharge({...input,free_expedite_uses:1}).amount,type==='residential'?7:36);
        assert.throws(()=>firstMeasureReportCharge({...input,report_pricing_revision:0}),/prices changed/);
      }
    });
    const isolated = await Promise.all([1,2].map(multiplier => pricingContext.run({config:{...DEFAULT_EXPEDITE_PRICING,fee_multiplier:multiplier},revision:0,now:new Date('2026-08-16T08:00:00Z')},async()=>{
      await new Promise(resolve=>setImmediate(resolve));
      return firstMeasureReportAmount({report_expedite_option:'rush_1_3'});
    })));
    assert.deepEqual(isolated,[8,9],'overlapping async requests cannot leak pricing into each other');
    for (const collection of ['pricing_config','PRICING_CONFIG','%20pricing_config%20']) {
      assert.equal((await app.inject({method:'GET',url:'/v1/internal/state/'+collection})).statusCode,403);
      assert.equal((await app.inject({method:'PUT',url:'/v1/internal/state/'+collection+'/expedite',payload:{data:DEFAULT_EXPEDITE_PRICING}})).statusCode,403);
    }
    await saveInternalUser({email:'admin@prices.example.test',name:'admin',role:'admin',status:'inactive'});
    assert.equal((await app.inject({method:'GET',url:endpoint,headers:users.admin})).statusCode,403);
  } finally {
    await app.close();
    await otherApp.close();
    await (await import('../firstmeasure/project_index.js')).closeFirstMeasureProjectIndex();
    await rm(root,{recursive:true,force:true,maxRetries:3});
  }
});
