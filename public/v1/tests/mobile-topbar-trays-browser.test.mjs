// On a phone everything in the top bar opens from the bottom, as the project window's trays do: the More (⋯) menu
// is a bottom sheet (or, with topbar.phone_menu "top", a dropdown at the top right), messages, notifications and
// To Do are bottom sheets one at a time, and the assistant is the project window's agent bar
// on the person's main conversation. Desktop is unchanged (docs/architecture/app-experience.md, "The mobile top bar").
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const read = (relative) => readFile(path.join(publicRoot, relative), 'utf8');
const index = await read('portal/index.php');
const between = (text, start, end) => {
  const i = text.indexOf(start), j = text.indexOf(end, i);
  assert.ok(i >= 0 && j > i, `missing ${start}`);
  return text.slice(i, j);
};
const indexStyles = [...index.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('\n');
const mobileTopbar = between(index, '<div class="mobile-topbar">', '<!-- ====== SIDEBAR BACKDROP');
const desktopTopbar = between(index, '<div class="platform-topbar" id="platformTopbar">', '<div class="main-panels" id="mainPanels">');
const shots = process.env.MOBILE_TOPBAR_SCREENSHOTS || '';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const harness = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${indexStyles}</style><style>html:root{--primary:#0f766e;--primary-rgb:15,118,110;--secondary:#f97316;--on-primary:#fff}body{margin:0;font-family:system-ui,sans-serif}</style></head><body>
${mobileTopbar}
<main class="main">${desktopTopbar}<div class="main-panels" id="mainPanels"><div class="fm-tabpanel active" style="height:900px">Content</div></div></main>
<script>
  window.flags = { 'topbar.todos': true };
  window.menuPlacement = 'bottom';
  window.calls = { toggle:0, context:0, projectConversation:0 };
  window.sent = []; window.release = null;
  window.__APP = { orgId:'org', userOrgId:'org', userId:'user' };
  window.Portal = {
    cfg: window.__APP,
    util: { escapeHtml: (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])) },
    can: (key) => window.flags[key] ?? true,
    capabilities: { can: () => true },
    branchModules: { currentBranchId: () => 'default' }
  };
  window.PlatformAPI = {
    appFlags: { current: () => ({}), has: (group, flag) => group === 'platform' && flag === 'top_bar', load: async () => ({}),
      value: (group, flag, fallback) => group === 'topbar' && flag === 'phone_menu' ? window.menuPlacement : fallback },
    actionItems: { list: async () => ({ items: [{ id:'t1', title:'Call Jane', kind:'manual', status:'open', assigned_user_ids:['user'] }] }) },
    work: { configuration: async () => ({}) },
    request: async () => ({ companies:[{ id:'roofing', label:'Roofing' }], categories:[{ id:'projects', label:'Projects', icon:'fa-folder' }] })
  };
  window.ChannelsAPI = { readState: { inbox: async () => ({ entries: [{ entry_id:'e1', kind:'dm', unread:true, count:3, author:{ name:'Jane' }, text:'Hi there', channel_name:'Jane' }] }) } };
  const noteState = { unread_count:1, active_count:1, notifications:[{ id:'n1', title:'Roof measured', body:'12 Elm St is ready', user_state:{} }], dismissed_notifications:[] };
  window.PlatformNotifications = { listeners:[], subscribe(fn){ this.listeners.push(fn); fn(noteState); }, getState: () => noteState,
    load: async function(){ this.listeners.forEach((fn) => fn(noteState)); return noteState; }, markSeen: async () => ({}) };
  const threads = { main:{ id:'main', subject_id:'main' } }, messages = { main:[{ role:'user', content:'Earlier question' }, { role:'assistant', content:'Earlier answer' }] };
  window.AssistantAPI = {
    context: async () => { calls.context += 1; return { main_thread:threads.main, threads:[threads.main], agents:[], dashboard:[] }; },
    projectConversation: async () => { calls.projectConversation += 1; throw new Error('no project here'); },
    thread: async (_org, id) => ({ thread:threads[id], messages:messages[id] }),
    send: async (_org, id, body) => { sent.push(body); await new Promise((resolve) => { window.release = resolve; }); messages[id].push({ role:'user', content:body.message }, { role:'assistant', content:'Measured the roof' }); return { actions:[], thread:threads[id], assistant_message:{ role:'assistant', content:'Measured the roof' } }; }
  };
