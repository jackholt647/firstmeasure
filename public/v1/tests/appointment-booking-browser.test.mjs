import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {chromium} from 'playwright-core';

const picker = await readFile(new URL('../../libraries/appointment-booking/availability.js', import.meta.url), 'utf8');
const selector = await readFile(new URL('../../libraries/project-selector/project-selector.js', import.meta.url), 'utf8');
const configuration = await readFile(new URL('../../libraries/appointment-booking/configuration.js', import.meta.url), 'utf8');
const booking = await readFile(new URL('../../libraries/appointment-booking/booking.js', import.meta.url), 'utf8');
const embed = await readFile(new URL('../../libraries/lead-embed/firstmate-lead-embed.js', import.meta.url), 'utf8');
const scheduling = await readFile(new URL('../../libraries/apps/scheduling/app.js', import.meta.url), 'utf8');
test('presets request a named assignee up front; advanced changes become Custom and keep independent flags',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1000,height:1000}});
    await page.route('http://localhost/**',route=>route.fulfill({body:'<html><body></body></html>',contentType:'text/html'}));await page.goto('http://localhost/');
    for(const content of [picker,selector,configuration,booking])await page.addScriptTag({content});
    await page.evaluate(()=>{
      const config={title:'Consultation',department_ids:['sales'],delivery:false,duration_minutes:60,window_minutes:60,slot_minutes:30,recurrence:null,requirements:[{department_id:'sales',subject_type:'organization_user',mode:'specific',subject_keys:[],count:1,percent:100,crew_member_percent:0}]};
      window.requests=[];
      window.PlatformAPI={projects:{get:async()=>({document:{id:'project',data:{title:'Project'}}})},appointments:{catalog:async()=>({can_manage:false,resources:[{id:'person',key:'organization_user:person',name:'Alex',subject_type:'organization_user'}],catalog:{departments:[{id:'sales',label:'Sales'},{id:'production',label:'Production'}],groups:[],presets:[{id:'consultation',label:'Consultation',configuration:config}]}}),preview:async(org,input)=>{window.requests.push(input);return {slots:[{start_at:'2026-10-08T15:00:00Z',available:true,label:'10:00 AM'}]};},book:async()=>({ok:true})}};
      return FirstMateBooking.open({orgId:'org',projectId:'project',lockProject:true});
    });
    await page.locator('[data-preset]').selectOption('consultation');
    assert.equal(await page.locator('[data-advanced]').getAttribute('open'),null);
    await page.locator('[data-quick-specific]').selectOption('organization_user:person');
    await page.locator('[data-advanced] summary').click();
    await page.locator('[data-delivery]').check();
    await page.locator('[data-department][value=production]').check();
    await page.locator('[data-window]').fill('240');await page.locator('[data-window]').press('Tab');
    await page.locator('[data-recurring]').check();
    assert.equal(await page.locator('[data-preset]').inputValue(),'');
    const selected=await page.evaluate(()=>window.requests.at(-1).configuration);
    assert.deepEqual(selected.department_ids,['sales','production']);assert.equal(selected.delivery,true);assert.equal(selected.recurrence.frequency,'weekly');assert.equal(selected.window_minutes,240);assert.equal(selected.duration_minutes,60);
    assert.deepEqual(selected.requirements[0].subject_keys,['organization_user:person']);
    assert.equal(await page.locator('[data-project] input').isDisabled(),true);
    await page.locator('[data-timing]').selectOption('days');
    assert.equal(await page.locator('[data-duration]').isVisible(),false);
    await page.locator('[data-days]').fill('3');await page.locator('[data-days]').press('Tab');
    await page.locator('[data-location]').selectOption('company_office');
    assert.ok(await page.getByText(/Company office address is not set/).isVisible());
    const days=await page.evaluate(()=>window.requests.at(-1).configuration);assert.equal(days.timing_mode,'days');assert.equal(days.duration_days,3);assert.equal(days.location.mode,'company_office');
    await page.locator('[data-location]').selectOption('none');assert.equal(await page.locator('[data-address]').isVisible(),false);

    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.locator('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth));
  }finally{await browser.close();}
});
test('direct Scheduling entry loads booking without the app manifest', async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true});
  try {
    const page = await browser.newPage();
    await page.route('http://localhost/**', route => {
      const url = route.request().url();
      return route.fulfill({body:url.endsWith('/configuration.js') ? configuration : url.endsWith('/booking.js') ? booking : url.endsWith('/availability.js') ? picker : url.endsWith('/project-selector.js') ? selector : '<html><body></body></html>',contentType:url.endsWith('.js') ? 'text/javascript' : 'text/html'});
    });
    await page.goto('http://localhost/');
    await page.evaluate(() => {
      window.orgId = () => 'org'; window.scheduleLoad = () => {};
      window.PlatformAPI = {projects:{list:async () => ({documents:[]})},appointments:{catalog:async()=>({catalog:{departments:[],presets:[],groups:[]},resources:[],can_manage:false}),preview:async()=>({slots:[]}),book:async () => ({ok:true})}};
    });
    await page.addScriptTag({content:scheduling.slice(scheduling.indexOf('  const bookingScriptUrl'),scheduling.indexOf('  const cfg =')) + '\nwindow.openBookingWidget = openBookingWidget;'});
    await page.evaluate(() => window.openBookingWidget());
    assert.equal(await page.getByRole('dialog').isVisible(),true);
    assert.equal(await page.getByText('You can book now and assign a project later.').isVisible(),true);
  } finally { await browser.close(); }
});
test('shared picker rejects stale responses, books once, and public embeds retain their calendar styling', async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1100,height:850}});
    await page.route('http://localhost/**', route => route.fulfill({body:'<html><body></body></html>',contentType:'text/html'}));
    await page.goto('http://localhost/');
    page.setDefaultTimeout(5000);
    await page.setContent('<button id="opener">Open</button><div id="public"></div>');
    await page.addScriptTag({content:picker});
    await page.addScriptTag({content:selector});
    await page.addScriptTag({content:configuration});
    await page.addScriptTag({content:booking});
    await page.evaluate(() => {
      window.__APP = {userOrgId:'org'}; window.bookings = []; window.pending = [];
      window.PlatformAPI = {
        projects:{list:async () => ({documents:[{id:'project',data:{title:'Test project'}}]})},
        appointments:{catalog:async()=>({catalog:{departments:[],presets:[],groups:[]},resources:[],can_manage:false}),preview:() => new Promise(resolve => window.pending.push(resolve)), book:async (_org, input) => { window.bookings.push(input); }}
      };
      document.querySelector('#opener').focus();
      return window.FirstMateBooking.open();
    });
    // No project is required; availability loads immediately.
    await page.locator('.fmle-calendar [data-date]').nth(15).click();
    await page.evaluate(() => {
      window.pending[1]({slots:[{available:true,start_at:'2026-10-05T15:00:00Z',label:'10:00 AM'}]});
      window.pending[0]({slots:[{available:true,start_at:'2026-10-04T15:00:00Z',label:'STALE'}]});
    });
    await page.getByRole('button',{name:'10:00 AM',exact:true}).click();
    assert.equal(await page.getByText('STALE').count(),0);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.locator('dialog .fmle-calendar').isVisible(),false);
    assert.equal(await page.locator('dialog .fmle-mobile-days').isVisible(),true);
    assert.ok(await page.locator('dialog').evaluate(el => el.getBoundingClientRect().right <= innerWidth));
    await page.setViewportSize({width:1100,height:850});
    if (process.env.BOOKING_SCREENSHOT) await page.screenshot({path:process.env.BOOKING_SCREENSHOT});
    await page.getByRole('button',{name:'Book appointment',exact:true}).click();
    await page.getByText('Appointment booked.',{exact:true}).waitFor();
    assert.equal(await page.evaluate(() => window.bookings.length),1);
    assert.equal(await page.evaluate(() => window.bookings[0].start_at),'2026-10-05T15:00:00Z');
    assert.equal(await page.evaluate(() => 'project_id' in window.bookings[0]),false);
    await page.getByRole('button',{name:'Close appointment booking'}).click();
    assert.equal(await page.evaluate(() => document.activeElement.id),'opener');
    await page.evaluate(() => {
      window.fetch = async url => ({ok:true,status:200,text:async () => JSON.stringify(String(url).includes('/availability')
        ? {slots:[{available:true,start:'2026-10-05T15:00:00Z',label:'10:00 AM'}]}
        : {form:{mode:'appointment',copy:{headline:'Schedule an appointment'},style:{primary_color:'#d93025'}}})});
    });
    await page.addScriptTag({content:embed});
    await page.evaluate(() => window.FirstMateLeadEmbed.render({formId:'form',target:'#public',baseUrl:'http://localhost/v1/lead-intake'}));
    await page.locator('#public .fmle-slot').waitFor();
    assert.equal(await page.locator('#public .fmle-slot').evaluate(el => getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');
    await page.locator('#public .fmle-slot').click();
    assert.equal(await page.locator('#public input[name=preferred_start_at]').inputValue(),'2026-10-05T15:00:00Z');
    assert.equal(await page.locator('#public .fmle-slot').evaluate(el => getComputedStyle(el).backgroundColor),'rgb(217, 48, 37)');
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.locator('#public .fmle-calendar').isVisible(),false);
    assert.equal(await page.locator('#public .fmle-mobile-days').isVisible(),true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  } finally { await browser.close(); }
});

