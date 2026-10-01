import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
test('channel sharing creates bounded invitations, renders optional QR, queues email once and grants connected organizations',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:850}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://sharing.test/**',r=>r.fulfill({contentType:'text/html',body:'<button id="open">Open</button>'}));await page.goto('https://sharing.test/');
  await page.evaluate(()=>{
   window.calls=[];window.emails=[];window.Portal={cfg:{orgId:'local'}};
   window.FMDocWidgets={qr:{svg:url=>`<svg aria-label="QR" data-url="${url}"></svg>`}};
   window.CommunicationsAPI={messages:{sendEmail:async(org,input)=>{window.emails.push({org,input});return {message:{status:'sent',metadata:{transport_mode:'capture'}}};}}};
   window.PlatformAPI={request:async(url,options={})=>{const path=new URL(url).pathname;window.calls.push({path,method:options.method,body:options.body});if(path.endsWith('/partners'))return {items:[{recipient_org_id:'partner',organization:{name:'Harbor Plumbing'},connection:{status:'active'}}]};if(path.endsWith('/shares'))return options.method==='POST'?{share:{id:'grant'}}:{items:[]};if(path.endsWith('/invitations'))return {invitation:{expires_at:'2026-10-08T00:00:00Z'},url:'/portal/#collaboration_invite=secret-token'};throw Error('Unexpected '+path);}};
  });
  await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/partners/share-dialog.js',import.meta.url),'utf8')});
  await page.evaluate(()=>window.FirstMateSharing.openChannel({channel:{id:'channel',name:'Install <crew>'}}));
  await page.locator('select[name=access]').waitFor({timeout:3000}).catch(async e=>{console.log(await page.locator('body').innerText());console.log(errors);throw e;});await page.locator('select[name=access]').selectOption('participate');await page.locator('input[name=email]').fill('person@example.test');await page.getByRole('button',{name:'Create invitation link'}).click();
  await page.getByText('Invitation ready',{exact:true}).waitFor();const invite=await page.evaluate(()=>window.calls.find(c=>c.path.endsWith('/invitations')).body);
  assert.equal(invite.recipient_kind,'organization');assert.equal(invite.email,'person@example.test');assert.deepEqual(invite.grant.operations,['read','messages.read','messages.post']);assert.equal(invite.grant.resource.owner_org_id,'local');assert.equal(invite.grant.include_future,true);assert.equal(invite.grant.audience.mode,'members');
  assert.equal(await page.locator('.share-qr').isVisible(),false);await page.getByText('Show QR code',{exact:true}).click();await page.locator('.share-qr svg').waitFor();await page.getByRole('button',{name:'Send email',exact:true}).click();await page.getByText('Email captured in the test message log.').waitFor();assert.equal(await page.evaluate(()=>window.emails.length),1);const email=await page.evaluate(()=>window.emails[0]);assert.equal(email.input.to,'person@example.test');assert.ok(email.input.text.includes('collaboration_invite=secret-token'));assert.ok(email.input.idempotency_key);
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await page.evaluate(()=>window.FirstMateSharing.openChannel({channel:{id:'channel',name:'Install'}}));await page.locator('select[name=recipient]').selectOption('partner');assert.equal(await page.locator('[data-invite-email]').isVisible(),false);await page.getByRole('button',{name:'Share channel',exact:true}).click();await page.getByText('Channel shared',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.calls.find(c=>c.path.endsWith('/shares')&&c.method==='POST').body.recipient_org_id),'partner');
  await page.setViewportSize({width:390,height:844});assert.ok(await page.locator('dialog').evaluate(e=>e.getBoundingClientRect().right<=innerWidth));assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
