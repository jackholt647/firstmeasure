import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright-core';

/* Swiping the phone calendar follows the finger (FM-472): while a finger
 * moves sideways the day columns (Month: the weeks) move with it, the hour
 * gutter stays, and the next or previous period, with its own events, slides
 * in beside them. A release past about a third of the page, or a flick, turns
 * the page; anything less springs back. Vertical scrolling is untouched. */
const lib = (file) => readFile(new URL(`../../libraries/${file}`, import.meta.url), 'utf8');
const [scheduling, view] = await Promise.all([lib('platform-scheduling/platform-scheduling.js'), lib('platform-schedule-view/platform-schedule-view.js')]);

const EVENTS = [
  { id: 'today', title: 'Gutter repair', kind: 'appointment', status: 'scheduled', start_at: '2026-11-16T09:00:00.000Z', end_at: '2026-11-16T10:00:00.000Z', schedule_granularity: 'time' },
  { id: 'next', title: 'Roof inspection', kind: 'appointment', status: 'scheduled', start_at: '2026-11-19T09:00:00.000Z', end_at: '2026-11-19T11:00:00.000Z', schedule_granularity: 'time' },
  { id: 'prev', title: 'Siding quote', kind: 'appointment', status: 'scheduled', start_at: '2026-11-14T09:00:00.000Z', end_at: '2026-11-14T10:00:00.000Z', schedule_granularity: 'time' }
];

