import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright-core';

/* Placing and moving work shows its result at once (FM-454): while a job is
 * dragged, the items under it are previewed where they will follow it; the
 * release draws the job on its new day and ticks before the host saves; and a
 * host's own drag (the project Schedule tab's strip) previews the item and its
 * children with PlatformScheduleView.previewPlacement. */
const lib = (file) => readFile(new URL(`../../libraries/${file}`, import.meta.url), 'utf8');
const [scheduling, view] = await Promise.all([lib('platform-scheduling/platform-scheduling.js'), lib('platform-schedule-view/platform-schedule-view.js')]);

const JOB = { id: 'job', project_id: 'oak', title: 'Roof Installation', kind: 'schedule_group', type_id: 'project_work', status: 'scheduled', start_at: '2026-11-25T00:00:00.000Z', end_at: '2026-11-26T00:00:00.000Z', all_day: true, schedule_granularity: 'date' };
const DELIVERY = { id: 'delivery', project_id: 'oak', title: 'Default delivery', kind: 'material_delivery', type_id: 'material_delivery', resource_type: 'material', status: 'scheduled', parent_event_id: 'job', placement: { anchor: 'start', offset: { value: -2, unit: 'day' }, duration: { value: 1, unit: 'day' }, all_day: true }, start_at: '2026-11-23T00:00:00.000Z', end_at: '2026-11-24T00:00:00.000Z', all_day: true, schedule_granularity: 'date' };

async function open(browser) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 820 }, timezoneId: 'UTC' });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.route('http://localhost/**', (route) => route.fulfill({ body: '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;font-family:system-ui,sans-serif"><main id="app" style="padding:12px"><div id="cal" style="height:760px"></div></main></body></html>', contentType: 'text/html' }));
  await page.goto('http://localhost/');
  await page.evaluate(() => {
    window.ticks = [];
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (pattern) => { window.ticks.push({ pattern, at: performance.now() }); return true; } });
  });
  await page.addScriptTag({ content: scheduling });
  await page.addScriptTag({ content: view });
  await page.evaluate(({ events }) => {
    window.changes = [];
    window.PlatformScheduleView.renderProjectRangeScheduler(document.querySelector('#cal'), {
      mode: 'month', date: '2026-11-15T12:00:00.000Z', events, allowCreate: false, allowEdit: true, project: { id: 'oak' },
      onEventRangeChange(event, range) { window.changes.push({ id: event.id, start: new Date(range.start).toISOString(), at: performance.now(), ticks: window.ticks.length }); }
    });
  }, { events: [JOB, DELIVERY] });
  return { page, context };
}
const launch = () => chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const dayCenter = async (page, date) => {
  const box = await page.locator(`.prs-day[data-prs-date="${date}"]`).boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height * 0.7 };
};
const previewDays = (page) => page.$$eval('.live-preview', (nodes) => nodes.map((node) => ({ date: node.dataset.prsDate, text: node.textContent.replace(/\s+/g, ' ').trim() })));

test('dragging a job previews the delivery under it at its own offset, and the release is drawn and felt before the save', async () => {
  const browser = await launch();
  try {
    const { page } = await open(browser);
    const job = page.locator('.prs-work-chip[data-prs-event-id="job"]').first();
    const from = await job.boundingBox();
    const to = await dayCenter(page, '2026-11-18');
    await page.mouse.move(from.x + 10, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 30, from.y + from.height / 2 + 10, { steps: 3 });
    await page.mouse.move(to.x, to.y, { steps: 8 });
    const previews = await previewDays(page);
    assert.ok(previews.some((entry) => entry.date === '2026-11-18' && /Roof Installation/.test(entry.text)), `the job previews on its new day: ${JSON.stringify(previews)}`);
    assert.ok(previews.some((entry) => entry.date === '2026-11-16' && /Default delivery/.test(entry.text)), `the delivery previews two days before it: ${JSON.stringify(previews)}`);
    await page.mouse.up();
    assert.equal(await page.locator('.live-preview').count(), 0, 'previews go on release');
    const changes = await page.evaluate(() => window.changes);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].start.slice(0, 10), '2026-11-18');
    assert.equal(changes[0].ticks, 1, 'the tick comes with the release, before the host saves');
    assert.equal(await page.locator('.prs-day[data-prs-date="2026-11-18"]').count(), 1);
    const landed = await page.locator('.prs-work-chip[data-prs-event-id="job"]').first().evaluate((node) => node.closest('[data-prs-date]')?.dataset.prsDate || node.closest('.prs-month-bar')?.style.gridColumn || '');
    assert.ok(landed, 'the job is drawn where it landed');
  } finally {
    await browser.close();
  }
});

test('previewPlacement draws a host drag (the item, then what it brings) and clears it', async () => {
  const browser = await launch();
  try {
    const { page } = await open(browser);
    await page.evaluate(() => window.PlatformScheduleView.previewPlacement(document.querySelector('#cal'), [
      { id: 'job', title: 'Roof Installation', start: new Date('2026-11-11T00:00:00Z'), end: new Date('2026-11-12T00:00:00Z'), all_day: true },
      { id: 'delivery', title: 'Default delivery', start: '2026-11-09T00:00:00Z', end: '2026-11-10T00:00:00Z', all_day: true }
    ]));
    const previews = await previewDays(page);
    assert.deepEqual(previews.map((entry) => entry.date).sort(), ['2026-11-09', '2026-11-11']);
    assert.equal(await page.locator('.live-preview .prs-work-chip.preview').count(), 2, 'placement previews keep the dashed preview look');
    await page.evaluate(() => window.PlatformScheduleView.previewPlacement(document.querySelector('#cal'), []));
    assert.equal(await page.locator('.live-preview').count(), 0);
  } finally {
    await browser.close();
  }
});