test('shared project selector searches remotely, remembers choices and supports keyboard clearing', async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try {
    const page = await browser.newPage();
    await page.route('http://localhost/**',route=>route.fulfill({body:'<div id="selector"></div>'}));
    await page.goto('http://localhost/');
    await page.addScriptTag({content:selector});
    await page.evaluate(()=>{
      window.queries=[];window.changes=[];window.pendingSearch={};
      window.PlatformAPI={search:{projectsAndContacts:async(org,options)=>{
        window.queries.push(options);
        if(options.query==='slow')return new Promise(resolve=>window.pendingSearch.slow=resolve);
        return {results:[{id:'project-9000',title:options.query?'Remote matching project':'Recent updated project',subtitle:'9000 Test Street'}]};
      }},projects:{get:async()=>({document:{id:'project-9000',data:{title:'Remote matching project'}}})}};
      window.handle=FirstMateProjectSelector.mount(document.querySelector('#selector'),{orgId:'org',onChange:id=>window.changes.push(id)});
    });
    const input=page.getByRole('combobox');
    await input.fill('slow');
    await page.waitForFunction(()=>window.pendingSearch.slow);
    await input.fill('customer');
    await page.getByRole('option',{name:/Remote matching project/}).waitFor();
    await page.evaluate(()=>window.pendingSearch.slow({results:[{id:'stale',title:'Stale result'}]}));
    assert.equal(await page.getByText('Stale result').count(),0);
    await input.press('ArrowDown');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>window.handle.value),'project-9000');
    assert.equal(await input.inputValue(),'Remote matching project');
    await input.fill('');
    await page.getByText('Recently selected',{exact:true}).waitFor();
    await page.getByRole('option',{name:/No project.*assign later/}).click();
    assert.equal(await page.evaluate(()=>window.handle.value),'');
    assert.ok(await page.evaluate(()=>window.queries.every(q=>q.limit===12&&q.types==='projects')));
    assert.equal(await input.getAttribute('aria-expanded'),'false');
  } finally {await browser.close();}
});
