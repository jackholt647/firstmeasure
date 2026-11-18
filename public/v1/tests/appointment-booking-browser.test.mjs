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
const navigation = await readFile(new URL('../../libraries/navigation/portal-navigation.js', import.meta.url), 'utf8');
test('booking styles never use a font shorthand with inherit as the family (FM-503)',()=>{
  // `font:16px/1.2 inherit` is invalid CSS: the browser drops the whole declaration, so older Inter rules won.
  assert.doesNotMatch(styles,/font:[^;}]*\sinherit\s*[;}]/);
});
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
    await page.getByRole('button',{name:'Create event',exact:true}).click();
    await page.getByText('Event created.',{exact:true}).waitFor();
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
 try{const page=await browser.newPage({viewport:{width:1280,height:800}});await page.clock.setFixedTime(new Date('2026-10-20T12:00:00'));await page.route('http://localhost/**',r=>r.fulfill({body:'<html></html>',contentType:'text/html'}));await page.goto('http://localhost/');await page.addStyleTag({content:styles});for(const content of [picker,selector,configuration,booking])await page.addScriptTag({content});
 await page.evaluate(async()=>{const base={title:'Installation',department_ids:[],delivery:false,timing_mode:'days',duration_days:2,location:{mode:'none',address:''},duration_minutes:60,window_minutes:60,slot_minutes:30,requirements:[],recurrence:null};window.booked=[];window.PlatformAPI={projects:{list:async()=>({documents:[]})},appointments:{catalog:async()=>({catalog:{departments:[],groups:[],presets:[{id:'installation',label:'Installation',configuration:base}]},resources:[]}),preview:async(org,input)=>{const start=new Date(input.date+'T00:00:00Z'),end=new Date(+start+input.configuration.duration_days*86400000),blocked=new Date('2026-11-03T00:00:00Z');return {slots:[{start_at:start.toISOString(),available:!(start<=blocked&&end>blocked),window_end_at:end.toISOString()}]};},book:async(org,input)=>window.booked.push(input)}};await FirstMateBooking.open({orgId:'org',date:'2026-10-30'});});
 await page.locator('[data-preset-button=installation]').first().click();assert.equal(await page.locator('.fmle-time-panel').count(),0);assert.equal(await page.locator('[data-duration-preset="7"]').innerText(),'1 week');await page.locator('[data-range-date="2026-10-30"]').click();await page.waitForFunction(()=>!document.querySelector('.fm-range [type=submit]').disabled);assert.match(await page.locator('[data-range-end]').innerText(),/Oct 31/);
 await page.locator('[data-range-field=end]').click();await page.locator('[data-range-month="1"]').click();await page.locator('[data-range-date="2026-11-02"]').click();await page.waitForFunction(()=>!document.querySelector('.fm-range [type=submit]').disabled);assert.match(await page.locator('[data-range-end]').innerText(),/Nov 2/);assert.equal(await page.locator('[data-days]').inputValue(),'4');assert.equal(await page.locator('[data-range-date="2026-11-03"]').isDisabled(),true);assert.equal(await page.locator('[data-range-date="2026-11-01"]').evaluate(el=>el.classList.contains('in-range')),true);
 await page.setViewportSize({width:390,height:844});assert.ok(await page.locator('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth&&el.scrollHeight<=el.clientHeight+1));await page.locator('.fm-range [type=submit]').click();await page.getByText('Event created.',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.booked[0].configuration.duration_days),4);assert.equal(await page.evaluate(()=>window.booked[0].start_at),'2026-10-30T00:00:00.000Z');
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

test('phones book in steps: type, then project or address, then time with Create event',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});page.setDefaultTimeout(5000);
  // The portal's fonts.css names its font on elements (div, button, input, ...), not on body.
  await page.route('http://localhost/**',r=>r.fulfill({body:'<html><head><style>div,p,h3,button,input,select{font-family:Georgia}</style></head><body></body></html>',contentType:'text/html'}));await page.goto('http://localhost/');await page.addStyleTag({content:styles});
  for(const content of [picker,selector,configuration,booking])await page.addScriptTag({content});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>{
   const base={department_ids:[],delivery:false,timing_mode:'timed',duration_days:2,location:{mode:'project',address:''},window_minutes:90,slot_minutes:30,requirements:[],recurrence:null};
   let catalog={departments:[],groups:[],presets:[{id:'sales',label:'Sales appointment',configuration:{...base,title:'Sales appointment',duration_minutes:90,window_minutes:90}}]};
   window.previews=[];window.bookings=[];window.saved=[];
   window.PlatformAPI={projects:{get:async(o,id)=>({document:{id,data:{title:'Smith residence',address:'123 Maple Street'}}})},
    search:{projectsAndContacts:async(o,{query})=>({results:query&&!'123 maple street smith residence'.includes(query.toLowerCase())?[]:[{id:'p1',title:'Smith residence',subtitle:'123 Maple Street'}]})},
    appointments:{catalog:async()=>({can_manage:true,revision:4,resources:[],catalog}),saveCatalog:async(o,input)=>{window.saved.push(input);catalog=input.catalog;return {can_manage:true,revision:5,resources:[],catalog};},
     preview:async(o,input)=>{window.previews.push(input);return {slots:[{available:true,start_at:'2026-11-17T15:00:00Z',label:'10:00 AM'}]};},book:async(o,input)=>{window.bookings.push(input);return {ok:true};}}};
   return FirstMateBooking.open({orgId:'org'});
  });
  const visibleStep=()=>page.evaluate(()=>document.querySelector('[data-step]:not([hidden])').dataset.step);
  assert.equal(await page.locator('dialog.fm-booking-steps').isVisible(),true);
  assert.equal(await visibleStep(),'type');assert.equal(await page.locator('[data-prev]').isVisible(),false);
  assert.equal(await page.locator('.fm-ap-type-custom').getAttribute('aria-pressed'),'false');
  assert.equal(await page.evaluate(()=>window.previews.length),0,'availability waits for the time step');
  // A type moves on by itself. With nothing typed the step offers New project and No project, not a recent list,
  // and Next waits for a choice; New project stays in the footer while results show (FM-556).
  await page.locator('.fm-ap-type[data-preset-button=sales]').click();
  await page.waitForFunction(()=>document.querySelector('[data-step=project]:not([hidden])'));
  assert.equal(await page.locator('[data-step=project] .fm-booking-hint:visible').count(),0);
  assert.equal(await page.locator('.fm-project-results').isVisible(),false);assert.equal(await page.getByRole('option').count(),0);
  assert.equal(await page.locator('.fm-booking-choices').isVisible(),true);
  assert.equal(await page.locator('[data-next]').isDisabled(),true);
  const search=page.getByRole('combobox',{name:'Search projects or type an address'});
  await search.fill('maple');await page.getByRole('option',{name:/Smith residence/}).waitFor();
  assert.equal(await page.locator('.fm-booking-choices').isVisible(),false);
  assert.equal(await page.locator('.fm-booking-footer [data-new-project]').isVisible(),true);
  assert.equal(await page.locator('[data-next]').isDisabled(),true);
  for(const selector of ['.fm-project-selector input','.fm-project-results [role=option]'])assert.equal(await page.locator(selector).first().evaluate(el=>getComputedStyle(el).fontFamily),'Georgia',selector);
  assert.equal(await page.getByRole('option',{name:/Smith residence/}).locator('small').innerText(),'123 Maple Street');
  assert.ok(await page.locator('.fm-booking-footer').evaluate(el=>el.scrollWidth<=el.clientWidth),'three footer buttons fit a phone');
  // Typing an address finds the project; an unknown address can be used on its own.
  await search.fill('42 Unknown Road');await page.getByRole('option',{name:/Use “42 Unknown Road”/}).click();
  assert.equal(await visibleStep(),'when');
  await page.waitForFunction(()=>window.previews.length);
  assert.deepEqual(await page.evaluate(()=>window.previews.at(-1).configuration.location),{mode:'custom',address:'42 Unknown Road'});
  assert.equal(await page.evaluate(()=>'project_id' in window.previews.at(-1)),false);
  assert.equal(await page.locator('.fm-ap-step-quick [data-duration-preset="90"]').getAttribute('aria-pressed'),'true');
  await page.locator('[data-prev]').click();assert.equal(await visibleStep(),'project');
  await search.fill('maple');await page.getByRole('option',{name:/Smith residence/}).click();
  await page.waitForFunction(()=>window.previews.at(-1)?.project_id==='p1');
  assert.equal(await page.evaluate(()=>window.previews.at(-1).configuration.location.mode),'project');
  assert.match(await page.locator('[data-summary]').innerText(),/Sales appointment[\s\S]*Smith residence/);
  // Advanced settings float over any step.
  await page.getByRole('button',{name:'Advanced'}).click();assert.equal(await page.locator('#fm-booking-sheet').isVisible(),true);
  await page.locator('label:has(>[data-delivery])').click();await page.keyboard.press('Escape');
  await page.waitForFunction(()=>document.querySelector('#fm-booking-sheet').hidden);assert.equal(await page.locator('dialog').isVisible(),true);
  assert.equal(await page.evaluate(()=>window.previews.at(-1).configuration.delivery),true);
  assert.equal(await page.getByRole('button',{name:'Book appointment'}).count(),0);
  const create=page.getByRole('button',{name:'Create event',exact:true});assert.equal(await create.isDisabled(),true);
  await page.getByRole('button',{name:'10:00 AM',exact:true}).click();await create.click();
  await page.getByRole('heading',{name:'Event created'}).waitFor();
  assert.deepEqual(await page.locator('[data-done-summary] dt').allInnerTexts(),['Type','Project','Time'].map(label=>label.toUpperCase()));
  // Delivery was switched on in Advanced, so the type is Custom; the name is the project's, so it is not repeated.
  assert.equal(await page.locator('.fm-booking-created-title').count(),0);
  assert.deepEqual(await page.locator('[data-done-summary] dd').allInnerTexts(),['Custom','Smith residence',(await page.evaluate(()=>new Date('2026-11-17T15:00:00Z').toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'})))+'\n10:00 AM']);
  assert.equal(await page.evaluate(()=>window.bookings.length),1);assert.equal(await page.evaluate(()=>window.bookings[0].project_id),'p1');
  assert.ok(await page.locator('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth));
  await page.getByRole('button',{name:'Done',exact:true}).click();await page.locator('dialog').waitFor({state:'detached'});
  // New type is its own screen (FM-558): a type name and the type's settings, never an appointment name. Saving adds it
  // to the catalog for everyone, then the booking continues with the new type chosen.
  await page.evaluate(()=>FirstMateBooking.open({orgId:'org',projectId:'p1',lockProject:true}));
  assert.equal(await page.locator('[data-progress]').count(),2);
  await page.getByRole('button',{name:'Advanced'}).click();
  assert.equal(await page.locator('#fm-booking-sheet [data-title]').isVisible(),true,'an appointment has a name');
  assert.equal(await page.locator('#fm-booking-sheet [data-type-name]').count(),0,'Advanced never saves a type');
  // Help marks open on tap and leave the switch alone.
  const help=page.locator('#fm-booking-sheet .fm-ap-switch:has([data-delivery]) [data-help]');
  await help.tap();assert.equal(await help.getAttribute('aria-expanded'),'true');
  assert.equal(await page.locator('#fm-booking-sheet [data-delivery]').isChecked(),false);
  const bubble=page.locator('#fm-booking-sheet .fm-ap-switch:has([data-delivery]) .fm-ap-help-bubble');
  assert.equal(await bubble.isVisible(),true);assert.match(await bubble.innerText(),/delivery/i);
  const box=await bubble.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=390,'the bubble stays on screen');
  await page.locator('#fm-booking-sheet-title').tap();assert.equal(await help.getAttribute('aria-expanded'),'false');
  await page.locator('[data-sheet-done]').click();await page.waitForFunction(()=>document.querySelector('#fm-booking-sheet').hidden);
  await page.locator('[data-new-type]').click();await page.locator('#fm-booking-type-sheet [data-type-name]').waitFor();
  assert.equal(await page.getByRole('heading',{name:'New appointment type'}).isVisible(),true);
  assert.equal(await page.locator('#fm-booking-type-sheet [data-title]').count(),0,'a type has a type name, not an appointment name');
  await page.locator('[data-type-save]').click();assert.equal(await page.locator('[data-type-status]').innerText(),'Name the type first.');
  assert.equal(await page.evaluate(()=>window.saved.length),0);
  await page.locator('#fm-booking-type-sheet [data-type-name]').fill('Gutter check');
  await page.locator('#fm-booking-type-sheet [data-duration-preset="30"]').click();
  await page.locator('[data-type-save]').click();
  await page.waitForFunction(()=>document.querySelector('[data-step=when]:not([hidden])'));
  assert.equal(await page.locator('#fm-booking-type-sheet').isHidden(),true);
  assert.equal(await page.evaluate(()=>window.saved[0].revision),4);assert.deepEqual(await page.evaluate(()=>window.saved[0].catalog.presets.map(p=>p.label)),['Sales appointment','Gutter check']);
  assert.deepEqual(await page.evaluate(()=>{const c=window.saved[0].catalog.presets[1].configuration;return [c.title,c.duration_minutes];}),['Gutter check',30]);
  assert.match(await page.locator('[data-summary]').innerText(),/Gutter check/);
  await page.waitForFunction(()=>window.previews.at(-1)?.configuration.duration_minutes===30);
  // Cancel leaves the appointment as it was and saves nothing.
  await page.getByRole('button',{name:'Close appointment booking'}).click();await page.locator('dialog').waitFor({state:'detached'});
  await page.evaluate(()=>FirstMateBooking.open({orgId:'org',projectId:'p1',lockProject:true}));
  await page.locator('[data-new-type]').click();await page.locator('#fm-booking-type-sheet [data-type-name]').fill('Never saved');
  await page.locator('[data-type-cancel]').click();await page.waitForFunction(()=>document.querySelector('#fm-booking-type-sheet').hidden);
  assert.equal(await page.evaluate(()=>window.saved.length),1);assert.equal(await page.evaluate(()=>document.querySelector('[data-step]:not([hidden])').dataset.step),'type');
 }finally{await browser.close();}
});

test('phones make a new project in its own step, every field optional, or book with No project on purpose (FM-556)',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:360,height:740},hasTouch:true});page.setDefaultTimeout(5000);
  await page.route('http://localhost/**',r=>r.fulfill({body:'<html><body></body></html>',contentType:'text/html'}));await page.goto('http://localhost/');await page.addStyleTag({content:styles});
  for(const content of [picker,selector,configuration,booking])await page.addScriptTag({content});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>{
   const base={department_ids:[],delivery:false,timing_mode:'timed',duration_days:2,location:{mode:'project',address:''},window_minutes:60,slot_minutes:30,requirements:[],recurrence:null};
   const catalog={departments:[],groups:[],presets:[{id:'sales',label:'Sales appointment',configuration:{...base,title:'Sales appointment',duration_minutes:60}}]};
   window.previews=[];window.saves=[];window.links=[];window.failNextSave=true;const stored={};
   window.PlatformAPI={projects:{get:async(o,id)=>({document:{id,data:stored[id]||{}}}),save:async(o,id,data,metadata,options)=>{window.saves.push({id,data,options});if(window.failNextSave){window.failNextSave=false;throw new Error('Network down');}stored[id]=data;return {ok:true,document:{id,data}};}},
    contacts:{setProjectContacts:async(o,id,links)=>{window.links.push({id,links});return {ok:true};}},
    search:{projectsAndContacts:async()=>({results:[]})},
    appointments:{catalog:async()=>({can_manage:false,revision:1,resources:[],catalog}),preview:async(o,input)=>{window.previews.push(input);return {slots:[]};},book:async()=>({ok:true})}};
   return FirstMateBooking.open({orgId:'org'});
  });
  const visibleStep=()=>page.evaluate(()=>document.querySelector('[data-step]:not([hidden])').dataset.step);
  const footerNew=page.locator('.fm-booking-footer [data-new-project]'),next=page.locator('[data-next]'),search=page.getByRole('combobox',{name:'Search projects or type an address'});
  await page.locator('.fm-ap-type[data-preset-button=sales]').click();
  await page.waitForFunction(()=>document.querySelector('[data-step=project]:not([hidden])'));
  assert.ok(await page.locator('.fm-booking-footer').evaluate(el=>el.scrollWidth<=el.clientWidth));
  // What was typed in the search starts the new project; it is its own step under Project.
  await search.fill('15 Elm Street');await footerNew.click();
  assert.equal(await visibleStep(),'new');assert.equal(await page.locator('[data-progress=project]').getAttribute('data-state'),'current');
  assert.equal(await footerNew.isVisible(),false);assert.equal(await next.isDisabled(),false);
  assert.equal(await page.locator('[data-new-field=address]').inputValue(),'15 Elm Street');
  await page.locator('[data-new-field=name]').fill('Jane Roe');await page.locator('[data-new-field=phone]').fill('555 0100');
  // A failed save keeps the step and the project id, so trying again never makes two.
  await next.click();await page.locator('[data-status]',{hasText:'Network down'}).waitFor();assert.equal(await visibleStep(),'new');
  await next.click();await page.waitForFunction(()=>document.querySelector('[data-step=when]:not([hidden])'));
  const saves=await page.evaluate(()=>window.saves);assert.equal(saves.length,2);assert.equal(saves[0].id,saves[1].id);
  assert.deepEqual(saves[1].options,{createOnly:true});assert.equal(saves[1].data.address,'15 Elm Street');assert.equal(saves[1].data.title,'Jane Roe');
  assert.deepEqual(await page.evaluate(()=>window.links),[{id:saves[1].id,links:[{name:'Jane Roe',phone:'555 0100',email:'',primary:true}]}]);
  await page.waitForFunction(id=>window.previews.at(-1)?.project_id===id,saves[1].id);
  assert.match(await page.locator('[data-summary]').innerText(),/Jane Roe/);
  // Back on Project the new project is the choice, so Next can go on.
  await page.locator('[data-prev]').click();assert.equal(await visibleStep(),'project');
  assert.equal(await search.inputValue(),'Jane Roe');assert.equal(await next.isDisabled(),false);
  // Skipping every field still makes a (blank) project, without a contact.
  await footerNew.click();assert.equal(await page.locator('[data-new-field=address]').inputValue(),'');
  await next.click();await page.waitForFunction(()=>document.querySelector('[data-step=when]:not([hidden])'));
  const blank=await page.evaluate(()=>window.saves.at(-1));assert.notEqual(blank.id,saves[1].id);assert.equal(blank.data.title,'New Project');assert.equal(blank.data.address,'');
  assert.equal(await page.evaluate(()=>window.links.length),1);
  // No project is a choice of its own; typing again undoes it.
  await page.locator('[data-prev]').click();await search.fill('');
  assert.equal(await next.isDisabled(),true);
  await page.locator('[data-no-project]').click();assert.equal(await visibleStep(),'when');
  await page.waitForFunction(()=>window.previews.length&&!('project_id' in window.previews.at(-1)));
  assert.match(await page.locator('[data-summary]').innerText(),/No project/);
  await page.locator('[data-prev]').click();assert.equal(await page.locator('[data-no-project]').getAttribute('aria-pressed'),'true');assert.equal(await next.isDisabled(),false);
  await search.fill('x');assert.equal(await next.isDisabled(),true);
 }finally{await browser.close();}
});