</script>
<script src="/libraries/doc-markdown/firstmate-markdown.js"></script>
<script src="/libraries/window-manager/window-manager.js"></script>
<script src="/libraries/window-manager/window-shell.js"></script>
<script src="/libraries/platform-assistant/platform-assistant.js"></script>
<script src="/libraries/project-trays/project-trays.js"></script>
<script>
  // The desktop assistant window: counted, so a phone can be shown never to open it.
  const toggle = window.PlatformAssistant.toggle;
  window.PlatformAssistant.toggle = (...args) => { calls.toggle += 1; return toggle(...args); };
</script>
<script src="/portal/scripts/topbar.js"></script>
<script src="/libraries/platform-action-items/platform-action-items.js"></script>
<script src="/libraries/platform-action-items/todo-tray.js"></script>
</body></html>`;

const launch = () => chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });

async function openShell(browser, viewport, { mobile = true, placement = 'bottom' } = {}){
  const context = await browser.newContext({ viewport, ...(mobile ? { userAgent: MOBILE_UA, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://shell.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: harness.replace("window.menuPlacement = 'bottom'", `window.menuPlacement = '${placement}'`) });
    const type = url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript';
    return route.fulfill({ contentType: type, body: await read(url.pathname.slice(1)).catch(() => '') });
  });
  await page.goto('https://shell.test/');
  await page.waitForFunction(() => document.querySelector('.mobile-topbar')?.classList.contains('topbar-enabled'));
  return { context, page, errors };
}

const shot = async (page, name) => { if (!shots) return; await mkdir(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
const rect = (page, selector) => page.locator(selector).evaluate((element) => { const r = element.getBoundingClientRect(); return { top:r.top, bottom:r.bottom, left:r.left, right:r.right, width:r.width, height:r.height }; });
const popoverOpen = (page, id) => page.evaluate((key) => document.getElementById(key)?.matches(':popover-open') === true, id);
const settledAtBottom = (page, id) => page.waitForFunction((key) => { const sheet = document.querySelector(`#${key} .ptb-sheet`); const r = sheet?.getBoundingClientRect(); return !!r && Math.abs(r.bottom - innerHeight) < 1 && getComputedStyle(sheet).visibility === 'visible'; }, id);
const openFromMore = async (page, item) => {
  await page.getByRole('button', { name: 'More' }).click();
  await page.waitForFunction(() => document.getElementById('mobilePlatformMoreMenu').classList.contains('visible'));
  await page.locator(item).click();
};

