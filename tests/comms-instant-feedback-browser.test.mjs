// GP-12: the project Comms tab answers every click at once. A sent text, email or portal chat reply joins its
// thread as "Sending…" before the server answers (a new text opens its conversation straight away), then becomes
// the server's message in place without being redrawn as new, or says "Not sent" with Try again. An email thread
// opens on the click with its header over a placeholder. Calls buttons show a spinner while what they start is slow.
// Runs the real files in Chromium against a stub CommsAPI whose sends are held until the test lets them through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const file = (name) => readFileSync(new URL(`../public/libraries/apps/comms/${name}`, import.meta.url), 'utf8');
const ORIGIN = 'http://fm.test';
const PAGE = `<!doctype html><html><head><script>
  window.FirstMateEmbeddableApps={registerApp(app){window.__commsApp=app;}};
  window.__APP={userOrgId:'org_1',userId:'user_1'};
  // Every API call is recorded. window.__hold(name) holds the next call to it; release it with window.__taken[name].
  window.__holds={};window.__taken={};window.__calls=[];
  window.__hold=(name)=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return window.__holds[name]={promise,release:resolve,fail:reject};};
  const held=(name,value)=>(...args)=>{window.__calls.push([name,...args]);const hold=window.__holds[name];if(hold){delete window.__holds[name];window.__taken[name]=hold;return hold.promise;}return Promise.resolve(typeof value==='function'?value(...args):value);};
  const message=(id,direction,text,at)=>({id,direction,text,channel:'sms',created_at:at||'2026-11-19T10:00:00Z',sender:{}});
  window.__call={id:'call_1',customer_name:'Pat Customer',customer_number:'+12065550100',direction:'outbound',mode:'browser',state:'ended',created_at:'2026-11-19T10:00:00Z',connected_at:'2026-11-19T10:00:05Z',ended_at:'2026-11-19T10:02:05Z'};
  window.__db={
    sms:[{id:'c1',participants:[{address:'+12065550100',name:'Pat Customer'}],messages:[message('m1','inbound','Hello there')]}],
    email:[{id:'e1',subject:'Roof quote',participants:[{address:'pat@example.com',name:'Pat Customer',type:'to'}],message_count:1,last_message_at:'2026-11-19T10:00:00Z',snippet:'Here it is',last_message:{id:'em1',text:'Here it is'}}]
  };
  const smsResult=()=>({conversations:window.__db.sms.map(c=>({...c,message_count:c.messages.length,last_message_at:c.messages.at(-1)?.created_at})),conversation:window.__db.sms[0]});
  window.CommsAPI={
    overview:held('overview',{overview:{contacts:[{name:'Pat Customer',phone:'+12065550100',email:'pat@example.com',primary:true}],channels:{}}}),
    customer:held('customer',(org,path)=>path==='voice/status'?{channels:{texts:'ready',calls:'ready'}}:path.startsWith('calls?')?{calls:[window.__call]}:path.endsWith('/artifacts')?{artifacts:[]}:path.startsWith('calls/')?{call:window.__call}:{}),
    sms:{conversation:held('sms.conversation',smsResult),send:held('sms.send',(org,project,body)=>({message:{id:'m_sent',conversation_id:body.conversation_id||'c_new'}}))},
    email:{threads:held('email.threads',()=>({threads:window.__db.email})),thread:held('email.thread',(org,project,id)=>({thread:{id,subject:'Roof quote',participants:window.__db.email[0].participants,messages:[{id:'em1',direction:'inbound',text:'Here it is',created_at:'2026-11-19T10:00:00Z',sender:{name:'Pat Customer',address:'pat@example.com'}}]}})),send:held('email.send',{message:{id:'em_sent',conversation_id:'e1'}})},
    chat:{conversations:held('chat.conversations',{conversations:[]})},
    settings:{loadProject:held('settings.loadProject',{overrides:{}}),load:held('settings.load',{settings:{}})}
  };
  window.Portal={CustomerPhone:{status:{channels:{calls:'ready'}},refreshStatus:async()=>({channels:{calls:'ready'}}),open:held('phone.open',true)}};
</script>
  <script src="/libraries/apps/comms/communications-ui.js"></script><script src="/libraries/apps/comms/workspace.js"></script><script src="/libraries/apps/comms/project.js"></script></head>
  <body style="margin:0"><div id="panel" style="height:700px"></div></body></html>`;

async function open(browser, viewport = { width: 1200, height: 760 }){
  const page = await browser.newPage({ viewport });
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: PAGE });
    const name = url.pathname.split('/').pop();
    if (url.pathname.startsWith('/libraries/apps/comms/')) return route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript', body: file(name) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => Portal.CommunicationsUI?.cssLoaded());
  await page.evaluate(() => { window.__commsApp.mount({ panelRoot: document.getElementById('panel'), projectId: 'project_1', orgId: 'org_1' }); });
  await page.waitForSelector('[data-co-tab="sms"]');
  return page;
}