test('a type that needs a project hides No project; the New project step uses Google addresses and a tidy footer (FM-557)',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:412,height:860},hasTouch:true});page.setDefaultTimeout(5000);
  await page.route('http://localhost/**',r=>r.fulfill({body:'<html><body></body></html>',contentType:'text/html'}));await page.goto('http://localhost/');await page.addStyleTag({content:styles});
  // A stand-in for the portal's Google Places: one list on the body per field, filled as Google does, and a pick.
  await page.evaluate(()=>{
   window.google={maps:{event:{clearInstanceListeners(){}},places:{Autocomplete:class{
    constructor(input){this.input=input;this.listeners={};const list=document.createElement('div');list.className='pac-container';list.style.cssText='position:absolute;top:900px;left:0;display:none';document.body.append(list);window.placesList=list;
     input.addEventListener('input',()=>{list.innerHTML='<div class="pac-item"><span class="pac-item-query">15 Elm Street</span> Springfield, IL, USA</div>';list.style.display='';});
     list.addEventListener('mousedown',event=>{event.preventDefault();list.style.display='none';input.value='15 Elm Street, Springfield, IL 62701, USA';this.listeners.place_changed?.();});}
    addListener(name,fn){this.listeners[name]=fn;}
    getPlace(){return {formatted_address:'15 Elm Street, Springfield, IL 62701, USA',geometry:{location:{lat:()=>39.8,lng:()=>-89.6}},address_components:[{types:['street_number'],long_name:'15',short_name:'15'},{types:['route'],long_name:'Elm Street',short_name:'Elm St'},{types:['locality'],long_name:'Springfield',short_name:'Springfield'},{types:['administrative_area_level_1'],long_name:'Illinois',short_name:'IL'},{types:['postal_code'],long_name:'62701',short_name:'62701'}]};}
   }}}};
  });
  for(const content of [picker,selector,configuration,booking])await page.addScriptTag({content});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>{
   const base={department_ids:[],delivery:false,timing_mode:'timed',duration_days:2,location:{mode:'project',address:''},duration_minutes:60,window_minutes:60,slot_minutes:30,requirements:[],recurrence:null};
   let catalog={departments:[],groups:[],presets:[{id:'sales',label:'Sales appointment',configuration:{...base,title:'Sales appointment',requires_project:true}},{id:'meeting',label:'Team meeting',configuration:{...base,title:'Team meeting',requires_project:false}}]};
   window.saves=[];window.saved=[];const stored={};
   window.PlatformAPI={projects:{get:async(o,id)=>({document:{id,data:stored[id]||{}}}),save:async(o,id,data)=>{window.saves.push({id,data});stored[id]=data;return {ok:true,document:{id,data}};}},
    contacts:{setProjectContacts:async()=>({ok:true})},
    search:{projectsAndContacts:async()=>({results:[]})},
    appointments:{catalog:async()=>({can_manage:true,revision:1,resources:[],catalog}),saveCatalog:async(o,input)=>{window.saved.push(input);catalog=input.catalog;return {can_manage:true,revision:2,resources:[],catalog};},preview:async()=>({slots:[]}),book:async()=>({ok:true})}};
   return FirstMateBooking.open({orgId:'org'});
  });
  const visibleStep=()=>page.evaluate(()=>document.querySelector('[data-step]:not([hidden])').dataset.step);
  const search=page.getByRole('combobox',{name:'Search projects or type an address'}),none=page.locator('[data-no-project]');
  await page.locator('.fm-ap-type[data-preset-button=sales]').click();
  await page.waitForFunction(()=>document.querySelector('[data-step=project]:not([hidden])'));
  assert.equal(await none.isVisible(),false,'a sales appointment cannot be booked without a project');
  assert.equal(await page.locator('[data-needs-project]').innerText(),'“Sales appointment” needs a project.');
  await search.fill('42 Unknown Road');await page.waitForTimeout(400);
  assert.equal(await page.getByRole('option',{name:/Use “42 Unknown Road”/}).count(),0,'nor with just an address');
  // The footer does not stretch: Previous on the left, New project and a narrow Next together on the right.
  const box=selector=>page.locator(selector).boundingBox();
  const [footer,prev,newProject,next]=await Promise.all(['.fm-booking-footer','[data-prev]','.fm-booking-footer [data-new-project]','[data-next]'].map(box));
  assert.ok(next.width<newProject.width,`Next (${next.width}px) is narrower than New project (${newProject.width}px)`);
  assert.ok(Math.abs(footer.x+footer.width-16-(next.x+next.width))<=1,'Next is at the right edge');
  assert.ok(next.x-(newProject.x+newProject.width)<=12,'New project sits right beside Next');
  assert.ok(newProject.x-(prev.x+prev.width)>=24,'space between Previous and New project');
  assert.ok(await page.locator('.fm-booking-footer').evaluate(el=>el.scrollWidth<=el.clientWidth));
  // New project: Google's address list shows under the field inside the dialog, and a pick saves where it is.
  await search.fill('');await page.locator('.fm-booking-footer [data-new-project]').click();assert.equal(await visibleStep(),'new');
  const address=page.locator('[data-new-field=address]');
  await address.focus();await page.waitForFunction(()=>window.placesList?.parentElement?.id==='fm-booking-dialog');
  await address.pressSequentially('15 Elm');
  const [field,list]=await Promise.all([address.boundingBox(),page.locator('.pac-container').boundingBox()]);
  assert.ok(Math.abs(list.y-(field.y+field.height+4))<=2&&Math.abs(list.x-field.x)<=1&&Math.abs(list.width-field.width)<=1,'the list sits under the field '+JSON.stringify([field,list]));
  assert.equal(await page.locator('.pac-container').evaluate(el=>document.elementFromPoint(el.getBoundingClientRect().x+20,el.getBoundingClientRect().y+10)?.closest('.pac-container')===el),true,'the list is above the dialog, not under it');
  await address.press('Enter');assert.equal(await page.locator('[data-new-field=name]').evaluate(el=>el===document.activeElement),false,'Enter with the list open picks, it does not move on');
  await page.locator('.pac-item').click();
  assert.equal(await address.inputValue(),'15 Elm Street, Springfield, IL 62701, USA');
  // Name and phone share a row, email under them, as in the project's details tray.
  const [name,phone,email]=await Promise.all(['name','phone','email'].map(key=>box(`[data-new-field=${key}]`)));
  assert.equal(name.y,phone.y);assert.ok(name.x<phone.x);assert.ok(email.y>name.y);assert.equal(email.x,name.x);
  await page.locator('[data-new-field=name]').fill('Jane Roe');
  await page.locator('[data-next]').click();await page.waitForFunction(()=>document.querySelector('[data-step=when]:not([hidden])'));
  const saved=await page.evaluate(()=>window.saves.at(-1).data);
  assert.deepEqual([saved.address,saved.lat,saved.lng,saved.address_components.city,saved.address_components.zip],['15 Elm Street, Springfield, IL 62701, USA',39.8,-89.6,'Springfield','62701']);
  // A type that does not need a project offers No project again.
  await page.locator('[data-progress=type] button').click();await page.locator('.fm-ap-type[data-preset-button=meeting]').click();
  await page.waitForFunction(()=>document.querySelector('[data-step=project]:not([hidden])'));await search.fill('');
  assert.equal(await none.isVisible(),true);assert.equal(await page.locator('[data-needs-project]').isVisible(),false);
  // Whether a new type needs a project is set when it is made.
  await page.locator('[data-progress=type] button').click();
  await page.locator('[data-new-type]').click();await page.locator('#fm-booking-type-sheet [data-type-name]').fill('Roof inspection');
  const needs=page.locator('#fm-booking-type-sheet [data-requires-project]');assert.equal(await needs.isChecked(),false);
  await page.locator('#fm-booking-type-sheet label:has(>[data-requires-project])').click();assert.equal(await needs.isChecked(),true);
  await page.locator('[data-type-save]').click();await page.waitForFunction(()=>document.querySelector('[data-step=project]:not([hidden])'));
  assert.equal(await page.evaluate(()=>window.saved[0].catalog.presets.at(-1).configuration.requires_project),true);
  assert.equal(await none.isVisible(),false);
  await page.getByRole('button',{name:'Close appointment booking'}).click();await page.locator('dialog').waitFor({state:'detached'});
  assert.equal(await page.locator('.pac-container').count(),0,'the list goes with the dialog');
 }finally{await browser.close();}
});