test('phone: the More menu opens at the top right with separate primary-colored actions and Close', async () => {
  const browser = await launch();
  try {
    for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
      const top = await openShell(browser, viewport);
      const more = await rect(top.page, '#mobilePlatformMoreBtn');
      await top.page.getByRole('button', { name: 'More' }).click();
      await top.page.waitForFunction(() => getComputedStyle(document.querySelector('#mobilePlatformMoreMenu .ptb-sheet')).opacity === '1');
      await top.page.waitForTimeout(260);
      assert.equal(await top.page.locator('#mobilePlatformMoreMenu').getAttribute('data-placement'), 'top');
      const dropdown = await rect(top.page, '#mobilePlatformMoreMenu .ptb-sheet');
      assert.ok(Math.abs(dropdown.top - (more.bottom + 6)) < 2, `anchored under the More button: ${JSON.stringify({ dropdown, more })}`);
      assert.ok(Math.abs(dropdown.right - (viewport.width - 10)) < 1 && dropdown.width <= 300, JSON.stringify(dropdown));
      assert.ok(dropdown.bottom < viewport.height - 100, 'a dropdown, not a sheet');
      assert.equal(await top.page.locator('#mobilePlatformMoreMenu .ptb-sheet-grip').isVisible(), false);
      assert.deepEqual(await top.page.locator('#mobilePlatformMoreMenu .ptb-more-item:visible span').allTextContents(), ['AI Assistant', 'To Do', 'Messages', 'Notifications']);
      assert.equal(await top.page.locator('#mobilePlatformMoreMenu .ptb-sheet-close').count(), 0);
      assert.equal(await top.page.locator('#mobilePlatformMoreBtn').getAttribute('aria-label'), 'Close');
      assert.ok(dropdown.width <= 228);
      assert.equal(await top.page.evaluate(() => document.getElementById('mobilePlatformMoreMessages').parentElement !== document.getElementById('mobilePlatformMoreNotifications').parentElement), true);
      const colors = await top.page.locator('#mobilePlatformMoreMenu .ptb-more-item:visible > i').evaluateAll(items => items.map(item => getComputedStyle(item).backgroundColor));
      assert.ok(colors.every(color => color === 'rgb(15, 118, 110)'), JSON.stringify(colors));
      await top.page.locator('#mobilePlatformMoreBtn').click();
      await top.page.waitForFunction(() => !document.getElementById('mobilePlatformMoreMenu').matches(':popover-open'));
      await top.page.getByRole('button', { name: 'More' }).click();
      await shot(top.page, `more-top-${viewport.width}`);
      // What it opens still slides up from the bottom.
      await top.page.locator('#mobilePlatformMoreMessages').click();
      await settledAtBottom(top.page, 'mobilePlatformMessagesMenu');
      await top.page.keyboard.press('Escape');
      await top.page.waitForFunction(() => !document.getElementById('mobilePlatformMessagesMenu').matches(':popover-open'));
      assert.equal(await top.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(top.errors, []);
      await top.context.close();
    }
  } finally { await browser.close(); }
});

test('phone: messages, notifications and To Do open as bottom sheets, one at a time, and slide away', async () => {
  const browser = await launch();
  try {
    for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
      const { context, page, errors } = await openShell(browser, viewport);
      const sheets = [
        { item: '#mobilePlatformMoreMessages', id: 'mobilePlatformMessagesMenu', title: 'Messages', content: 'Hi there' },
        { item: '#mobilePlatformMoreNotifications', id: 'mobilePlatformNotificationMenu', title: 'Notifications', content: 'Roof measured' },
        { item: '#mobilePlatformMoreTodos', id: 'mobilePlatformTodoSheet', title: 'To Do', content: 'Call Jane' }
      ];
      for (const { item, id, title, content } of sheets) {
        await openFromMore(page, item);
        await settledAtBottom(page, id);
        assert.equal(await page.evaluate(() => document.getElementById('mobilePlatformMoreMenu').classList.contains('visible')), false, `${title}: the More sheet gives way`);
        const box = await rect(page, `#${id} .ptb-sheet`);
        assert.ok(box.left === 0 && Math.round(box.width) === viewport.width && box.height > viewport.height * 0.5, `${title} ${JSON.stringify(box)}`);
        assert.equal(await page.locator(`#${id} .ptb-sheet-grip`).isVisible(), true, `${title} has a drag handle`);
        assert.match(await page.locator(`#${id} .ptb-sheet-head`).innerText(), new RegExp(title));
        await page.locator(`#${id}`).getByText(content, { exact: false }).first().waitFor();
        assert.equal(await page.locator('.ptb-menu--sheet.visible').count(), 1, 'one sheet at a time');
        await shot(page, `sheet-${id.replace('mobilePlatform', '').toLowerCase()}-${viewport.width}`);
        // Close slides it down before it leaves the top layer.
        await page.locator(`#${id} .ptb-sheet-close`).click();
        const midway = await rect(page, `#${id} .ptb-sheet`);
        assert.ok(await popoverOpen(page, id) && midway.top < viewport.height, `${title} animates closed`);
        await page.waitForFunction((key) => !document.getElementById(key).matches(':popover-open'), id);
      }
      // The To Do list goes back where it was.
      assert.equal(await page.locator('#platformTodoTray .fm-todo-body').count(), 1);
      assert.equal(await page.locator('#mobilePlatformMoreTodos').getAttribute('aria-expanded'), 'false');

      // Opening one sheet puts away another.
      await openFromMore(page, '#mobilePlatformMoreMessages');
      await settledAtBottom(page, 'mobilePlatformMessagesMenu');
      await page.evaluate(() => document.getElementById('mobilePlatformBell').click());
      await settledAtBottom(page, 'mobilePlatformNotificationMenu');
      assert.equal(await page.evaluate(() => document.getElementById('mobilePlatformMessagesMenu').classList.contains('visible')), false);
      // Dragging the handle down dismisses it.
      const grip = await rect(page, '#mobilePlatformNotificationMenu .ptb-sheet-grip');
      await page.mouse.move(grip.left + grip.width / 2, grip.top + 2);
      await page.mouse.down();
      await page.mouse.move(grip.left + grip.width / 2, grip.top + 80, { steps: 6 });
      await page.mouse.move(grip.left + grip.width / 2, grip.top + 240, { steps: 6 });
      await page.mouse.up();
      await page.waitForFunction(() => !document.getElementById('mobilePlatformNotificationMenu').matches(':popover-open'));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); }
});