const count = (page, selector) => page.locator(selector).count();
const hold = (page, name) => page.evaluate((n) => { window.__hold(n); }, name);
const release = (page, name, value) => page.evaluate(([n, v]) => window.__taken[n].release(v), [name, value]);
const fail = (page, name, message) => page.evaluate(([n, m]) => window.__taken[n].fail(new Error(m)), [name, message]);
const storeSms = (page, conversation, text) => page.evaluate(([c, t]) => {
  let thread = window.__db.sms.find((item) => item.id === c);
  if (!thread) window.__db.sms.unshift(thread = { id: c, participants: [{ address: '+12065550199' }], messages: [] });
  thread.messages.push({ id: 'm_sent', direction: 'outbound', text: t, created_at: '2026-11-19T10:01:00Z', sender: {} });
}, [conversation, text]);

async function withPage(viewport, run){
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try { await run(await open(browser, viewport)); } finally { await browser.close(); }
}

test('a text reply shows in the thread at once, then becomes the sent message in place', () => withPage(undefined, async (page) => {
  await page.click('[data-co-tab="sms"]');
  await page.waitForSelector('.fmco-msgs .fmco-msg.inbound');
  assert.equal(await count(page, '.fmco-msg.fmco-new'), 0, 'opening a thread does not animate every message');
  await hold(page, 'sms.send');
  await page.evaluate(() => { document.querySelector('[data-co-composer="sms-reply"]').__marker = 1; });
  await page.fill('[data-co-composer-input="sms-reply"]', 'On my way');
  await page.click('[data-co-sms-send]');
  // Before the server answers: the bubble is in the thread, sending, and the composer is empty for the next one.
  const bubble = page.locator('.fmco-msg.outbound.pending');
  assert.equal(await bubble.count(), 1);
  assert.equal((await bubble.textContent()).trim(), 'On my way');
  assert.match(await bubble.getAttribute('class'), /fmco-new/, 'it animates in');
  assert.equal(await count(page, '.fmco-send-state.sending'), 1);
  assert.equal(await page.inputValue('[data-co-composer-input="sms-reply"]'), '');
  // The server answers: the thread shows the stored message, not as new, and the composer was never rebuilt.
  await storeSms(page, 'c1', 'On my way');
  await release(page, 'sms.send', { message: { id: 'm_sent', conversation_id: 'c1' } });
  await page.waitForSelector('.fmco-msg.pending', { state: 'detached' });
  const sent = page.locator('.fmco-msg.outbound');
  assert.equal(await sent.count(), 1);
  assert.doesNotMatch(await sent.getAttribute('class'), /fmco-new/, 'the stored message replaces the bubble without entering again');
  assert.equal(await page.evaluate(() => document.querySelector('[data-co-composer="sms-reply"]').__marker), 1, 'the composer was patched around, not rebuilt');
}));

test('a new text opens its conversation at once (phone), and becomes the real one when sent', () => withPage({ width: 433, height: 820 }, async (page) => {
  await page.click('[data-co-tab="sms"]');
  // On a phone Texts opens the latest thread: go back to the list, which slides back in.
  await page.click('[data-co-sms-close]');
  assert.equal(await count(page, '.fmco-list-col.fmco-back'), 1);
  await page.click('[data-co-sms-compose]');
  await page.fill('[data-co-sms-to]', '+12065550199');
  await page.fill('[data-co-composer-input="sms-compose"]', 'Your crew starts Monday');
  await hold(page, 'sms.send');
  await page.click('[data-co-sms-send]');
  // The new conversation is open with the message in it, and the list (behind it on a phone) has a sending row.
  assert.equal(await count(page, '[data-co-composer="sms-compose"]'), 0, 'the new-text form is gone');
  assert.match(await page.locator('.fmco-thread-view .fmco-thread-title').textContent(), /\+12065550199/);
  assert.equal(await count(page, '.fmco-thread-view.fmco-enter'), 1, 'the conversation moves in');
  assert.equal((await page.locator('.fmco-msg.outbound.pending').textContent()).trim(), 'Your crew starts Monday');
  assert.equal(await count(page, '.fmco-thread-row.pending.active'), 1);
  assert.equal(await page.locator('[data-co-sms-send]').isDisabled(), true, 'no reply until the conversation exists');
  await storeSms(page, 'c_new', 'Your crew starts Monday');
  await release(page, 'sms.send', { message: { id: 'm_sent', conversation_id: 'c_new' } });
  await page.waitForSelector('.fmco-msg.pending', { state: 'detached' });
  assert.equal(await count(page, '.fmco-thread-row.pending'), 0);
  assert.equal(await count(page, '.fmco-thread-view.fmco-enter'), 0, 'becoming the real conversation does not move it in again');
  assert.equal(await count(page, '.fmco-msg.outbound.fmco-new'), 0);
  assert.equal(await page.locator('[data-co-sms-send]').isDisabled(), false);
}));