test('the phone back control is Previous: each step, the Advanced sheet, then closing, with nothing left behind (FM-554)',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});page.setDefaultTimeout(5000);
  await page.route('http://localhost/**',r=>r.fulfill({body:'<html><body><button id="book">New appointment</button></body></html>',contentType:'text/html'}));await page.goto('http://localhost/?tab=scheduling');await page.addStyleTag({content:styles});
  for(const content of [navigation,picker,selector,configuration,booking])await page.addScriptTag({content});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>{
   const base={department_ids:[],delivery:false,timing_mode:'timed',duration_days:2,location:{mode:'project',address:''},window_minutes:90,slot_minutes:30,requirements:[],recurrence:null};
   const catalog={departments:[],groups:[],presets:[{id:'sales',label:'Sales appointment',configuration:{...base,title:'Sales appointment',duration_minutes:90,window_minutes:90}}]};
   window.routeApplies=0;Portal.navigation.registerHandler('test',{apply:()=>{window.routeApplies++;}});
   window.PlatformAPI={projects:{get:async(o,id)=>({document:{id,data:{title:'Smith residence',address:'123 Maple Street'}}})},
    search:{projectsAndContacts:async()=>({results:[{id:'p1',title:'Smith residence',subtitle:'123 Maple Street'}]})},
    appointments:{catalog:async()=>({can_manage:true,revision:4,resources:[],catalog}),saveCatalog:async()=>({}),
     preview:async()=>({slots:[{available:true,start_at:'2026-11-17T15:00:00Z',label:'10:00 AM'}]}),book:async()=>({ok:true})}};
   document.querySelector('#book').addEventListener('click',()=>FirstMateBooking.open({orgId:'org'}));
  });
  const visibleStep=()=>page.evaluate(()=>document.querySelector('[data-step]:not([hidden])')?.dataset.step);
  const depth=n=>page.waitForFunction(n=>(history.state?.fmSteps?.depth??0)===n,n);
  const back=()=>page.evaluate(()=>history.back());
  const before=await page.evaluate(()=>history.length);
  await page.locator('#book').click();await page.locator('dialog.fm-booking-steps').waitFor();
  await depth(1);
  await page.locator('.fm-ap-type[data-preset-button=sales]').click();
  await page.waitForFunction(()=>document.querySelector('[data-step=project]:not([hidden])'));await depth(2);
  // Back from Project is Type; Next again, then the address takes it to When.
  await back();await page.waitForFunction(()=>document.querySelector('[data-step=type]:not([hidden])'));await depth(1);
  await page.locator('.fm-ap-type[data-preset-button=sales]').click();
  await page.waitForFunction(()=>document.querySelector('[data-step=project]:not([hidden])'));await depth(2);
  const search=page.getByRole('combobox',{name:'Search projects or type an address'});
  await search.fill('42 Unknown Road');await page.getByRole('option',{name:/Use “42 Unknown Road”/}).click();
  assert.equal(await visibleStep(),'when');await depth(3);
  // Advanced is one more back press: it closes the sheet and stays on When.
  await page.getByRole('button',{name:'Advanced'}).click();await depth(4);
  await back();await page.waitForFunction(()=>document.querySelector('[data-advanced-open]').getAttribute('aria-expanded')==='false');
  assert.equal(await visibleStep(),'when');await depth(3);
  // Previous in the footer takes its entry off too.
  await page.locator('[data-prev]').click();assert.equal(await visibleStep(),'project');await depth(2);
  await back();await page.waitForFunction(()=>document.querySelector('[data-step=type]:not([hidden])'));await depth(1);
  // Back on the first step closes the booking, and the page is where it was.
  await back();await page.locator('dialog').waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>history.state?.fmSteps),undefined);
  assert.equal(await page.evaluate(()=>location.search),'?tab=scheduling');
  // Closing with the X from a later step takes every entry off.
  await page.locator('#book').click();await page.locator('dialog.fm-booking-steps').waitFor();await depth(1);
  await page.locator('.fm-ap-type[data-preset-button=sales]').click();await depth(2);
  await page.getByRole('button',{name:'Close appointment booking'}).click();await page.locator('dialog').waitFor({state:'detached'});
  await depth(0);
  assert.equal(await page.evaluate(()=>window.routeApplies),0,'no back press re-applied the route');
  assert.ok(await page.evaluate(()=>history.length)>=before);
 }finally{await browser.close();}
});