test('phone: the assistant is the project window\'s agent bar on the main conversation, with an animated close', async () => {
  const browser = await launch();
  try {
    for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
      const { context, page, errors } = await openShell(browser, viewport);
      await openFromMore(page, '#mobilePlatformMoreAssistant');
      await page.waitForSelector('.ptb-agent-bar .fma-msg', { state: 'attached' });
      await page.waitForTimeout(520);
      assert.equal(await page.locator('.ptb-agent-host').getAttribute('data-tray-open'), 'true');
      assert.deepEqual(await page.evaluate(() => ({ ...window.calls })), { toggle: 0, context: 1, projectConversation: 0 }, 'the main conversation, not the assistant window');
      const bar = await rect(page, '.ptb-agent-bar');
      assert.ok(Math.abs(bar.bottom - viewport.height) < 1 && bar.left === 0 && Math.round(bar.width) === viewport.width, JSON.stringify(bar));
      assert.ok(bar.height < 150, `only the input bar: ${bar.height}`);
      const edge = await page.locator('.ptb-agent-bar').evaluate((element) => getComputedStyle(element, '::before').backgroundImage);
      assert.ok(edge.includes('rgb(15, 118, 110)') && edge.includes('rgb(249, 115, 22)'), `the edge is in the organization colours: ${edge}`);
      for (const name of ['Add files or camera photo', 'Dictate', 'Start voice conversation', 'Close assistant']) assert.equal(await page.getByRole('button', { name, exact: true }).isVisible(), true, name);
      const history = page.getByRole('button', { name: 'Show conversation', exact: true });
      assert.equal(await history.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('.ptb-agent-bar .fma-stage').evaluate((element) => element.getBoundingClientRect().height), 0, 'the conversation is folded');
      await shot(page, `assistant-bar-${viewport.width}`);
      await history.click();
      await page.waitForTimeout(520);
      assert.ok(await page.locator('.ptb-agent-bar .fma-stage').evaluate((element) => element.getBoundingClientRect().height) > 200, 'the conversation unfolds');
      assert.equal(await page.getByText('Earlier answer', { exact: true }).isVisible(), true);
      await shot(page, `assistant-conversation-${viewport.width}`);
      await page.getByRole('button', { name: 'Hide conversation', exact: true }).click();
      await page.waitForTimeout(520);
      // Asking from the folded bar shows Working, then the answer.
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Measure the roof');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.waitForFunction(() => !!window.release);
      await page.getByRole('button', { name: 'Show conversation', exact: true }).getByText('Working').waitFor();
      await page.evaluate(() => window.release());
      await page.waitForFunction(() => document.querySelector('.ptb-agent-bar').dataset.agentHistory === 'open');
      await page.getByText('Measured the roof', { exact: true }).waitFor();
      // Close slides it down and fades it.
      await page.getByRole('button', { name: 'Close assistant', exact: true }).click();
      await page.waitForTimeout(80);
      const closing = await page.locator('.ptb-agent-bar').evaluate((element) => ({ visibility: getComputedStyle(element).visibility, top: element.getBoundingClientRect().top }));
      assert.equal(closing.visibility, 'visible', 'the bar animates away');
      await page.waitForTimeout(520);
      assert.equal(await page.locator('.ptb-agent-bar').isVisible(), false);
      // Opening again starts folded; a sheet puts it away.
      await openFromMore(page, '#mobilePlatformMoreAssistant');
      await page.waitForTimeout(520);
      assert.equal(await page.getByRole('button', { name: 'Show conversation', exact: true }).getAttribute('aria-expanded'), 'false');
      await openFromMore(page, '#mobilePlatformMoreMessages');
      await settledAtBottom(page, 'mobilePlatformMessagesMenu');
      assert.equal(await page.locator('.ptb-agent-host').getAttribute('data-tray-open'), 'false');
      assert.equal(await page.evaluate(() => window.calls.toggle), 0);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); }
});

