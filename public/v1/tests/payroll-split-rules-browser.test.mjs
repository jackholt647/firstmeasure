import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

// Split rules (docs/architecture/pay-rules.md "Split rules"). The Payroll settings editor writes one the way a pay rule
// is written, with the formula kept under Advanced, previews it against groups' recent earnings with the pay date each
// change lands on, saves versions and archives; Payroll's Why shows how a group's earning was divided and what share a
// member was paid, and People's Compensation links straight to it. Run with `--import tsx` so payloads are held against
// the server's schema. PAYROLL_UI_SHOTS=<dir> saves desktop and 390px screenshots.

const shotsDir = process.env.PAYROLL_UI_SHOTS;
const html = '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Arial;margin:0}#host{padding:16px}</style><div id="host"></div>';
async function open(browser, origin){
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(`${origin}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/libraries/')) return route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: await readFile(new URL('../../libraries/' + pathname.slice('/libraries/'.length), import.meta.url)) });
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  await page.addInitScript(() => {
    const RealDate = Date, fixed = new RealDate(2026, 5, 1, 12, 0, 0).getTime();
    window.Date = class extends RealDate { constructor(...values){ if (values.length) super(...values); else super(fixed); } static now(){ return fixed; } };
  });
  await page.goto(`${origin}/`);
  const shot = async (name, locator = null) => {
    if (!shotsDir) return;
    await mkdir(shotsDir, { recursive: true });
    for (const [suffix, width] of [['desktop', 1280], ['390', 390]]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(60);
      if (locator) await locator.screenshot({ path: path.join(shotsDir, `${name}-${suffix}.png`) });
      else await page.screenshot({ path: path.join(shotsDir, `${name}-${suffix}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 1000 });
  };
  return { page, errors, shot };
}

