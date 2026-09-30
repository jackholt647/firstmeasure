import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
const source = await readFile(new URL('../../libraries/date-time-picker/date-time-picker.js', import.meta.url), 'utf8');
const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const page = await browser.newPage({locale:'en-US'});
const errors=[]; page.on('pageerror',e=>errors.push(e.message));
const picker=()=>page.locator('fm-date-time-picker');
async function editTime(name,value){
 await picker().getByLabel(name,{exact:true}).fill(value);
}
async function setup(html){
 await page.goto("about:blank");
 await page.setContent(`<html lang="en"><head></head><body style="padding:30px;font:16px system-ui">${html}</body></html>`);
 await page.addScriptTag({content:source});
}
try {
 await setup('<form><label>Send at <input name="scheduled" type="datetime-local" value="2026-09-28T14:30"></label></form>');
 await page.evaluate(()=>{window.events=[];for(const t of ['input','change'])document.querySelector('input').addEventListener(t,e=>events.push([t,e.target.value]));});
 await page.locator('input').first().click();
 await editTime('Minute','45');
 await picker().getByRole('button',{name:'Apply',exact:true}).click();
 assert.equal(await page.locator('input').first().inputValue(),'2026-09-28T14:45');
 assert.deepEqual(await page.evaluate(()=>events),[['input','2026-09-28T14:45'],['change','2026-09-28T14:45']]);
 assert.equal(await page.evaluate(()=>new FormData(document.querySelector('form')).get('scheduled')),'2026-09-28T14:45');
 await page.locator('input').first().click();
 await editTime('Minute','50');
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('input').first().inputValue(),'2026-09-28T14:45');
 assert.equal(await page.locator('input').first().evaluate(e=>e===document.activeElement),true);
 console.log('PASS local datetime, events, form data, cancel, focus');

 await setup('<label>Receipt time <input type="time" step="1" value="23:59:12"></label>');
 await page.locator('input').first().focus(); await page.keyboard.press('Alt+ArrowDown');
 await editTime('Second','25');
 await picker().getByRole('button',{name:'Apply',exact:true}).click();
 assert.equal(await page.locator('input').first().inputValue(),'23:59:25');
 console.log('PASS seconds and keyboard opening');

 await setup('<label>Meeting <input type="time" min="09:00" max="17:00" step="900" value="09:00" required></label>');
 await page.locator('input').first().click();
 assert.equal(await picker().getByRole('button',{name:'Clear',exact:true}).isDisabled(),true);
 await editTime('Minute','07');
 await picker().getByRole('button',{name:'Apply',exact:true}).click();
 assert.equal(await page.locator('input').first().inputValue(),'09:00');
 assert.match(await picker().getByRole('alert').innerText(),/allowed range/);
 await editTime('Minute','15');
 await picker().getByRole('button',{name:'Apply',exact:true}).click();
 assert.equal(await page.locator('input').first().inputValue(),'09:15');
 console.log('PASS min/max/required/step');

 await setup('<label>Date <input type="date" value="2028-02-28" min="2028-02-01" max="2028-03-05"></label>');
 await page.locator('input').first().click(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
 await picker().getByRole('button',{name:'Apply',exact:true}).click();
 assert.equal(await page.locator('input').first().inputValue(),'2028-02-29');
 await page.locator('input').first().click(); await picker().getByRole('button',{name:'Next month',exact:true}).click();
 assert.equal(await picker().locator('[data-date="2028-03-06"]').isDisabled(),true);
 await picker().getByRole('button',{name:'Clear',exact:true}).click();
 assert.equal(await page.locator('input').first().inputValue(),'');
 console.log('PASS leap day, keyboard calendar, date bounds, clear');

 await setup('<dialog><label>Follow up <input type="date" value="2026-10-10"></label></dialog>');
 await page.evaluate(()=>document.querySelector('dialog').showModal());
 await page.locator('input').first().click();
 await picker().getByRole('button',{name:'Apply',exact:true}).click();
 assert.equal(await page.locator('dialog').evaluate(e=>e.open),true);
 await page.locator('input').first().click(); await page.evaluate(()=>document.querySelector('dialog').close());
 await page.waitForFunction(()=>!document.querySelector('fm-date-time-picker'));
 console.log('PASS native modal layering and teardown');

 await setup('<main></main>');
 await page.evaluate(()=>document.querySelector('main').innerHTML='<input type="date" value="2026-09-28">');
 await page.locator('input').first().click(); assert.equal(await picker().count(),1);
 await page.evaluate(()=>document.querySelector('input').remove());
 await page.waitForFunction(()=>!document.querySelector('fm-date-time-picker'));
 await page.evaluate(()=>document.querySelector('main').innerHTML='<input type="date" value="2026-09-28">');
 await page.evaluate(()=>{const i=document.querySelector('input');i.type='datetime-local';i.value='2026-09-28T09:00';});
 await page.locator('input').first().click(); assert.equal(await picker().getByLabel('Hour',{exact:true}).count(),1);
 console.log('PASS dynamic fields, type changes, detached cleanup');

 await setup('<div role="dialog"><label>Reminder <input type="datetime-local" value="2026-09-28T14:30"></label></div>');
 await page.evaluate(()=>{window.parentEscapes=0;document.addEventListener('keydown',e=>{if(e.key==='Escape')window.parentEscapes++;});});
 await page.locator('input').first().click(); await page.keyboard.press('Escape');
 assert.equal(await page.evaluate(()=>parentEscapes),0);
 assert.equal(await page.locator('[role="dialog"]').count(),1);
 await page.locator('input').first().click(); await page.locator('body').click({position:{x:5,y:5}});
 assert.equal(await picker().count(),0);
 console.log('PASS parent dialog Escape isolation and outside dismissal');

 await setup('<label>Precision <input type="time" step="0.001" value="09:00:05.125"></label>');
 await page.locator('input').first().click();
 await editTime('Second','5.25');
 await picker().getByRole('button',{name:'Apply',exact:true}).click();
 assert.equal(await page.locator('input').first().inputValue(),'09:00:05.250');
 console.log('PASS fractional seconds');

 await setup('<label>Time <input type="time" value="21:30"></label>');
 await page.evaluate(()=>document.documentElement.lang='de-DE');
 await page.locator('input').first().click();
 assert.equal(await picker().getByLabel('Hour',{exact:true}).inputValue(),'21');
 assert.equal(await picker().locator('[data-period]').count(),0);
 await picker().getByRole('button',{name:'Apply',exact:true}).click();
 console.log('PASS locale 24-hour clock');

 await setup('<input type="time" readonly value="09:00"><input type="date" data-native-picker>');
 await page.locator('input').first().click(); assert.equal(await picker().count(),0);
 await page.evaluate(()=>FirstMateDateTimePicker.open(document.querySelector('[data-native-picker]'))); assert.equal(await picker().count(),0);
 console.log('PASS readonly and opt-out');

 await setup('<div style="--primary:#16734a;--on-primary:#fff;--primary-readable:#125f3d"><label>Schedule <input type="datetime-local" value="2026-09-28T14:30" min="2026-09-28T09:00" max="2026-09-30T17:00"></label></div>');
 await page.setViewportSize({width:1100,height:800});
 await page.locator('input').first().click();
 const calendar=await picker().locator('.calendar').boundingBox(), times=await picker().locator('.time-section').boundingBox();
 assert.ok(times.x>calendar.x+calendar.width&&Math.abs(times.y-calendar.y)<2);
 assert.equal(await picker().locator('[data-date="2026-09-28"]').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(22, 115, 74)');
 assert.equal(await picker().locator('[data-slot="08:45"]').isDisabled(),true);
 await picker().locator('[data-date="2026-09-29"]').click();
 assert.equal(await page.locator('input').first().inputValue(),'2026-09-28T14:30');
 assert.equal(await picker().locator('[data-slot="08:45"]').isDisabled(),false);
 const scrollable=await picker().locator('.slots').evaluate(el=>el.scrollHeight>el.clientHeight&&getComputedStyle(el).touchAction==='pan-y');
 assert.equal(scrollable,true);
 await picker().locator('[data-slot="10:15"]').click();
 assert.equal(await picker().count(),0);
 assert.equal(await page.locator('input').first().inputValue(),'2026-09-29T10:15');
 console.log('PASS side-by-side layout, scoped branding, date-first slots, immediate selection and touch scroll');
 await page.locator('input').first().click();
 await picker().locator('[data-slot="10:15"]').focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
 assert.equal(await page.locator('input').first().inputValue(),'2026-09-29T10:30');
 console.log('PASS time-slot arrow navigation and Enter');

 await setup('<label>Schedule message <input type="datetime-local" value="2026-09-28T14:30"></label>');
 await page.setViewportSize({width:390,height:844});
 await page.locator('input').first().click();
 assert.equal(await picker().locator('details').count(),0);
 const custom=await picker().locator('.time').boundingBox(),slot=await picker().locator('[data-slot]').first().boundingBox(),period=await picker().locator('[data-period]').boundingBox();
 assert.equal(custom.height,slot.height);assert.ok(Math.abs(custom.width-slot.width)<1);assert.ok(period.y>=custom.y&&period.y+period.height<=custom.y+custom.height);
 assert.equal(await picker().locator('.picker').evaluate(el=>getComputedStyle(el).fontFamily),'system-ui');
 const bounds=await picker().locator('.picker').boundingBox();
 assert.ok(bounds.x>=0&&bounds.x+bounds.width<=390&&bounds.y>=0&&bounds.y+bounds.height<=844);
 const mobileCalendar=await picker().locator('.calendar').boundingBox(), mobileTimes=await picker().locator('.time-section').boundingBox();
 assert.ok(mobileTimes.x>=mobileCalendar.x+mobileCalendar.width);
 assert.ok(await picker().locator('.picker').evaluate(el=>el.scrollWidth<=el.clientWidth));
 await picker().getByRole('button',{name:'Apply',exact:true}).focus(); await page.keyboard.press('Tab');
 assert.equal(await picker().getByRole('button',{name:'Close picker',exact:true}).evaluate(e=>e===e.getRootNode().activeElement),true);
 await mkdir(new URL('../../../output/date-time-picker/',import.meta.url),{recursive:true});
 await page.screenshot({animations:'disabled',path:new URL('../../../output/date-time-picker/mobile.png',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
 await page.setViewportSize({width:1100,height:800});await page.waitForTimeout(50);{const inputBox=await page.locator('input').first().boundingBox(),popupBox=await picker().locator('.picker').boundingBox();assert.ok(popupBox.x>=inputBox.x+inputBox.width||popupBox.y>=inputBox.y+inputBox.height||popupBox.y+popupBox.height<=inputBox.y,'picker does not cover its trigger');}
 await page.screenshot({animations:'disabled',path:new URL('../../../output/date-time-picker/desktop.png',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
 assert.deepEqual(errors,[]);
 console.log('PASS mobile layout, focus loop, no browser errors');
 await setup('<main></main>');
 await page.evaluate(()=>{window.FirstMateEmbeddableApps={registerManifest(){},registerApp(){}};});
 const manifest=await readFile(new URL('../../libraries/apps/firstmate-apps-manifest.js',import.meta.url),'utf8');
 // Give relative bundle URLs a real script base, just as an embedded host does.
 await page.route('https://picker.test/firstmate-apps-manifest.js',route=>route.fulfill({contentType:'text/javascript',body:manifest}));
 await page.addScriptTag({url:'https://picker.test/firstmate-apps-manifest.js'});
 const coverage=await page.evaluate(()=>FirstMateAppsManifest.apps.map(app=>({id:app.id,picker:app.bundles[0]})));
 assert.ok(coverage.length>20);
 assert.ok(coverage.every(app=>app.picker.includes('/date-time-picker/date-time-picker.js')));
 console.log(`PASS shared dependency in all ${coverage.length} app manifests`);

} finally { await browser.close(); }