async function open(browser, mode = '4day') {
  const context = await browser.newContext({ viewport: { width: 433, height: 814 }, hasTouch: true, isMobile: true, timezoneId: 'UTC' });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.route('http://localhost/**', (route) => route.fulfill({ body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;font-family:system-ui,sans-serif"><div id="cal" style="height:700px"></div></body></html>', contentType: 'text/html' }));
  await page.goto('http://localhost/');
  await page.addScriptTag({ content: scheduling });
  await page.addScriptTag({ content: view });
  await page.evaluate(({ events, mode }) => {
    window.navigations = [];
    let date = new Date('2026-11-16T12:00:00.000Z');
    const render = () => window.PlatformScheduleView.renderProjectRangeScheduler(document.querySelector('#cal'), {
      mode, date, events, allowCreate: true, allowEdit: true, project: { id: 'oak' },
      showToolbar: false, mobileLayout: true, touchControls: true, touchHoldToPlace: true, shortRangeDayCount: 3,
      workStartMinute: 0, workEndMinute: 24 * 60, initialScrollMinute: 8 * 60, renderSlotMinutes: 60,
      onNavigate(next, delta, meta) {
        window.navigations.push({ date: new Date(next).toISOString().slice(0, 10), delta, meta });
        date = next;
        render();
      }
    });
    render();
  }, { events: EVENTS, mode });
  const cdp = await context.newCDPSession(page);
  return { page, cdp };
}
const launch = () => chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const touch = (cdp, type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Moves a finger from (x, y) by dx/dy in steps, waiting stepMs between them.
async function move(cdp, x, y, dx, dy, { steps = 12, stepMs = 16 } = {}) {
  await touch(cdp, 'touchStart', x, y);
  for (let index = 1; index <= steps; index += 1) {
    await touch(cdp, 'touchMove', x + (dx * index) / steps, y + (dy * index) / steps);
    await pause(stepMs);
  }
}
const dayHeads = (page, selector = '#cal > .prs-wrap') => page.$$eval(`${selector} .prs-day-head`, (nodes) => nodes.map((node) => node.querySelector('.prs-day-head-mobile strong')?.textContent.trim()));
const settled = (page) => page.waitForFunction(() => !document.querySelector('.prs-swiping, .prs-swipe-peek'), null, { timeout: 2000 });

test('a sideways finger drags the days with it and shows the next days, with their events, beside them', async () => {
  const browser = await launch();
  try {
    const { page, cdp } = await open(browser);
    const gutterBefore = await page.locator('#cal > .prs-wrap .prs-time-label').nth(9).boundingBox();
    const dayBefore = await page.locator('#cal > .prs-wrap .prs-day-head').first().boundingBox();
    await move(cdp, 250, 400, -100, 4);
    const dayDuring = await page.locator('#cal > .prs-wrap .prs-day-head').first().boundingBox();
    assert.ok(Math.abs(dayDuring.x - (dayBefore.x - 100)) < 2, `the days follow the finger: ${dayBefore.x} -> ${dayDuring.x}`);
    const gutterDuring = await page.locator('#cal > .prs-wrap .prs-time-label').nth(9).boundingBox();
    assert.ok(Math.abs(gutterDuring.x - gutterBefore.x) < 1, 'the hour gutter stays where it is');
    assert.deepEqual(await dayHeads(page, '.prs-swipe-peek'), ['19', '20', '21'], 'the next three days peek in');
    assert.equal(await page.locator('.prs-swipe-peek .prs-work-chip[data-prs-event-id="next"]').count(), 1, 'with their own events');
    const peekDay = await page.locator('.prs-swipe-peek .prs-day-head').first().boundingBox();
    assert.ok(Math.abs(peekDay.x - (dayBefore.x - 100 + 3 * dayBefore.width)) < 3, `the next days sit right after the current ones: ${peekDay.x}`);
    assert.deepEqual(await page.evaluate(() => window.navigations), [], 'nothing navigates before the finger lifts');
    // Back the other way: the previous days take the peek's place.
    for (let index = 1; index <= 10; index += 1) {
      await touch(cdp, 'touchMove', 150 + 24 * index, 404);
      await pause(16);
    }
    assert.deepEqual(await dayHeads(page, '.prs-swipe-peek:not([style*="visibility: hidden"])'), ['13', '14', '15'], 'the previous three days peek in from the left');
    await pause(150);
    await touch(cdp, 'touchEnd');
    await settled(page);
    assert.deepEqual(await page.evaluate(() => window.navigations.map(({ date, delta, meta }) => ({ date, delta, source: meta.source, tracked: meta.tracked }))), [{ date: '2026-11-13', delta: -1, source: 'swipe', tracked: true }]);
    assert.deepEqual(await dayHeads(page), ['13', '14', '15']);
  } finally {
    await browser.close();
  }
});

test('a short slow drag springs back and a quick flick turns the page', async () => {
  const browser = await launch();
  try {
    const { page, cdp } = await open(browser);
    const dayBefore = await page.locator('#cal > .prs-wrap .prs-day-head').first().boundingBox();
    await move(cdp, 300, 400, -70, 0);
    await pause(150);
    await touch(cdp, 'touchEnd');
    await settled(page);
    assert.deepEqual(await page.evaluate(() => window.navigations), [], 'a short slow drag does not turn the page');
    const dayAfter = await page.locator('#cal > .prs-wrap .prs-day-head').first().boundingBox();
    assert.ok(Math.abs(dayAfter.x - dayBefore.x) < 1, 'and springs back into place');
    assert.equal(await page.locator('.prs-slot.selected, .prs-work-chip.draft').count(), 0, 'the swipe is not a tap');

    await move(cdp, 300, 400, -60, 0, { steps: 4, stepMs: 12 });
    await touch(cdp, 'touchEnd');
    await settled(page);
    assert.deepEqual(await page.evaluate(() => window.navigations.map(({ date, delta }) => ({ date, delta }))), [{ date: '2026-11-19', delta: 1 }], 'a flick turns the page');
    assert.deepEqual(await dayHeads(page), ['19', '20', '21']);
  } finally {
    await browser.close();
  }
});

test('a downward finger still scrolls the hours, and the month swipes by whole months', async () => {
  const browser = await launch();
  try {
    let { page, cdp } = await open(browser);
    const before = await page.$eval('#cal .prs-surface', (node) => node.scrollTop);
    await move(cdp, 250, 300, 4, 150);
    assert.equal(await page.locator('.prs-swiping').count(), 0, 'a vertical drag does not swipe');
    await touch(cdp, 'touchEnd');
    const after = await page.$eval('#cal .prs-surface', (node) => node.scrollTop);
    assert.ok(before >= 140 && after <= before - 140, `the hours scrolled: ${before} -> ${after}`);
    await page.close();

    ({ page, cdp } = await open(browser, 'month'));
    await move(cdp, 380, 400, -220, 0);
    assert.equal(await page.locator('.prs-swipe-peek .prs-day[data-prs-date="2026-12-15"]').count(), 1, 'December peeks in');
    const head = await page.locator('#cal > .prs-wrap .prs-month-head').first().boundingBox();
    assert.ok(head.x < 2, 'the weekday row stays');
    await pause(150);
    await touch(cdp, 'touchEnd');
    await settled(page);
    assert.deepEqual(await page.evaluate(() => window.navigations.map(({ date, delta }) => ({ date, delta }))), [{ date: '2026-12-16', delta: 1 }]);
  } finally {
    await browser.close();
  }
});

/* GP-41: the page a swipe turned to is already drawn in the preview. The
 * render the host makes for it (into the same mount) goes in underneath, and
 * the preview stays on top until that render has painted, then fades out;
 * replacing everything at once flashed white on phones. */
test('a turned page keeps its painted preview over the new render until that render has painted', async () => {
  const browser = await launch();
  try {
    const { page, cdp } = await open(browser);
    await page.evaluate(() => {
      const cal = document.querySelector('#cal');
      window.handoff = [];
      new MutationObserver(() => {
        const peek = cal.querySelector(':scope > .prs-swipe-peek');
        if (!window.navigations.length || window.handoff.length) return;
        window.handoff.push({
          same: peek?.dataset.marked === '1',
          last: cal.lastElementChild === peek,
          heads: [...cal.querySelectorAll(':scope > .prs-wrap .prs-day-head-mobile strong')].map((node) => node.textContent.trim()),
          wraps: cal.querySelectorAll(':scope > .prs-wrap').length
        });
      }).observe(cal, { childList: true });
    });
    await move(cdp, 380, 400, -220, 0);
    await page.$eval('.prs-swipe-peek:not([style*="visibility: hidden"])', (node) => { node.dataset.marked = '1'; });
    await pause(150);
    await touch(cdp, 'touchEnd');
    await page.waitForFunction(() => window.navigations.length === 1);
    assert.deepEqual(await page.evaluate(() => window.handoff), [{ same: true, last: true, heads: ['19', '20', '21'], wraps: 1 }], 'the new days render under the same, already painted preview');
    assert.equal(await page.locator('#cal > .prs-swipe-peek[data-marked="1"]').count(), 1, 'which is still on screen right after the render');
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#cal > .prs-swipe-peek') || document.body).opacity) < 1, null, { timeout: 1000 });
    await settled(page);
    assert.equal(await page.$eval('#cal', (node) => node.style.position), '', 'the mount is left as it was');
    assert.deepEqual(await dayHeads(page), ['19', '20', '21']);

    // A touch while the preview is still up takes it away at once.
    await move(cdp, 380, 400, -220, 0);
    await pause(150);
    await touch(cdp, 'touchEnd');
    await page.waitForFunction(() => window.navigations.length === 2);
    assert.equal(await page.locator('#cal > .prs-swipe-peek').count(), 1);
    await touch(cdp, 'touchStart', 200, 300);
    assert.equal(await page.locator('#cal > .prs-swipe-peek').count(), 0);
    await touch(cdp, 'touchEnd');
    assert.deepEqual(await dayHeads(page), ['22', '23', '24']);
  } finally {
    await browser.close();
  }
});

test('the project Schedule tab keeps the calendar mount when a swipe turns the page', async () => {
  const panel = await lib('apps/project-schedule/panel.js');
  assert.match(panel, /onNavigate\(nextDate, delta, meta\)\{\s*scheduleAnchorDate = nextDate;\s*scheduleKeepCalendarMount = meta\?\.source === 'swipe';/, 'the home calendar marks a swipe');
  assert.match(panel, /replaceSchedulePanelHtml\(panel, `[\s\S]*?<div class="r-schedule-calendar work-calendar"><\/div>\s*`, scheduleKeepCalendarMount\);/, 'and redraws the panel around the kept mount');
});