test('payroll settings write, preview, version and archive split rules with the formula under Advanced', async () => {
  const { CONDITION_OPERATORS } = await import('../work/conditions.ts');
  const { PAY_SCHEDULE_EARNING_KINDS, PAY_PARAMETER_TYPES, PAY_PERIODS, PAY_VOCABULARY_LABELS, paySplitRuleSaveSchema } = await import('../payroll/pay-rules.ts');
  const { SAMPLE_PAY_SPLIT_RULES } = await import('../payroll/sample-pay-rules.ts');
  const vocabulary = { operators: CONDITION_OPERATORS, parameter_types: PAY_PARAMETER_TYPES, earning_kinds: PAY_SCHEDULE_EARNING_KINDS.filter((kind) => kind !== '*' && kind !== 'clawback'), schedule_earning_kinds: PAY_SCHEDULE_EARNING_KINDS, periods: PAY_PERIODS, labels: PAY_VOCABULARY_LABELS };
  const byHours = SAMPLE_PAY_SPLIT_RULES.find((rule) => rule.id === 'by_hours_on_the_job');
  const split = { id: byHours.id, name: byHours.name, description: byHours.description, status: 'active', revision: 2, versions: [{ version: 'abc1234f00', effective_from: '2026-01-01', entered_at: '2026-01-02T10:00:00.000Z', entered_by: 'owner', definition: byHours.definition }] };
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const { page, errors, shot } = await open(browser, 'https://settings.test');
    await page.evaluate(({ split, vocabulary }) => {
      window.__APP = { userOrgId: 'org', userId: 'owner' };
      window.confirm = () => true;
      window.calls = [];
      window.toasts = [];
      const copy = (value) => JSON.parse(JSON.stringify(value));
      window.db = { splits: [split] };
      const sources = [
        { id: 'payroll.work_roster', provider: 'payroll', export: 'work_roster', description: 'Who was on each piece of scheduled work, one row per exact interval.', units: { seconds: 'seconds' }, needs_args: false, required_args: [], args: [], fields: ['assignee_key', 'project_id', 'event_id', 'from', 'until', 'seconds'] },
        { id: 'payroll.time_shifts', provider: 'payroll', export: 'time_shifts', description: 'One row per shift.', units: { worked_seconds: 'seconds' }, needs_args: false, required_args: [], args: ['projected'], fields: ['assignee_key', 'project_id', 'approval_status', 'clocked_in_at', 'clocked_out_at', 'worked_seconds'] }
      ];
      // A group divided by this rule: its latest earning, and the two members' shares under the edited rule.
      // A split rule reaches groups; what it moves is between their members, so the group's total does not change.
      const diff = (id, from, to, payDate) => ({ rule_id: 'install_pay', unit: 'p7', line: 'main', payee: `organization_user:${id}`, posted_cents: from, without_change_cents: from, target_cents: to, change_cents: to - from, handling: 'normal', pay_date: payDate, schedule_id: 'weekly', schedule_name: 'Weekly' });
      const preview = { payee_count: 1, changed_payee_count: 1, difference_count: 2, change_cents: 0, held_count: 0, unresolved_count: 0, truncated: false,
        payees: [
          { payee: { type: 'resource_group', id: 'north' }, payee_name: 'North Install', change_cents: 0, unresolved: [], differences: [diff('ana', 30000, 31500, '2026-06-05'), diff('ben', 30000, 28500, '2026-06-05')],
            samples: [{ rule_id: 'install_pay', unit: 'p7', earned_on: '2026-05-29', method: 'rule', members: ['ana', 'ben'], split_rule_id: 'by_hours_on_the_job', lines: { main: { amount_cents: 60000, total_weight: 36000, shares: [{ id: 'ana', weight: 18900, cents: 31500, reason: '5.25 approved hours on this job' }, { id: 'ben', weight: 17100, cents: 28500, reason: '4.75 approved hours on this job' }] } } }] }
        ] };
      window.PlatformAPI = { publication: { invoke: async () => ({ value: { roles: [], users: [], resource_groups: [], connections: [] } }) } };
      window.PayrollAPI = {
        schedules: { list: async () => ({ schedules: [] }), create: async () => ({}), update: async () => ({}), archive: async () => ({}) },
        published: { read: async (_org, name) => name === 'directory' ? { users: [{ id: 'ana', name: 'Ana Ames' }, { id: 'ben', name: 'Ben Bell' }], resource_groups: [], connections: [] } : {} },
        pay: {
          default: async () => ({ subject: { type: 'organization', id: 'org' }, revision: 1, entries: [], schedules: [] }),
          saveDefault: async () => ({}),
          ruleSources: async () => copy(sources),
          vocabulary: async () => copy(vocabulary),
          rules: async () => [], plans: async () => [],
          splitRules: async () => copy(db.splits),
          previewSplitRule: async (_org, rule) => { calls.push({ op: 'split.preview', payload: copy(rule) }); return copy(preview); },
          saveSplitRule: async (_org, rule) => {
            calls.push({ op: 'split.save', payload: copy(rule) });
            let item = db.splits.find((entry) => entry.id === rule.id);
            if (!item) { item = { id: rule.id || 'on_the_roster', versions: [], revision: 0 }; db.splits.push(item); }
            Object.assign(item, { name: rule.name, description: rule.description || '', status: 'active', revision: item.revision + 1 });
            item.versions = [...item.versions.filter((entry) => entry.effective_from !== rule.effective_from), { version: 'ffff0000aa', effective_from: rule.effective_from, entered_at: '2026-06-01T12:00:00.000Z', entered_by: 'owner', definition: rule.definition }];
            return copy(item);
          },
          archiveSplitRule: async (_org, id, revision) => { calls.push({ op: 'split.archive', id, revision }); db.splits.find((entry) => entry.id === id).status = 'archived'; return {}; }
        }
      };
    }, { split, vocabulary });
    await page.addScriptTag({ url: 'https://settings.test/libraries/apps/settings/payroll.js' });
    await page.evaluate(() => { window.settings = FirstMatePayrollSettings.mount(document.querySelector('#host'), { orgId: 'org', showToast: (...values) => toasts.push(values) }); });
    const lastCall = (op) => page.evaluate((name) => calls.filter((call) => call.op === name).at(-1), op);

    // The list: what the rule reads in words, its versions, and the formula only when Advanced is opened.
    await page.locator('[data-pay-section="pay"]').click();
    const card = page.locator('[data-pay-card="split:by_hours_on_the_job"]');
    await card.waitFor();
    await card.locator('> summary').click();
    const cardText = await card.innerText();
    for (const expected of ['payroll.time_shifts', 'about the member in assignee_key', 'project_id = $earning.project_id', 'from any time before', 'In effect since Jan 1, 2026'])
      assert.ok(cardText.includes(expected), `the card says ${expected}`);
    assert.equal(await card.locator('[data-split-code]').isVisible(), false, 'the formula is behind Advanced');
    await card.locator('.pycfg-advanced > summary').click();
    assert.match(await card.locator('[data-split-code]').innerText(), /approved hours on this job/);
    await shot('split-rules-list', page.locator('[data-pay-list="splits"]'));

    // Edit: the form is filled from the version, the formula stays folded away, and a parameter is added.
    await card.locator('[data-pay-edit]').click();
    const form = page.locator('[data-pay-form="split"]');
    await form.waitFor();
    assert.equal(await form.locator('[data-split="name"]').inputValue(), 'By hours on the job');
    assert.equal(await form.locator('[data-split-advanced]').evaluate((element) => element.open), false);
    assert.equal(await form.locator('[data-rule-input="0"] [data-in="member"]').inputValue(), 'assignee_key');
    assert.equal(await form.locator('[data-rule-input="0"] [data-m="token"]').inputValue(), '$earning.project_id');
    assert.equal(await form.locator('[data-rule-input="0"] [data-in="window_from"]').inputValue(), 'any');
    await form.locator('[data-rule-add-param]').click();
    await form.locator('[data-rule-param] [data-p="key"]').fill('minimum_minutes');
    await form.locator('[data-rule-param] [data-p="label"]').fill('Minutes before a shift counts');
    await form.locator('[data-rule-param] [data-p="default"]').fill('15');

    // Preview: who it reaches, the pay date each changed earning lands on, and how the group's latest earning divides.
    await form.locator('[data-pay-preview]').click();
    await form.locator('[data-split-sample="p7:main"]').waitFor();
    const previewText = await form.locator('[data-pay-preview-result]').innerText();
    assert.match(previewText, /North Install[\s\S]*Ana Ames, p7: 300\.00 to 315\.00, paid Jun 5, 2026 on Weekly · Ben Bell, p7: 300\.00 to 285\.00, paid Jun 5, 2026 on Weekly/);
    assert.match(previewText, /Earned May 29, 2026, 600\.00: Ana Ames 52\.5% \(315\.00\): 5\.25 approved hours on this job · Ben Bell 47\.5% \(285\.00\)/);
    assert.match(previewText, /2 earnings would come to a different amount for 1 payee: \+0\.00 in total/);
    const previewed = (await lastCall('split.preview')).payload;
    assert.equal(previewed.id, 'by_hours_on_the_job');
    assert.equal(previewed.expected_revision, 2);
    await shot('split-rule-editor', page.locator('[data-pay-form="split"]'));

    await form.locator('button[type="submit"]').click();
    await page.locator('[data-pay-list="splits"]').waitFor();
    const saved = (await lastCall('split.save')).payload;
    assert.deepEqual(saved.definition, { ...byHours.definition, parameters: { minimum_minutes: { label: 'Minutes before a shift counts', type: 'number', default: 15 } } });
    assert.equal(saved.effective_from, '2026-06-01');
    assert.equal(paySplitRuleSaveSchema.safeParse(saved).success, true, JSON.stringify(paySplitRuleSaveSchema.safeParse(saved).error?.issues));
    assert.match(await page.locator('[data-pay-card="split:by_hours_on_the_job"]').innerText(), /2 versions/);

    // A new split rule from the published roster: whom each row is about, rows on the earning's project, by time.
    await page.locator('[data-pay-new="split"]').click();
    const fresh = page.locator('[data-pay-form="split"]');
    assert.equal(await fresh.locator('[data-split-advanced]').evaluate((element) => element.open), true, 'a new rule shows its starting formula');
    await fresh.locator('[data-split="name"]').fill('On the roster');
    await fresh.locator('button[type="submit"]').click();
    await page.locator('[data-pay-list="splits"]').waitFor();
    const equal = (await lastCall('split.save')).payload;
    assert.deepEqual(equal.definition.inputs, {});
    assert.match(equal.definition.code, /members\.map/);
    await page.locator('[data-pay-card="split:on_the_roster"] [data-pay-edit]').click();
    await fresh.locator('[data-rule-add-input]').click();
    await fresh.locator('[data-rule-input="0"] [data-in="name"]').fill('roster');
    await fresh.locator('[data-rule-input="0"] [data-in="source"]').selectOption('payroll.work_roster');
    await fresh.locator('[data-rule-input="0"] [data-in="member"]').fill('assignee_key');
    await fresh.locator('[data-rule-input="0"] [data-in-add-match]').click();
    await fresh.locator('[data-rule-input="0"] [data-m="field"]').fill('project_id');
    await fresh.locator('[data-rule-input="0"] [data-in="window_on"]').check();
    await fresh.locator('[data-rule-input="0"] [data-in="window_start"]').fill('from');
    await fresh.locator('[data-rule-input="0"] [data-in="window_end"]').fill('until');
    await fresh.locator('[data-rule-input="0"] [data-in="window_from"]').selectOption('days');
    await fresh.locator('button[type="submit"]').click();
    assert.match(await fresh.locator('[data-form-status]').innerText(), /say how many days before/);
    await fresh.locator('[data-rule-input="0"] [data-in="window_days"]').fill('2');
    await fresh.locator('button[type="submit"]').click();
    await page.locator('[data-pay-list="splits"]').waitFor();
    const roster = (await lastCall('split.save')).payload;
    assert.deepEqual(roster.definition.inputs, { roster: { source: { provider: 'payroll', export: 'work_roster' }, member: 'assignee_key', match: { project_id: '$earning.project_id' }, window: { start: 'from', end: 'until', days_before: 2 } } });
    assert.equal(roster.expected_revision, 1);
    assert.equal(paySplitRuleSaveSchema.safeParse(roster).success, true, JSON.stringify(paySplitRuleSaveSchema.safeParse(roster).error?.issues));

    // Archive: no longer offered to groups; the card says so.
    await page.locator('[data-pay-card="split:on_the_roster"] [data-pay-archive]').click();
    await page.locator('[data-pay-card="split:on_the_roster"] .pycfg-pill.off').waitFor();
    assert.deepEqual(await lastCall('split.archive'), { op: 'split.archive', id: 'on_the_roster', revision: 2 });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Why shows how a group earning was divided and a member’s shares, and opens from a route', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const { page, errors, shot } = await open(browser, 'https://payroll.test');
    await page.evaluate(() => {
      window.__APP = { userOrgId: 'org', userId: 'manager' };
      window.FirstMateEmbeddableApps = { registerApp: () => {} };
      window.AppChrome = { registerGroup: () => {}, resolve: (_app, view) => view || 'payees', header: (o) => `<header><h2>${o.title}</h2></header>`, tabs: () => '', settings: () => '' };
      window.Portal = { currentUser: { id: 'manager', permissions: { manage_payroll: true } }, ui: { showToast: () => {} } };
      // The route a link from People › Compensation sets: the payee and the Divided tab.
      window.route = { tab: 'payroll', payrollView: 'payees', payrollWhy: 'resource_group:north', payrollWhyTab: 'divided' };
      window.handlers = {};
      window.Portal.navigation = { read: () => window.route, registerHandler: (id, handler) => { handlers[id] = handler; return () => delete handlers[id]; }, navigate: () => {}, push: () => {} };
      const ana = { type: 'organization_user', id: 'ana', name: 'Ana Ames' };
      const split = { method: 'rule', members: ['ana', 'ben'], split_rule_id: 'by_hours_on_the_job', split_rule_version: 'abc1234f00', params: { minimum_minutes: 15 },
        lines: { main: { amount_cents: 60000, total_weight: 36000, shares: [{ id: 'ana', weight: 18900, cents: 31500, reason: '5.25 approved hours on this job' }, { id: 'ben', weight: 17100, cents: 28500, reason: '4.75 approved hours on this job' }] } } };
      window.units = { 'resource_group:north': [{ id: 'install_pay:p7', rule_id: 'install_pay', unit: 'p7', status: 'ok', earned_at: '2026-05-29T12:00:00.000Z', lines: [{ key: 'main', amount_cents: 60000, description: 'Install, Jones roof' }], split_among: [{ id: 'ana', weight: 1 }, { id: 'ben', weight: 1 }], split }] };
      window.ledger = [{ id: 'l1', payee: ana, kind: 'commission', state: 'accrued', amount_cents: 31500, applied_cents: 0, remaining_cents: 31500, created_at: '2026-05-30T09:00:00.000Z', description: 'Install, Jones roof',
        metadata: { source: 'pay_rule', pay_rule: { payee: 'resource_group:north', rule_id: 'install_pay', unit: 'p7', line: 'main', earned_on: '2026-05-29' }, split: { of: 'resource_group:north', line_cents: 60000, members: 2, method: 'rule', split_rule_id: 'by_hours_on_the_job', weight: 18900, total_weight: 36000, share_cents: 31500, reason: '5.25 approved hours on this job' } } }];
      const directory = { users: [{ id: 'ana', name: 'Ana Ames' }, { id: 'ben', name: 'Ben Bell' }], resource_groups: [{ id: 'north', name: 'North Install' }], connections: [] };
      window.PlatformAPI = { publication: {
        read: async (_org, source) => ({ status: 'ready', value: JSON.parse(JSON.stringify(
          source.export === 'pay_units' ? units[source.target.id] || [] : source.export === 'pay_rules' ? [{ id: 'install_pay', name: 'Install pay', versions: [] }]
            : source.export === 'pay_split_rules' ? [{ id: 'by_hours_on_the_job', name: 'By hours on the job', versions: [] }] : source.export === 'directory' ? directory
              : source.export === 'pay_setup' ? { effective: [], schedule_today: [], distribution_today: { mode: 'split', method: 'rule' } } : source.export === 'pay_rule_vocabulary' ? {} : [])) }),
        invoke: async (_org, action, _target, input) => {
          let value = {};
          if (action === 'payroll.dashboard.read') value = { schedules: [], diagnostics: [], history: [], upcoming: [] };
          else if (action === 'payroll.ledger.list') value = ledger.filter((row) => !input.payee_id || row.payee.id === input.payee_id);
          else if (action === 'payroll.earnings.read') value = { earnings: [{ currency: 'USD', totals: {}, payments: [], off_cycle_payments: [] }] };
          else if (action === 'payroll.directory.read' || action.endsWith('directory')) value = directory;
          return { receipt: { status: 'succeeded' }, value: JSON.parse(JSON.stringify(value)) };
        } } };
    });
    for (const script of ['apps/people/people-kit.js', 'apps/people/entity-modal.js', 'payroll-api/payroll-api.js', 'apps/payroll/app.js']) await page.addScriptTag({ url: 'https://payroll.test/libraries/' + script });
    // Opening the Earnings view with the route opens the group's Why on how its pay was divided.
    await page.evaluate(() => { window.view = FirstMatePayroll.mountView({ root: document.querySelector('#host'), orgId: 'org', params: { standalone: 'payees' } }); });
    const why = page.locator('.pp-modal');
    const divided = why.locator('[data-modal-panel="divided"]');
    await divided.locator('[data-divided-unit="install_pay:p7"]').waitFor();
    assert.match(await why.innerText(), /North Install/);
    const groupText = await divided.innerText();
    for (const expected of ['Install pay', 'Divided by the split rule By hours on the job', 'minimum minutes: 15', 'Install, Jones roof', '$600.00', 'Ana Ames', '52.5%', '$315.00', '5.25 approved hours on this job', 'Ben Bell', '47.5%', '$285.00'])
      assert.ok(groupText.includes(expected), `the division shows ${expected}`);
    await shot('why-divided-group', why);
    await page.keyboard.press('Escape');
    await why.waitFor({ state: 'detached' });

    // The same route again does not reopen it; a route naming a member opens what share they were paid.
    await page.evaluate(() => { for (const handler of Object.values(handlers)) handler.apply(window.route); });
    assert.equal(await why.count(), 0);
    await page.evaluate(() => { window.route = { tab: 'payroll', payrollView: 'payees', payrollWhy: 'organization_user:ana', payrollWhyTab: 'divided' }; for (const handler of Object.values(handlers)) handler.apply(window.route); });
    await divided.locator('[data-divided-entry="l1"]').waitFor();
    const memberText = await divided.innerText();
    for (const expected of ['Shares of group earnings', 'Install, Jones roof', 'of $600.00', 'North Install', '18900 / 36000', '$315.00', '5.25 approved hours on this job'])
      assert.ok(memberText.includes(expected), `the member's shares show ${expected}`);
    await shot('why-divided-member', why);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
