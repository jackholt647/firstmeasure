import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright-core';

/* Faces and the warning badge on schedule events, and the placement preview's
 * warnings, as the project schedule panel and the Scheduling app draw them
 * (both render through PlatformScheduleView). The roster itself comes from the
 * server's schedule-roster.events export, stubbed here with its shape.
 * docs/architecture/schedule-events.md, "Roster and warnings". */
const lib = (file) => readFile(new URL(`../../libraries/${file}`, import.meta.url), 'utf8');
const [scheduling, view, panel, app] = await Promise.all([lib('platform-scheduling/platform-scheduling.js'), lib('platform-schedule-view/platform-schedule-view.js'), lib('apps/project-schedule/panel.js'), lib('apps/scheduling/app.js')]);
const out = new URL('../../../output/roster-ui/', import.meta.url);
await mkdir(out, { recursive: true });
const shot = (name) => new URL(name, out).pathname.replace(/^\/([A-Za-z]:)/, '$1');
function fn(source, name) {
  const start = source.search(new RegExp(`\\n  (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start + 1) + 4);
}

const person = (id, name) => ({ id: `organization_user:${id}`, user_id: id, name, via: ['resource_group:crew_a'], whole_window: true, present: [] });
const ROSTER = {
  event_id: 'roof', project_id: 'oak', parent_event_id: '', draft: false, window: { from: '2026-10-20T08:00:00.000Z', until: '2026-10-20T17:00:00.000Z' }, error: '',
  roster: { people: [person('ana', 'Ana Ortiz'), person('ben', 'Ben Lee'), { ...person('cy', 'Cy Park'), via: ['resource_group:crew_a', 'resource_group:crew_b'] }, person('eve', 'Eve Stone')], parties: [], absent: [], count: 4, party_count: 0, min_count: 3, max_count: 4, days: [{ date: '2026-10-20', person_ids: ['organization_user:ana', 'organization_user:ben', 'organization_user:cy', 'organization_user:eve'], party_ids: [] }] },
  staffing_requirements: [], assignee_conflicts: [],
  warnings: [
    { id: 'w1', kind: 'staffing_requirement_unmet', mode: 'warn', accepted: false, intervals: [], message: 'Crew A and Crew B are assigned, but the only CDL driver (Ana Ortiz) is off 8:00 AM-12:00 PM on Oct 20.' },
    { id: 'w2', kind: 'double_booked', mode: 'warn', accepted: false, intervals: [], person_id: 'organization_user:eve', message: 'Eve Stone is also on Gutters 1:00 PM-3:00 PM on Oct 20.' },
    { id: 'w3', kind: 'assignee_overlap', mode: 'warn', accepted: false, intervals: [], assignee_id: 'resource_group:crew_a', message: 'Crew A is also on Inspection 3:00 PM-4:00 PM on Oct 20.' }
  ]
};
const QUIET = { ...ROSTER, event_id: 'gutters', project_id: 'elm', warnings: [], roster: { ...ROSTER.roster, people: [person('dan', 'Dan Fox')], count: 1, min_count: 1, max_count: 1, days: [] } };
const PREVIEW = { ...ROSTER, draft: true, window: { from: '2026-10-22T08:00:00.000Z', until: '2026-10-22T17:00:00.000Z' }, warnings: [{ id: 'p1', kind: 'staffing_requirement_unmet', mode: 'warn', accepted: false, intervals: [], message: 'Crew A is assigned, but no foreman is on the work 8:00 AM-5:00 PM on Oct 22.' }] };

const crew = (id, name) => ({ kind: 'resource_group', id, name, role: 'crew' });
const EVENTS = [
  { id: 'roof', project_id: 'oak', project_title: '12 Oak St', title: 'Roof replacement', type_id: 'project_work', status: 'scheduled', start_at: '2026-10-20T08:00:00.000Z', end_at: '2026-10-20T17:00:00.000Z', all_day: false, schedule_granularity: 'time', resource_refs: [crew('crew_a', 'Crew A'), crew('crew_b', 'Crew B')] },
  { id: 'gutters', project_id: 'elm', project_title: '9 Elm St', title: 'Gutters', type_id: 'project_work', status: 'scheduled', start_at: '2026-10-21T13:00:00.000Z', end_at: '2026-10-21T15:00:00.000Z', all_day: false, schedule_granularity: 'time', resource_refs: [{ kind: 'organization_user', id: 'dan', name: 'Dan Fox', role: 'crew' }] },
  { id: 'span', project_id: 'oak', title: 'Unassigned span', type_id: 'project_work', status: 'scheduled', start_at: '2026-10-23T08:00:00.000Z', end_at: '2026-10-23T12:00:00.000Z', all_day: false, schedule_granularity: 'time', resource_refs: [] }
];

async function open(browser, width = 1100, height = 760) {
  const context = await browser.newContext({ viewport: { width, height }, timezoneId: 'UTC' });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.route('http://localhost/**', (route) => route.fulfill({ body: '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;font-family:system-ui,sans-serif"><main id="app" style="padding:12px"></main></body></html>', contentType: 'text/html' }));
  await page.goto('http://localhost/');
  await page.addStyleTag({ content: '.fas{display:inline-block;width:10px;height:10px;border-radius:2px;background:currentColor}' });
  await page.evaluate(({ roster, quiet, preview }) => {
    window.Portal = { cfg: { orgId: 'org_1' } };
    window.reads = [];
    window.PlatformAPI = { publication: { read: async (orgId, source) => {
      window.reads.push({ orgId, source: JSON.parse(JSON.stringify(source)) });
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (source.args?.draft) return { status: 'ready', value: { timezone: 'UTC', overlap_mode: 'warn', events: [{ ...preview, event_id: source.args.draft.event.id, project_id: source.args.draft.project_id || '' }] } };
      const byId = { roof: roster, gutters: quiet };
      return { status: 'ready', value: { timezone: 'UTC', overlap_mode: 'warn', events: (source.args?.events || []).map((entry) => byId[entry.event_id]).filter(Boolean) } };
    } } };
  }, { roster: ROSTER, quiet: QUIET, preview: PREVIEW });
  await page.addScriptTag({ content: scheduling });
  await page.addScriptTag({ content: view });
  return { page, context };
}
const launch = () => chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });

test('each event shows its people as faces with a count and one warning badge whose tooltip lists the warnings', async () => {
  const browser = await launch();
  try {
    const { page } = await open(browser);
    for (const mode of ['week', 'month']) {
      await page.evaluate(({ events, mode }) => {
        document.querySelector('#app').innerHTML = '<div id="cal" style="height:680px"></div>';
        window.PlatformScheduleView.renderProjectRangeScheduler(document.querySelector('#cal'), { mode, date: '2026-10-20T12:00:00.000Z', events, allowCreate: false, allowEdit: true });
      }, { events: EVENTS, mode });
      const roof = page.locator('.prs-work-chip[data-prs-event-id="roof"]').first();
      await roof.locator('.prs-roster-faces').waitFor();
      assert.equal(await roof.locator('.prs-roster-count').textContent(), '4', 'a person in two groups is one face');
      assert.equal(await roof.locator('.prs-roster-face').count(), 3, 'three faces, then the count');
      assert.match(await roof.locator('.prs-roster-faces').getAttribute('title'), /On this event: Ana Ortiz, Ben Lee, Cy Park, Eve Stone/);
      const badge = roof.locator('.prs-roster-warning');
      assert.equal(await badge.getAttribute('data-prs-roster-warnings'), '3');
      const tip = await badge.getAttribute('title');
      assert.match(tip, /^3 warnings\n/);
      assert.match(tip, /only CDL driver \(Ana Ortiz\) is off/);
      assert.match(tip, /Eve Stone is also on Gutters/);
      assert.match(tip, /Crew A is also on Inspection/);
      assert.doesNotMatch(await roof.locator('.prs-title').innerText(), /CDL|Gutters|Inspection/, 'only the title is on the chip; details are in the tooltip');
      const quiet = page.locator('.prs-work-chip[data-prs-event-id="gutters"]').first();
      await quiet.locator('.prs-roster-faces').waitFor();
      assert.equal(await quiet.locator('.prs-roster-warning').count(), 0, 'no warnings, no badge');
      assert.equal(await page.locator('.prs-work-chip[data-prs-event-id="span"] .prs-roster').count(), 0, 'an event with no assignee asks nothing');
      await page.screenshot({ path: shot(`range-${mode}.png`) });
      // The title stays readable: a timed chip puts the faces on their own line; a one-line chip shows the count and the badge icon only.
      const titleWidth = await roof.locator('.prs-title-text').evaluate((node) => node.getBoundingClientRect().width);
      assert.ok(titleWidth > (mode === 'week' ? 60 : 24), `title keeps room in ${mode} (${titleWidth}px)`);
      assert.equal(await roof.locator('.prs-roster-face').first().isVisible(), mode === 'week');
    }
    const reads = await page.evaluate(() => window.reads);
    assert.ok(reads.length >= 1);
    assert.deepEqual(reads[0].source.provider + '.' + reads[0].source.export, 'schedule-roster.events');
    assert.deepEqual(reads[0].source.args.events.map((entry) => `${entry.project_id}:${entry.event_id}`).sort(), ['elm:gutters', 'oak:roof'], 'one read for the events on screen, each by its project');
    // Nothing derived lands on the events the host holds.
    assert.equal(EVENTS.some((event) => 'roster' in event || 'warnings' in event), false);
    // Hover shows the tooltip text through the platform's tooltip (native title here).
    await page.locator('.prs-work-chip[data-prs-event-id="roof"] .prs-roster-warning').first().hover();
  } finally { await browser.close(); }
});

test('the timeline bar carries the same faces and badge', async () => {
  const browser = await launch();
  try {
    const { page } = await open(browser, 1100, 420);
    await page.evaluate(({ events }) => {
      document.querySelector('#app').innerHTML = '<div id="gantt" style="height:360px"></div>';
      window.PlatformScheduleView.renderGanttScheduler(document.querySelector('#gantt'), { events, date: '2026-10-20T12:00:00.000Z', readOnly: true, stateKey: 'roster-test' });
      const api = window.PlatformScheduleView.ganttControls(document.querySelector('#gantt'));
      api?.setZoom?.(260);
    }, { events: EVENTS });
    await page.locator('[data-psv-gantt-bar="roof"] .prs-roster-faces').waitFor();
    assert.equal(await page.locator('[data-psv-gantt-bar="roof"] .prs-roster-count').textContent(), '4');
    assert.equal(await page.locator('[data-psv-gantt-bar="roof"] .prs-roster-warning').getAttribute('data-prs-roster-warnings'), '3');
    await page.locator('[data-psv-gantt-bar="roof"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: shot('timeline.png') });
  } finally { await browser.close(); }
});

test('while placing, the draft and both hosts\' placement banners show the warnings the save would find, without blocking', async () => {
  const browser = await launch();
  try {
    const { page } = await open(browser, 1100, 760);
    const css = app.slice(app.indexOf('  const css = `') + '  const css = `'.length, app.indexOf('  `;', app.indexOf('  const css = `')));
    await page.addStyleTag({ content: css });
    // The project schedule panel's banner line, with its real helper.
    await page.addScriptTag({ content: `(function(){ const activeBaseProject = { id:'oak' }; const workScheduleModeActive = true; const scheduleOrgId = () => 'org_1';
      const activeWorkDraft = () => window.panelDraft;
      ${fn(panel, 'schedulePlacementRosterHtml')}
      window.panelRosterLine = schedulePlacementRosterHtml; })();` });
    // The Scheduling app's banner line, with its real helpers.
    await page.addScriptTag({ content: `(function(){ const clean = (value) => String(value ?? '').trim();
      const scheduleBundleDrafts = () => [window.appDraft]; const selectedScheduleEvent = () => null; const appointmentScheduleDraft = null; const salesDraftAssignment = () => ({});
      ${fn(app, 'placementRosterDraft')}
      ${fn(app, 'placementRosterSlotHtml')}
      window.appRosterLine = placementRosterSlotHtml; })();` });
    await page.evaluate(({ events }) => {
      const roof = events[0];
      const draft = { ...roof, id: 'roof', event_id: 'roof', start: '2026-10-22T08:00:00.000Z', end: '2026-10-22T17:00:00.000Z' };
      window.panelDraft = { ...draft, __roster_project_id: 'oak' };
      window.appDraft = { ...draft };
      document.querySelector('#app').innerHTML = `
        <div class="dash-schedule-card" style="position:relative;padding-bottom:8px">
          <div class="dash-placement-banner" data-placement-banner role="status" style="position:static"><i class="fas fa-location-crosshairs"></i><span><strong>Roof replacement</strong> is placed as a draft on Thu, Oct 22. Drag it to adjust, then click ✓ on it to save.</span>${window.appRosterLine({ kind: 'production', start: draft.start })}<button type="button" class="dash-placement-cancel">Cancel</button></div>
        </div>
        <div class="r-schedule-placement-banner" id="panelBanner" role="status" style="margin:10px 0;padding:8px 12px;border:1px solid #fde68a;background:#fffbeb;border-radius:10px;display:flex;gap:10px;align-items:center"><span><strong>Placing Roof replacement</strong> — Thu, Oct 22. Confirm it with ✓, or place it somewhere else.</span>${window.panelRosterLine()}</div>
        <div id="cal" style="height:520px"></div>`;
      window.PlatformScheduleView.renderProjectRangeScheduler(document.querySelector('#cal'), { mode: 'week', date: '2026-10-22T12:00:00.000Z', events: events.filter((event) => event.id !== 'roof'), drafts: [window.panelDraft], activeDraftId: 'roof', allowCreate: true, allowEdit: true });
    }, { events: EVENTS });
    const appLine = page.locator('[data-placement-banner] .prs-roster-preview');
    await appLine.locator('.prs-roster-preview-text').waitFor();
    assert.match(await appLine.locator('.prs-roster-preview-text').textContent(), /no foreman is on the work/);
    const panelLine = page.locator('#panelBanner .prs-roster-preview');
    await panelLine.locator('.prs-roster-preview-text').waitFor();
    assert.match(await panelLine.locator('.prs-roster-preview-text').textContent(), /no foreman is on the work/);
    const draftChip = page.locator('.prs-work-chip.draft').first();
    await draftChip.locator('.prs-roster-warning').waitFor();
    assert.equal(await draftChip.locator('.prs-roster-count').textContent(), '4');
    const drafts = (await page.evaluate(() => window.reads)).filter((read) => read.source.args.draft);
    assert.ok(drafts.length >= 1);
    assert.deepEqual(drafts.map((read) => [read.source.args.draft.project_id, read.source.args.draft.event.id, read.source.args.draft.event.start_at]).filter((value, index, list) => list.findIndex((other) => other.join() === value.join()) === index), [['oak', 'roof', '2026-10-22T08:00:00.000Z']], 'the draft is read once, against its project, at the range being placed');
    assert.equal(drafts.every((read) => !('roster' in read.source.args.draft.event)), true);
    // The confirm control stays available: warnings never block the save.
    assert.equal(await page.locator('.dash-placement-cancel').isEnabled(), true);
    await page.screenshot({ path: shot('placement-preview.png') });
  } finally { await browser.close(); }
});

test('faces and badge fit a phone-width calendar', async () => {
  const browser = await launch();
  try {
    const { page } = await open(browser, 390, 760);
    await page.evaluate(({ events }) => {
      document.querySelector('#app').innerHTML = '<div id="cal" style="height:680px"></div>';
      window.PlatformScheduleView.renderProjectRangeScheduler(document.querySelector('#cal'), { mode: 'day', date: '2026-10-20T12:00:00.000Z', events, allowCreate: false, allowEdit: true });
    }, { events: EVENTS });
    const roof = page.locator('.prs-work-chip[data-prs-event-id="roof"]').first();
    await roof.locator('.prs-roster-faces').waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll');
    await page.screenshot({ path: shot('phone-day.png') });
  } finally { await browser.close(); }
});