test('desktop is unchanged: dropdowns under the top bar, the assistant window, the docked To Do tray', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openShell(browser, { width: 1600, height: 1000 }, { mobile: false, placement: 'top' });
    assert.equal(await page.locator('.mobile-topbar').isVisible(), false);
    const bell = await rect(page, '#platformMessagesBtn');
    await page.locator('#platformMessagesBtn').click();
    await page.waitForFunction(() => document.getElementById('platformMessagesMenu').classList.contains('visible'));
    const menu = await rect(page, '#platformMessagesMenu');
    assert.ok(menu.top >= bell.bottom && menu.width <= 400 && menu.height < 700, JSON.stringify({ menu, bell }));
    assert.equal(await page.locator('#platformMessagesMenu.ptb-menu--sheet').count(), 0, 'not a sheet');
    await shot(page, 'desktop-messages-1600');
    await page.keyboard.press('Escape');
    await page.locator('#platformAssistantBtn').click();
    assert.equal(await page.evaluate(() => window.calls.toggle), 1, 'the assistant window');
    assert.equal(await page.locator('.ptb-agent-host[data-tray-open=true]').count(), 0);
    await page.evaluate(() => window.PlatformAssistant.close());
    await page.locator('#platformTodoBtn').click();
    await page.getByText('Call Jane', { exact: true }).waitFor();
    assert.equal(await page.locator('.fm-todo-tray').getAttribute('data-window'), 'docked');
    assert.equal(await page.locator('#mobilePlatformTodoSheet').count(), 0);
    await shot(page, 'desktop-todo-1600');
    await page.locator('#platformTodoBtn').click();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});


test('restored More menu preserves message gating, ignores stale loads and opens photo messages on Photos', async () => {
  const browser = await launch();
  try {
    const {page, context, errors} = await openShell(browser, {width:390,height:844});
    await page.waitForFunction(() => document.getElementById('mobilePlatformMoreMessagesCount').textContent === '3');
    await page.evaluate(() => {
      ChannelsAPI.readState.inbox = () => new Promise(resolve => { window.resolveInbox = resolve; });
      dispatchEvent(new CustomEvent('fm:capabilities:updated'));
    });
    await page.waitForFunction(() => typeof window.resolveInbox === 'function');
    await page.evaluate(() => { flags['topbar.messages'] = false; dispatchEvent(new CustomEvent('fm:capabilities:updated')); resolveInbox({entries:[{entry_id:'stale',unread:true,count:20,text:'Stale inbox'}]}); });
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#platformMessagesSlot').evaluate(e=>e.hidden), true);
    assert.equal(await page.locator('#mobilePlatformMoreMessages').evaluate(e=>e.hidden), true);
    assert.equal(await page.locator('#mobilePlatformMoreMessagesCount').textContent(), '0');
    await page.evaluate(() => {
      window.photoRoutes=[];
      Portal.navigation={navigate:route=>photoRoutes.push(route),applyCurrent:async()=>{}};
      ChannelsAPI.readState.inbox=async()=>({entries:[{entry_id:'photo',kind:'dm',channel_type:'project',project_id:'project-1',photo_id:'photo-1',unread:true,count:1,text:'A photo',author:{name:'Jane'}}]});
      ChannelsAPI.readState.inboxRead=async()=>({});
      flags['topbar.messages']=true;dispatchEvent(new CustomEvent('fm:app-flags:updated'));
    });
    await page.waitForFunction(() => document.getElementById('mobilePlatformMoreMessagesCount').textContent === '1');
    await openFromMore(page,'#mobilePlatformMoreMessages');
    await page.locator('#mobilePlatformMessagesMenu [data-message-entry]').first().click();
    await page.waitForFunction(() => photoRoutes.length>0);
    assert.deepEqual(await page.evaluate(()=>photoRoutes[0]), {project:'project-1',projectTab:'photos',projectNote:null,photo:'photo-1',photoScope:'project'});
    assert.deepEqual(errors,[]);await context.close();
  } finally { await browser.close(); }
});

