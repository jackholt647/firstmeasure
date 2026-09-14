import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { visitorIp, normalizeIp, signalsFor, reference, type TrackingEvent } from '../staff_tracking/core.js';

test('IP provenance, normalization and evidence chronology', () => {
  assert.equal(normalizeIp('::ffff:0808:0808'),'8.8.8.8');
  assert.equal(normalizeIp('::ffff:8.8.8.8'),'8.8.8.8');
  assert.equal(normalizeIp('2001:4860:0000:0000:0000:0000:0000:8888'),'2001:4860::8888');
  assert.equal(visitorIp('8.8.8.8','1.1.1.1','127.0.0.1/32'),'8.8.8.8');
  assert.equal(visitorIp('127.0.0.1','6.6.6.6, 8.8.8.8, 10.0.0.2','127.0.0.1/32,10.0.0.2/32'),'8.8.8.8');
  assert.equal(visitorIp('127.0.0.1','','127.0.0.1/32'),null);
  assert.equal(visitorIp('127.0.0.1','invalid','127.0.0.1/32'),null);
  assert.equal(visitorIp('::ffff:7f00:1','',''),null);
  const base:TrackingEvent={id:'x',email:'trainee@example.test',name:'Trainee',at:'2026-09-14T12:00:00.000Z',ip:'8.8.8.8',kind:'exam_submit',session_ref:'x',browser:'Chrome',established:false,impersonated:false,course:'c',attempt:'a',project:'p'};
  const staff={...base,email:'tech@example.test',established:true,kind:'activity' as const,at:'2026-09-14T11:00:00.000Z'};
  assert.equal(signalsFor(base,[staff])[0]?.key,'prior_staff_ip');
  assert.deepEqual(signalsFor(base,[{...staff,at:'2026-09-14T13:00:00.000Z'}]),[]);
  assert.deepEqual(signalsFor(base,[{...staff,impersonated:true}]),[]);
  assert.deepEqual(signalsFor({...base,impersonated:true},[staff]),[]);
  assert.deepEqual(signalsFor({...base,ip:null},[staff]),[]);
  assert.deepEqual(signalsFor(base,[{...staff,at:'2025-01-01T00:00:00.000Z'}]),[]);
  assert.ok(signalsFor(base,[{...base,at:'2026-09-14T11:59:00.000Z',ip:'1.1.1.1'}]).some(s=>s.key==='attempt_ip_change'));
});

