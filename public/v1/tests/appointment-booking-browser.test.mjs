import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {chromium} from 'playwright-core';

const styles = await readFile(new URL('../../libraries/appointment-booking/booking.css', import.meta.url), 'utf8');
const settings = await readFile(new URL('../../libraries/appointment-booking/settings.js', import.meta.url), 'utf8');
const picker = await readFile(new URL('../../libraries/appointment-booking/availability.js', import.meta.url), 'utf8');
const selector = await readFile(new URL('../../libraries/project-selector/project-selector.js', import.meta.url), 'utf8');
const configuration = await readFile(new URL('../../libraries/appointment-booking/configuration.js', import.meta.url), 'utf8');
const booking = await readFile(new URL('../../libraries/appointment-booking/booking.js', import.meta.url), 'utf8');
const scheduling = await readFile(new URL('../../libraries/apps/scheduling/app.js', import.meta.url), 'utf8');
test('presets request a named assignee up front; advanced changes become Custom and keep independent flags',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1000,height:1000}});
    await page.route('http://localhost/**',route=>route.fulfill({body:'<html><body></body></html>',contentType:'text/html'}));await page.goto('http://localhost/');await page.addStyleTag({content:styles});
    for(const content of [picker,selector,configuration,booking])await page.addScriptTag({content});
    await page.evaluate(()=>{
      const config={title:'Consultation',department_ids:['sales'],delivery:false,duration_minutes:60,window_minutes:60,slot_minutes:30,recurrence:null,requirements:[{department_id:'sales',subject_type:'organization_user',mode:'specific',subject_keys:[],count:1,percent:100,crew_member_percent:0}]};
      window.requests=[];
      window.PlatformAPI={projects:{get:async()=>({document:{id:'project',data:{title:'Project'}}})},appointments:{catalog:async()=>({can_manage:false,resources:[{id:'person',key:'organization_user:person',name:'Alex',subject_type:'organization_user'}],catalog:{departments:[{id:'sales',label:'Sales'},{id:'production',label:'Production'}],groups:[],presets:[{id:'consultation',label:'Consultation',configuration:config}]}}),preview:async(org,input)=>{window.requests.push(input);return {slots:[{start_at:'2026-10-08T15:00:00Z',available:true,label:'10:00 AM'}]};},book:async()=>({ok:true})}};
      return FirstMateBooking.open({orgId:'org',projectId:'project',lockProject:true});
    });
    await page.locator('[data-preset-button=consultation]').first().click();
    assert.equal(await page.locator('[data-advanced]').getAttribute('open'),null);
    await page.locator('.fm-ap-quick [data-people-picker] summary').click();await page.locator('.fm-ap-quick [data-specific]').check();await page.locator('.fm-ap-quick [data-people-picker] summary').click();
    await page.locator('[data-advanced]>summary').click();
    await page.locator('label:has(>[data-delivery])').click();
    await page.locator('label:has(>[data-department][value=production])').click();await page.locator('label:has(>[data-window-toggle])').click();
    await page.locator('[data-window]').fill('240');await page.locator('[data-window]').press('Tab');
    await page.locator('label:has(>[data-recurring])').click();
    assert.equal(await page.locator('[data-preset-button=""]').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('[data-manage],[data-save-preset]').count(),0);
    const selected=await page.evaluate(()=>window.requests.at(-1).configuration);
    assert.deepEqual(selected.department_ids,['sales','production']);assert.equal(selected.delivery,true);assert.equal(selected.recurrence.frequency,'weekly');assert.equal(selected.window_minutes,240);assert.equal(selected.duration_minutes,60);
    assert.deepEqual(selected.requirements[0].subject_keys,['organization_user:person']);
    assert.equal(await page.locator('[data-project] input').isDisabled(),true);
    await page.locator('[data-timing]').selectOption('days');
    assert.equal(await page.locator('[data-duration]').count(),0);
    await page.locator('[data-duration-preset="3"]').click();
    await page.getByLabel('Location presets',{exact:true}).click();await page.locator('[data-location-preset="1"]').click();
    assert.equal(await page.locator('[data-address]').getAttribute('placeholder'),'Company office address');
    const days=await page.evaluate(()=>window.requests.at(-1).configuration);assert.equal(days.timing_mode,'days');assert.equal(days.duration_days,3);assert.equal(days.location.mode,'company_office');
    await page.getByLabel('Location presets',{exact:true}).click();await page.locator('[data-location-preset="2"]').click();assert.equal(await page.locator('[data-address]').inputValue(),'');await page.locator('[data-address]').fill('123 New Street');await page.locator('[data-address]').press('Tab');assert.equal(await page.evaluate(()=>window.requests.at(-1).configuration.location.address),'123 New Street');

    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.locator('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth));
  }finally{await browser.close();}
});
test('direct Scheduling entry loads booking without the app manifest', async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true});
  try {
    const page = await browser.newPage();
    await page.route('http://localhost/**', route => {
      const url = new URL(route.request().url()).pathname;
      return route.fulfill({body:url.endsWith('/configuration.js') ? configuration : url.endsWith('/booking.js') ? booking : url.endsWith('/availability.js') ? picker : url.endsWith('/project-selector.js') ? selector : '<html><body></body></html>',contentType:url.endsWith('.js') ? 'text/javascript' : 'text/html'});
    });
    await page.goto('http://localhost/');await page.addStyleTag({content:styles});
    await page.evaluate(() => {
      window.orgId = () => 'org'; window.scheduleLoad = () => {};
      window.PlatformAPI = {projects:{list:async () => ({documents:[]})},appointments:{catalog:async()=>({catalog:{departments:[],presets:[],groups:[]},resources:[],can_manage:false}),preview:async()=>({slots:[]}),book:async () => ({ok:true})}};
    });
    await page.addScriptTag({content:scheduling.slice(scheduling.indexOf('  const bookingScriptUrl'),scheduling.indexOf('  const cfg =')) + '\nwindow.openBookingWidget = openBookingWidget;'});
    await page.evaluate(() => window.openBookingWidget());
    assert.equal(await page.getByRole('dialog').isVisible(),true);
    assert.equal(await page.locator('.fm-ap-project').isVisible(),true);assert.equal(await page.locator('[data-save-preset]').count(),0);
  } finally { await browser.close(); }
});
test('shared picker rejects stale responses, books once, and public embeds retain their calendar styling', async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1100,height:850}});
    await page.route('http://localhost/**', route => route.fulfill({body:'<html><body></body></html>',contentType:'text/html'}));
    await page.goto('http://localhost/');await page.addStyleTag({content:styles});
    page.setDefaultTimeout(5000);
    await page.setContent('<button id="opener">Open</button><div id="public"></div>');await page.addStyleTag({content:styles});
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
    assert.deepEqual(await page.locator('dialog').boundingBox(),{x:0,y:0,width:390,height:844});
    await page.setViewportSize({width:1100,height:850});
    if (process.env.BOOKING_SCREENSHOT) await page.screenshot({path:process.env.BOOKING_SCREENSHOT});
    await page.getByRole('button',{name:'Book appointment',exact:true}).click();
    await page.getByText('Appointment booked.',{exact:true}).waitFor();
    assert.equal(await page.evaluate(() => window.bookings.length),1);
    assert.equal(await page.evaluate(() => window.bookings[0].start_at),'2026-10-05T15:00:00Z');
    assert.equal(await page.evaluate(() => 'project_id' in window.bookings[0]),false);
    await page.getByRole('button',{name:'Close appointment booking'}).click();
    assert.equal(await page.evaluate(() => document.activeElement.id),'opener');
  } finally { await browser.close(); }
});