test('Messages can be disabled independently of Channels, clearing menus and stale inbox responses', async () => {
  const browser=await launch();
  try {
    for(const mobile of [true,false]){
      const {context,page}=await openShell(browser,mobile?{width:390,height:844}:{width:1280,height:900},{mobile});
      const button=mobile?'#mobilePlatformMessagesBtn':'#platformMessagesBtn';
      const menu=mobile?'#mobilePlatformMessagesMenu':'#platformMessagesMenu';
      await page.evaluate(()=>{window.inboxCalls=0;window.ChannelsAPI.readState.inbox=()=>{window.inboxCalls++;return new Promise(resolve=>window.resolveInbox=resolve);};});
      await page.locator(button).evaluate(el=>el.click());
      await page.waitForFunction(()=>!!window.resolveInbox);
      await page.evaluate(()=>{flags['topbar.messages']=false;window.dispatchEvent(new Event('fm:capabilities:updated'));resolveInbox({entries:[{entry_id:'late',unread:true,count:9}]});});
      assert.equal(await page.locator(menu).evaluate(el=>el.classList.contains('visible')),false);
      for(const slot of ['#platformMessagesSlot','#mobilePlatformMessagesSlot','#mobilePlatformMoreMessages'])assert.equal(await page.locator(slot).evaluate(el=>el.hidden),true);
      await page.locator(button).evaluate(el=>el.click());
      assert.equal(await page.evaluate(()=>inboxCalls),1,'hidden Messages never fetches');
      assert.equal(await page.locator('#mobilePlatformMessagesCount').evaluate(el=>el.classList.contains('visible')),false,'late responses cannot restore badges');
      await page.evaluate(()=>{ChannelsAPI.readState.inbox=async()=>({entries:[]});flags['topbar.messages']=true;window.dispatchEvent(new Event('fm:capabilities:updated'));});
      assert.equal(await page.locator('#platformMessagesSlot').evaluate(el=>el.hidden),false);
      await context.close();
    }
  }finally{await browser.close();}
});

test('a photo mention in Messages opens that project photo rather than its Notes tray',async()=>{
  const browser=await launch();
  try{
    const {context,page}=await openShell(browser,{width:1280,height:900},{mobile:false});
    await page.evaluate(()=>{
      window.photoRoutes=[];Portal.navigation={navigate:route=>photoRoutes.push(route),applyCurrent:async()=>{}};
      ChannelsAPI.readState.inboxRead=async()=>({});
      ChannelsAPI.readState.inbox=async()=>({entries:[{entry_id:'photo-mention',kind:'mention',channel_type:'project',project_id:'project1',photo_id:'photo1',channel_id:'discussion1',message_id:'comment1',author:{name:'Jane'},text:'Check this flashing'}]});
    });
    await page.locator('#platformMessagesBtn').click();
    await page.locator('#platformMessagesList [data-message-entry]').click();
    assert.deepEqual(await page.evaluate(()=>photoRoutes),[{project:'project1',projectTab:'photos',projectNote:null,photo:'photo1',photoScope:'project'}]);
    await context.close();
  }finally{await browser.close();}
});