test('tracking authorization, universal collection, bridge integrity, reviews and pagination', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'fm-tracking-'));
  Object.assign(process.env,{FIRSTMATE_ENV:'test',FIRSTMEASURE_DATABASE_MODE:'sqlite',FIRSTMEASURE_STORAGE_ROOT:root,FIRSTMEASURE_INDEX_DB_PATH:path.join(root,'index.sqlite'),INTERNAL_STORAGE_ROOT:path.join(root,'internal'),PLATFORM_STORAGE_ROOT:path.join(root,'platform'),CRM_STORAGE_ROOT:path.join(root,'crm'),FIRSTMEASURE_JOB_WORKERS:'0',PLATFORM_HEARTBEAT_DISABLED:'1',STAFF_TRACKING_ENABLED:'1',STAFF_TRACKING_TRUSTED_PROXIES:'127.0.0.1/32',STAFF_TRACKING_BRIDGE_SECRET:'test-only-tracking-bridge-secret-184'});
  const {buildApp}=await import('../src/app.js');
  const {trackingFailureDetails}=await import('../staff_tracking/api.js');
  assert.deepEqual(trackingFailureDetails(Object.assign(new Error('private session and email'),{trackingStage:'insert',code:'42501',statusCode:503})),{stage:'insert',code:'42501',type:'Error',status:503});
  assert.equal(JSON.stringify(trackingFailureDetails({message:'private',code:'private-email',trackingStage:'private-session',name:'private'})).includes('private'),false);
  process.env.MEASURE_INTERNAL_TUTORIALS_ROOT=path.join(root,'tutorials');
  const {saveInternalUser}=await import('../internal/storage.js');
  const {flushTracking}=await import('../staff_tracking/api.js');
  const {trackingQuery,insertEvent,closeTrackingSqlite,expireTracking,priorEvents}=await import('../staff_tracking/store.js');
  const app=await buildApp();
  app.get('/v1/tracking-detached-fixture',async request=>{(request.raw as any).socket=null;return {ok:true};});
  app.get('/tracking-fixture',async(_req,reply)=>reply.type('text/html').send(await readFile('tests/staff-tracking-browser.html','utf8')));
  app.get('/tracking-fixture.js',async(_req,reply)=>reply.type('text/javascript').send(await readFile('../measure/internal/portal_scripts/tracking.js','utf8')));
  await app.ready();
  const users:Record<string,Record<string,string>>={};
  const endpoint='/v1/staff-tracking/';
  try {
    for(const [name,role] of [['admin','admin'],['manager','manager'],['qa','qa'],['trainee','user'],['customer','owner']]) {
      const email=name+'@tracking.example.test';
      const r=await app.inject({method:'POST',url:'/v1/platform/auth/register',payload:{email,name,password:'tracking-password-test-184',phone:'+1 555 184 210'+Object.keys(users).length}});
      assert.equal(r.statusCode,201,r.body);
      const cookie=String(r.headers['set-cookie']).match(/fm_platform_session=[^;,]+/)?.[0]||'';
      if(name!=='customer')await saveInternalUser({email,name,role,status:'active',training_complete:name==='qa',permissions:role==='manager'?{manage_users:true,manage_queue:true}:{}});
      const s=await app.inject({method:'GET',url:'/v1/platform/auth/session',headers:{cookie,'x-forwarded-for':'8.8.8.8'}});
      users[name!]={cookie,'x-platform-csrf':s.json().csrf_token};
    }
    await flushTracking();
    assert.equal((await app.inject({url:endpoint+'access',headers:{'x-internal-user-email':'admin@tracking.example.test'}})).statusCode,401);
    for(const name of ['manager','qa','trainee','customer']) for(const route of ['access','events','access-list']) assert.equal((await app.inject({url:endpoint+route,headers:users[name]})).statusCode,403,name+route);
    assert.equal((await app.inject({url:endpoint+'access',headers:users.admin})).statusCode,200);
    const records=await trackingQuery('SELECT email FROM staff_tracking_events');
    assert.ok(records.some(e=>e.email==='trainee@tracking.example.test'),'ungranted trainee is still collected');
    assert.ok(records.some(e=>e.email==='qa@tracking.example.test'));
    assert.ok(!records.some(e=>e.email==='customer@tracking.example.test'));
    assert.equal((await app.inject({url:'/v1/tracking-detached-fixture',headers:{...users.trainee,'x-forwarded-for':'1.0.0.1'}})).statusCode,200);
    await flushTracking();
    assert.equal((await trackingQuery("SELECT id FROM staff_tracking_events WHERE ip='1.0.0.1'")).length,1,'response hook retains original provenance even when the socket has already detached');
    // Exercise the real Node action, not just the receipt function.
    const projectStorage=await import('../firstmeasure/storage.js');
    await projectStorage.createProject({id:'tracking-source',address:'Synthetic training source',status:'completed'});
    await mkdir(path.join(root,'tutorials','master'),{recursive:true});
    await writeFile(path.join(root,'tutorials','master','curriculum.json'),JSON.stringify({chapters:[{id:1,tests:[{id:'test_1',projects:[{project_id:'tracking-source'}],sample_count:1}]}]}));
    const start=await app.inject({method:'POST',url:'/v1/internal/legacy-action',headers:{...users.trainee,'x-forwarded-for':'1.1.1.1'},payload:{action:'start_tutorial_project',actor:{email:'trainee@tracking.example.test'},project_id:'tracking-source'}});
    assert.equal(start.json().success,true,start.body);await flushTracking();
    assert.equal((await trackingQuery("SELECT id FROM staff_tracking_events WHERE kind='training_start'")).length,1);
    const exam=await app.inject({method:'POST',url:'/v1/internal/legacy-action',headers:{...users.trainee,'x-forwarded-for':'1.1.1.1'},payload:{action:'start_tutorial_test_attempt',actor:{email:'trainee@tracking.example.test'},chapter_id:1,test_id:'test_1'}});
    assert.equal(exam.json().success,true,exam.body);await flushTracking();
    assert.equal((await trackingQuery("SELECT id FROM staff_tracking_events WHERE kind='exam_start'")).length,1);
    const invalid=await app.inject({method:'POST',url:'/v1/internal/legacy-action',headers:users.trainee,payload:{action:'start_tutorial_test_attempt',actor:{email:'trainee@tracking.example.test'},chapter_id:999}});
    assert.equal(invalid.json().success,false);await flushTracking();
    assert.equal((await trackingQuery("SELECT id FROM staff_tracking_events WHERE kind='exam_start'")).length,1);
    // Real PHP completion + signed receipt into the same app, with isolated files.
    await app.listen({host:'127.0.0.1',port:0});
    const addr=app.server.address();assert.ok(addr && typeof addr==='object');
    const closeResponse=await fetch(`http://127.0.0.1:${addr.port}/v1/platform/auth/session`,{headers:{...users.trainee,'x-forwarded-for':'9.9.9.9',connection:'close'}});
    assert.equal(closeResponse.status,200);await closeResponse.text();await flushTracking();
    assert.equal((await trackingQuery("SELECT id FROM staff_tracking_events WHERE ip='9.9.9.9'")).length,1,'collection survives a closed HTTP connection');
    const {recordTracking}=await import('../staff_tracking/api.js');
    const closingRequest:any={headers:{...users.trainee,'x-forwarded-for':'8.8.4.4'},raw:{socket:{remoteAddress:'127.0.0.1'}}};
    const closingObservation=recordTracking(closingRequest,'activity');
    closingRequest.raw.socket=null; // The response connection closes during async auth/database work.
    await closingObservation;
    assert.equal((await trackingQuery("SELECT id FROM staff_tracking_events WHERE ip='8.8.4.4'")).length,1,'socket metadata is captured before asynchronous auth');
    process.env.STAFF_TRACKING_BRIDGE_URL=`http://127.0.0.1:${addr.port}/v1/private/staff-tracking`;
    const phpFixture=path.resolve('tests/staff-tracking-submit.php');
    await new Promise<void>((resolve,reject)=>{
      const phpArgs=process.env.PHP_CURL_EXTENSION?['-d','extension='+process.env.PHP_CURL_EXTENSION]:[];
      const child=spawn(process.platform==='win32'?'php.exe':'php',[...phpArgs,phpFixture,exam.json().folder],{env:process.env});
      let err='';child.stderr.on('data',d=>err+=d);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(err||'PHP submission failed')));
    });
    assert.equal((await trackingQuery("SELECT id FROM staff_tracking_events WHERE kind='exam_submit'")).length,1,'actual PHP exam submission is collected');
    const grant={email:'manager@tracking.example.test',allow:true};
    assert.equal((await app.inject({method:'POST',url:endpoint+'access-list',headers:{cookie:users.admin!.cookie!},payload:grant})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:endpoint+'access-list',headers:users.admin,payload:grant})).statusCode,200);
    assert.equal((await app.inject({url:endpoint+'access',headers:users.manager})).statusCode,200);
    assert.equal((await app.inject({url:endpoint+'access-list',headers:users.manager})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:endpoint+'access-list',headers:users.manager,payload:{email:'qa@tracking.example.test',allow:true}})).statusCode,403);
    await app.inject({method:'POST',url:endpoint+'access-list',headers:users.admin,payload:{...grant,allow:false}});
    assert.equal((await app.inject({url:endpoint+'events',headers:users.manager})).statusCode,403);
    const payload=JSON.stringify({email:'trainee@tracking.example.test',actor:'trainee@tracking.example.test',at:new Date().toISOString(),peer:'127.0.0.1',forwarded:'8.8.8.8',session_ref:reference('php-session'),ua:'Chrome/1 Windows',kind:'exam_submit',course:'course-1',attempt:'attempt-1',project:'project-1',impersonated:false});
    const signature=createHmac('sha256',process.env.STAFF_TRACKING_BRIDGE_SECRET!).update(payload).digest('hex');
    assert.equal((await app.inject({method:'POST',url:'/v1/private/staff-tracking',payload:{payload,signature:'0'.repeat(64)}})).statusCode,403);
    const receipt=()=>app.inject({method:'POST',url:'/v1/private/staff-tracking',payload:{payload,signature}});
    assert.ok((await Promise.all([receipt(),receipt()])).every(r=>r.statusCode===200));
    const stored=await trackingQuery('SELECT data FROM staff_tracking_events WHERE id=$1',[reference(payload)]);
    assert.equal(stored.length,1,'concurrent receipt retries deduplicate');
    const event=JSON.parse(stored[0].data) as TrackingEvent;
    assert.equal(event.ip,'8.8.8.8');
    assert.equal((await app.inject({method:'POST',url:endpoint+'review',headers:users.admin,payload:{id:event.id,status:'explained',note:'Shared office confirmed'}})).statusCode,200);
    const reviewed=await app.inject({url:endpoint+'events?training=1',headers:users.admin});
    assert.equal(reviewed.headers['cache-control'],'no-store');
    assert.equal(reviewed.json().events.find((e:TrackingEvent)=>e.id===event.id).review.note,'Shared office confirmed');
    for(let i=0;i<400;i++)await insertEvent({...event,id:reference('fixture'+i),email:`staff-${i}@example.test`,at:new Date(Date.parse(event.at)-1000-i).toISOString(),kind:'activity',established:true});
    assert.ok((await priorEvents(event)).length>=400,'hundreds of associated staff remain searchable');
    const page=await app.inject({url:endpoint+'events',headers:users.admin});
    assert.equal(page.json().events.length,50);assert.ok(page.json().next);
    const page2=await app.inject({url:endpoint+'events?'+new URLSearchParams(page.json().next),headers:users.admin});
    assert.ok(page2.json().events.every((e:TrackingEvent)=>!page.json().events.some((p:TrackingEvent)=>p.id===e.id)));
    if(process.env.TRACKING_BROWSER_EXECUTABLE){
      const {chromium}=await import('playwright-core');
      const browser=await chromium.launch({executablePath:process.env.TRACKING_BROWSER_EXECUTABLE,headless:true});
      try {
        const context=await browser.newContext({viewport:{width:1250,height:950}});
        const address=`http://127.0.0.1:${addr.port}`;
        await context.addCookies([{name:'fm_platform_session',value:users.admin!.cookie!.split('=').slice(1).join('='),url:address}]);
        const browserPage=await context.newPage();const errors:string[]=[];browserPage.on('pageerror',e=>errors.push(e.message));
        await browserPage.goto(address+'/tracking-fixture');
        await browserPage.getByRole('button',{name:'Tracking',exact:true}).click();
        await browserPage.locator('.tracking-event').first().waitFor();
        await browserPage.getByRole('button',{name:'Training & exams',exact:true}).click();
        await browserPage.getByText('Exam submitted',{exact:true}).first().waitFor();
        await browserPage.waitForFunction(()=>!document.querySelector('[data-notice]')?.textContent?.includes('Loading'));
        await mkdir('../../outputs/staff-tracking-184',{recursive:true});
        await browserPage.screenshot({path:'../../outputs/staff-tracking-184/tracking-desktop.png',fullPage:false});
        await browserPage.getByRole('button',{name:'Viewing access',exact:true}).click();
        const checkbox=browserPage.getByRole('checkbox',{name:'Allow qa@tracking.example.test to view Tracking'});
        await checkbox.check();await browserPage.getByText('Viewing permission saved. Collection is unchanged.',{exact:true}).waitFor();
        assert.equal((await app.inject({url:endpoint+'access',headers:users.qa})).statusCode,200);
        await checkbox.uncheck();await browserPage.waitForFunction(()=>!document.querySelector('[data-grant="qa@tracking.example.test"]')?.hasAttribute('disabled'));
        assert.equal((await app.inject({url:endpoint+'access',headers:users.qa})).statusCode,403);
        await browserPage.setViewportSize({width:390,height:844});
        await browserPage.getByRole('button',{name:'Training & exams',exact:true}).click();
        await browserPage.locator('.tracking-event').first().waitFor();
        assert.ok(await browserPage.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'mobile has no horizontal overflow');
        await browserPage.screenshot({path:'../../outputs/staff-tracking-184/tracking-mobile.png',fullPage:false});
        assert.deepEqual(errors,[]);
        const denied=await browser.newContext();await denied.addCookies([{name:'fm_platform_session',value:users.trainee!.cookie!.split('=').slice(1).join('='),url:address}]);
        const deniedPage=await denied.newPage();await deniedPage.goto(address+'/tracking-fixture');await deniedPage.waitForLoadState('networkidle');
        assert.equal(await deniedPage.locator('#nav-tracking').count(),0,'ungranted trainee sees no Tracking tab');
      }finally{await browser.close();}
    }
    const old={...event,id:reference('expired'),at:new Date(Date.now()-91*86400000).toISOString()};await insertEvent(old);await expireTracking();
    assert.equal((await trackingQuery('SELECT id FROM staff_tracking_events WHERE id=$1',[old.id])).length,0);
    // Simulate storage failure only in this disposable test database.
    await trackingQuery('DROP TABLE staff_tracking_events');
    const unaffected=await app.inject({url:'/v1/platform/auth/session',headers:{...users.trainee,'x-forwarded-for':'4.2.2.2'}});
    assert.equal(unaffected.statusCode,200,'collection failure cannot fail authentication');await flushTracking();
    await saveInternalUser({email:'admin@tracking.example.test',status:'disabled'});
    assert.equal((await app.inject({url:endpoint+'events',headers:users.admin})).statusCode,403);
    process.env.STAFF_TRACKING_ENABLED='0';
    assert.equal((await app.inject({url:endpoint+'access',headers:users.qa})).statusCode,404);
  } finally {await app.close();closeTrackingSqlite();await (await import('../firstmeasure/project_index.js')).closeFirstMeasureProjectIndex();await rm(root,{recursive:true,force:true,maxRetries:3});}
});