test('shared project selector searches remotely, remembers choices and supports keyboard clearing', async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try {
    const page = await browser.newPage();
    await page.route('http://localhost/**',route=>route.fulfill({body:'<div id="selector"></div>'}));
    await page.goto('http://localhost/');await page.addStyleTag({content:styles});
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


test('calendar location overrides show the office or custom address, and no-location stays empty',()=>{
  const start=scheduling.indexOf('  function projectAddressValue('),end=scheduling.indexOf('  function missingAddressLabel()',start);
  const address=new Function('clean',scheduling.slice(start,end)+';return projectAddressValue;')(value=>String(value??'').trim());
  const project={address:'Customer property'};
  assert.equal(address(project,{location_mode:'company_office',location:{address:'Company office address'}}),'Company office address');
  assert.equal(address(project,{location_mode:'custom',address:'Meeting room'}),'Meeting room');
  assert.equal(address(project,{location_mode:'none',project_address:'Customer property'}),'');
  assert.equal(address(project,{location_mode:'company_office',location:{address:''}}),'Company office');
  assert.equal(address(project,{}),'Customer property');
});
test('Settings owns preset editing and preserves server concurrency errors',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage();await page.route('http://localhost/**',r=>r.fulfill({body:'<div id="settings"></div>',contentType:'text/html'}));await page.goto('http://localhost/');await page.addStyleTag({content:styles});for(const content of [configuration,settings])await page.addScriptTag({content});
  await page.evaluate(async()=>{
   window.saved=[];window.conflict=false;let data={can_manage:true,revision:3,resources:[],catalog:{departments:[],groups:[],presets:[]}};
   window.PlatformAPI={appointments:{catalog:async()=>structuredClone(data),saveCatalog:async(org,input)=>{if(window.conflict)throw Error('Settings changed. Reload before saving.');window.saved.push(input);data={...data,catalog:input.catalog,revision:data.revision+1};return structuredClone(data);}}};
   await FirstMateAppointmentSettings.mount(document.querySelector('#settings'),'org');
  });
  await page.locator('[data-preset-label]').fill('Quarterly visit');await page.locator('label:has(>[data-recurring])').click();await page.locator('[data-frequency]').selectOption('quarterly');await page.locator('[data-save-preset]').click();await page.getByText('Preset saved.',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.saved[0].revision),3);assert.equal(await page.evaluate(()=>window.saved[0].catalog.presets[0].configuration.recurrence.frequency),'quarterly');
  await page.evaluate(()=>window.conflict=true);await page.locator('[data-preset-label]').fill('Edited visit');await page.locator('[data-save-preset]').click();await page.getByText('Settings changed. Reload before saving.').waitFor();assert.equal(await page.locator('[data-preset-label]').inputValue(),'Edited visit');assert.equal(await page.evaluate(()=>window.saved.length),1);
  await page.evaluate(()=>window.conflict=false);await page.locator('[data-delete-preset]').click();await page.getByText('Preset deleted.',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.saved.at(-1).catalog.presets.length),0);
 }finally{await browser.close();}
});
test('Settings disables preset navigation while its editor is loading',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{const page=await browser.newPage();await page.route('http://localhost/**',r=>r.fulfill({body:'<div id="settings"></div>',contentType:'text/html'}));await page.goto('http://localhost/');for(const content of [configuration,settings])await page.addScriptTag({content});
 await page.evaluate(()=>{let calls=0;const data={can_manage:true,revision:1,resources:[],catalog:{departments:[],groups:[],presets:[{id:'existing',label:'Existing preset',configuration:{title:'Existing appointment'}}]}};window.PlatformAPI={appointments:{catalog:async()=>{if(++calls===2)await new Promise(resolve=>window.finishLoading=resolve);return structuredClone(data);}}};window.mounting=FirstMateAppointmentSettings.mount(document.querySelector('#settings'),'org');});
 await page.waitForFunction(()=>window.finishLoading);assert.equal(await page.locator('[data-new-preset]').isDisabled(),true);await page.evaluate(async()=>{window.finishLoading();await window.mounting;});await page.locator('[data-new-preset]').click();await page.waitForFunction(()=>!document.querySelector('[data-new-preset]').disabled);assert.equal(await page.locator('[data-preset-label]').inputValue(),'');assert.equal(await page.locator('[data-title]').inputValue(),'Appointment');
 }finally{await browser.close();}
});
test('versioned booking loads the new UI when old lazy scripts remain in the browser cache',async()=>{
 const {createServer}=await import('node:http');const requests=[];
 const scripts={'booking.js':booking,'configuration.js':configuration,'availability.js':picker,'project-selector.js':selector};
 const server=createServer((req,res)=>{const url=new URL(req.url,'http://localhost');requests.push(req.url);const name=url.pathname.split('/').pop();
  if(url.pathname==='/warm'){res.setHeader('Content-Type','text/html');res.end('<script src="/libraries/appointment-booking/booking.js"></script><script src="/libraries/appointment-booking/configuration.js"></script>');return;}
  if(url.pathname==='/new'){res.setHeader('Content-Type','text/html');res.end('<script src="/libraries/appointment-booking/booking.js?v=release-new"></script>');return;}
  res.setHeader('Cache-Control','public, max-age=31536000');res.setHeader('Content-Type',name.endsWith('.css')?'text/css':'text/javascript');
  if(!url.searchParams.has('v')){res.end(name==='booking.js'?'window.FirstMateBooking={old:true};':'window.FirstMateAppointmentConfiguration={old:true};');return;}
  res.end(name==='booking.css'?styles:scripts[name]||'');
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{const page=await browser.newPage();await page.goto(base+'/warm');assert.equal(await page.evaluate(()=>FirstMateBooking.old),true);await page.goto(base+'/new');await page.evaluate(async()=>{window.PlatformAPI={projects:{list:async()=>({documents:[]})},appointments:{catalog:async()=>({catalog:{departments:[],groups:[],presets:[]},resources:[]}),preview:async()=>({slots:[]}),book:async()=>({ok:true})}};await FirstMateBooking.open({orgId:'org'});});await page.locator('.fm-ap-presets').waitFor();assert.equal(await page.locator('[data-advanced]>summary').innerText(),'Advanced');assert.equal(await page.locator('[data-manage]').count(),0);for(const name of ['configuration.js','availability.js','booking.css'])assert.ok(requests.some(url=>url.endsWith(name+'?v=release-new')),name);assert.equal(requests.filter(url=>url==='/libraries/appointment-booking/configuration.js').length,1);
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
test('multi-day ranges cross months, exclude crew conflicts and book an inclusive end date',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{const page=await browser.newPage({viewport:{width:1280,height:800}});await page.route('http://localhost/**',r=>r.fulfill({body:'<html></html>',contentType:'text/html'}));await page.goto('http://localhost/');await page.addStyleTag({content:styles});for(const content of [picker,selector,configuration,booking])await page.addScriptTag({content});
 await page.evaluate(async()=>{const base={title:'Installation',department_ids:[],delivery:false,timing_mode:'days',duration_days:2,location:{mode:'none',address:''},duration_minutes:60,window_minutes:60,slot_minutes:30,requirements:[],recurrence:null};window.booked=[];window.PlatformAPI={projects:{list:async()=>({documents:[]})},appointments:{catalog:async()=>({catalog:{departments:[],groups:[],presets:[{id:'installation',label:'Installation',configuration:base}]},resources:[]}),preview:async(org,input)=>{const start=new Date(input.date+'T00:00:00Z'),end=new Date(+start+input.configuration.duration_days*86400000),blocked=new Date('2026-11-03T00:00:00Z');return {slots:[{start_at:start.toISOString(),available:!(start<=blocked&&end>blocked),window_end_at:end.toISOString()}]};},book:async(org,input)=>window.booked.push(input)}};await FirstMateBooking.open({orgId:'org',date:'2026-10-30'});});
 await page.locator('[data-preset-button=installation]').first().click();assert.equal(await page.locator('.fmle-time-panel').count(),0);assert.equal(await page.locator('[data-duration-preset="7"]').innerText(),'1 week');await page.locator('[data-range-date="2026-10-30"]').click();await page.waitForFunction(()=>!document.querySelector('.fm-range [type=submit]').disabled);assert.match(await page.locator('[data-range-end]').innerText(),/Oct 31/);
 await page.locator('[data-range-field=end]').click();await page.locator('[data-range-month="1"]').click();await page.locator('[data-range-date="2026-11-02"]').click();await page.waitForFunction(()=>!document.querySelector('.fm-range [type=submit]').disabled);assert.match(await page.locator('[data-range-end]').innerText(),/Nov 2/);assert.equal(await page.locator('[data-days]').inputValue(),'4');assert.equal(await page.locator('[data-range-date="2026-11-03"]').isDisabled(),true);assert.equal(await page.locator('[data-range-date="2026-11-01"]').evaluate(el=>el.classList.contains('in-range')),true);
 await page.setViewportSize({width:390,height:844});assert.ok(await page.locator('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth&&el.scrollHeight<=el.clientHeight+1));await page.locator('.fm-range [type=submit]').click();await page.getByText('Appointment booked.',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.booked[0].configuration.duration_days),4);assert.equal(await page.evaluate(()=>window.booked[0].start_at),'2026-10-30T00:00:00.000Z');
 }finally{await browser.close();}
});
test('project defaults supply the title, manual names survive, and project popovers fully dismiss',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{const page=await browser.newPage();await page.route('http://localhost/**',r=>r.fulfill({body:'<body style="font-family:Georgia"></body>',contentType:'text/html'}));await page.goto('http://localhost/');await page.addStyleTag({content:styles});for(const content of [picker,selector,configuration,booking])await page.addScriptTag({content});
 await page.evaluate(async()=>{window.requests=[];window.PlatformAPI={search:{projectsAndContacts:async()=>({results:[{id:'a',title:'Oak roof project'},{id:'b',title:'Pine siding project'}]})},projects:{get:async(org,id)=>({document:{id,data:{title:id==='a'?'Oak roof project':'Pine siding project',address:'123 Street'}}})},appointments:{catalog:async()=>({catalog:{departments:[],groups:[],presets:[{id:'sales',label:'Sales',configuration:{title:'Sales appointment'}}]},resources:[]}),preview:async(org,input)=>{window.requests.push(input);return {slots:[]};},book:async()=>({ok:true})}};await FirstMateBooking.open({orgId:'org'});});
 const summary=page.locator('.fm-ap-project>summary');await summary.click();await page.getByRole('option',{name:'Oak roof project',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-title-label]').textContent==='Oak roof project');assert.equal(await page.locator('.fm-ap-project').getAttribute('open'),null);assert.equal(await page.locator('.fm-ap-project .fm-ap-popover').isVisible(),false);
 await summary.click();await page.getByRole('heading',{name:'New appointment'}).click();assert.equal(await page.locator('.fm-ap-project .fm-ap-popover').isVisible(),false);await summary.click();await page.keyboard.press('Escape');assert.equal(await page.locator('dialog').isVisible(),true);assert.equal(await page.locator('.fm-ap-project .fm-ap-popover').isVisible(),false);
 await page.locator('.fm-ap-name>summary').click();await page.locator('[data-title]').fill('Roof walk');await page.locator('[data-title]').press('Tab');await summary.click();await page.getByRole('combobox').fill('Pine');await page.getByRole('option',{name:'Pine siding project',exact:true}).click();await page.locator('[data-preset-button=sales]').first().click();assert.equal(await page.locator('[data-title-label]').innerText(),'Roof walk');await page.locator('.fm-ap-name>summary').click();await page.locator('[data-title]').fill('');await page.locator('[data-title]').press('Tab');assert.equal(await page.locator('[data-title]').inputValue(),'Pine siding project');assert.equal(await page.locator('[data-title]').evaluate(el=>el.checkValidity()),true);assert.equal(await page.locator('#fm-booking-title').evaluate(el=>getComputedStyle(el).fontFamily),await page.locator('body').evaluate(el=>getComputedStyle(el).fontFamily));
 }finally{await browser.close();}
});
