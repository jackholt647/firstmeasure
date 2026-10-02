import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {chromium} from 'playwright-core';

const picker = await readFile(new URL('../../libraries/appointment-booking/availability.js', import.meta.url), 'utf8');
const booking = await readFile(new URL('../../libraries/appointment-booking/booking.js', import.meta.url), 'utf8');
const embed = await readFile(new URL('../../libraries/lead-embed/firstmate-lead-embed.js', import.meta.url), 'utf8');
test('shared picker rejects stale responses, books once, and public embeds retain their calendar styling', async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1100,height:850}});
    await page.route('http://localhost/**', route => route.fulfill({body:'<html><body></body></html>',contentType:'text/html'}));
    await page.goto('http://localhost/');
    page.setDefaultTimeout(5000);
    await page.setContent('<button id="opener">Open</button><div id="public"></div>');
    await page.addScriptTag({content:picker});
    await page.addScriptTag({content:booking});
    await page.evaluate(() => {
      window.__APP = {userOrgId:'org'}; window.bookings = []; window.pending = [];
      window.PlatformAPI = {
        projects:{list:async () => ({documents:[{id:'project',data:{title:'Test project'}}]})},
        appointments:{availability:() => new Promise(resolve => window.pending.push(resolve)), book:async (_org, input) => { window.bookings.push(input); }}
      };
      document.querySelector('#opener').focus();
      return window.FirstMateBooking.open();
    });
    await page.locator('[data-project]').selectOption('project');
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