test('a text that fails says "Not sent", and Try again sends it', () => withPage(undefined, async (page) => {
  await page.click('[data-co-tab="sms"]');
  await page.waitForSelector('.fmco-msgs .fmco-msg.inbound');
  await hold(page, 'sms.send');
  await page.fill('[data-co-composer-input="sms-reply"]', 'Running late');
  await page.click('[data-co-sms-send]');
  await fail(page, 'sms.send', 'Carrier rejected the message');
  await page.waitForSelector('.fmco-msg.pending.failed');
  assert.match(await page.locator('.fmco-send-state.failed').textContent(), /Not sent/);
  await hold(page, 'sms.send');
  await page.click('[data-co-retry]');
  assert.equal(await count(page, '.fmco-msg.pending.failed'), 0);
  assert.equal(await count(page, '.fmco-send-state.sending'), 1, 'sending again shows at once');
  await storeSms(page, 'c1', 'Running late');
  await release(page, 'sms.send', { message: { id: 'm_sent', conversation_id: 'c1' } });
  await page.waitForSelector('.fmco-msg.pending', { state: 'detached' });
  // Remove puts the words back in an empty composer.
  await hold(page, 'sms.send');
  await page.fill('[data-co-composer-input="sms-reply"]', 'Second try');
  await page.click('[data-co-sms-send]');
  await fail(page, 'sms.send', 'No');
  await page.waitForSelector('[data-co-discard]');
  await page.click('[data-co-discard]');
  assert.equal(await count(page, '.fmco-msg.pending'), 0);
  assert.equal(await page.inputValue('[data-co-composer-input="sms-reply"]'), 'Second try');
}));

test('an email thread opens on the click, and a reply joins it as a sending card', () => withPage(undefined, async (page) => {
  await page.click('[data-co-tab="email"]');
  await page.waitForSelector('[data-co-thread="e1"]');
  await hold(page, 'email.thread');
  await page.click('[data-co-thread="e1"]');
  // Still loading: the thread is already open with its subject over a placeholder.
  assert.match(await page.locator('.fmco-mail-head .fmco-thread-title').textContent(), /Roof quote/);
  assert.equal(await count(page, '.fmco-skeleton'), 2);
  assert.equal(await count(page, '[data-co-thread="e1"].active'), 1);
  assert.equal(await page.locator('[data-co-email-reply-send]').isDisabled(), true);
  await release(page, 'email.thread', { thread: { id: 'e1', subject: 'Roof quote', participants: [{ address: 'pat@example.com', name: 'Pat Customer', type: 'to' }], messages: [{ id: 'em1', direction: 'inbound', text: 'Here it is', created_at: '2026-11-19T10:00:00Z', sender: { name: 'Pat Customer', address: 'pat@example.com' } }] } });
  await page.waitForSelector('[data-co-mail-msg="em1"]');
  assert.equal(await count(page, '.fmco-skeleton'), 0);
  await hold(page, 'email.send');
  await page.fill('[data-co-composer-input="reply"]', 'Thanks, booked.');
  await page.click('[data-co-email-reply-send]');
  assert.equal(await count(page, '.fmco-mail-card.pending .fmco-send-state.sending'), 1, 'the reply card is in the thread at once');
  assert.match(await page.locator('.fmco-mail-card.pending .fmco-mail-body').textContent(), /Thanks, booked\./);
  await release(page, 'email.send', { message: { id: 'em_sent', conversation_id: 'e1' } });
  await page.waitForSelector('.fmco-mail-card.pending', { state: 'detached' });
}));

test('a Calls button shows it is working while what it starts is slow', () => withPage(undefined, async (page) => {
  await page.click('[data-co-tab="calls"]');
  await page.waitForSelector('[data-action="new-call"]');
  await hold(page, 'phone.open');
  await page.click('[data-action="new-call"]');
  await page.waitForFunction(() => document.querySelector('[data-action="new-call"]').getAttribute('aria-busy') === 'true');
  assert.equal(await page.locator('[data-action="new-call"]').isDisabled(), true);
  await release(page, 'phone.open', true);
  await page.waitForFunction(() => !document.querySelector('[data-action="new-call"]').hasAttribute('aria-busy'));
  // Choosing a call moves its pane in at once, and its details fade in over "Loading call…".
  await page.click('[data-action="select-call"]');
  await page.waitForSelector('[data-call-detail].fmco-enter');
  await page.waitForSelector('[data-call-detail] .fmco-call-facts');
}));

test('motion has a reduced-motion fallback', () => {
  const source = file('project.js');
  const css = source.slice(source.indexOf('function css(){'), source.indexOf('// ── Shell'));
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\s*\.fmco-shell \*:not\(\.fa-spin\)/);
  assert.match(file('communications.css'), /prefers-reduced-motion:reduce\)\{\.fmcm button:active/);
});
