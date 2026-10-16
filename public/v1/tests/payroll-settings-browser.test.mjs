import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

// Mounts the Payroll settings page against a stubbed PayrollAPI with the clock held at 2026-06-01, and checks what
// the schedule editor, the company's schedule choice and the pay plan and pay rule editors send. Run with `--import tsx` so the payloads can be
// held against the server's own schemas and the client's pay-date preview against payrollPayDates.

const estimatorRule = {
  id: 'estimator_commission_sold', name: 'Estimator commission when sold', description: 'A share of the contract.', status: 'active', revision: 3,
  versions: [{ version: 'abcdef0123456789', effective_from: '2026-01-01', entered_at: '2026-01-02T10:00:00.000Z', entered_by: 'owner', entered_by_name: 'Olive Owner', definition: {
    grain: 'record', week_starts: 1, always: false, kind: 'commission', earned_at: 'sold_at', project: 'id',
    inputs: { projects: { primary: true, source: { provider: 'payroll', export: 'project_records', args: { facts: true } }, where: { rules: [{ field: 'assignee_keys.assignments.estimator', operator: 'contains', value: '$payee.key' }, { field: 'canceled_at', operator: 'is_missing' }] } } },
    parameters: { rate_bps: { label: 'Share of contract (basis points)', default: 500 } },
    code: 'return Math.round(unit.record.contract_cents * params.rate_bps / 10000);'
  } }]
};
const hourlyRule = {
  id: 'hourly_time_clock', name: 'Hourly from the time clock', description: 'Approved hours each week.', status: 'active', revision: 1,
  versions: [{ version: '1234567890abcdef', effective_from: '2026-01-01', entered_at: '2026-01-02T10:00:00.000Z', entered_by: 'owner', definition: {
    grain: 'period', period: 'week', week_starts: 1, always: false, kind: 'hourly',
    inputs: { shifts: { source: { provider: 'payroll', export: 'time_shifts' }, date: 'clocked_out_at', where: { rules: [{ field: 'assignee_key', operator: 'equals', value: '$payee.key' }, { field: 'approval_status', operator: 'equals', value: 'approved' }] } } },
    parameters: { rate_cents: { label: 'Hourly rate', type: 'cents' }, overtime_after_hours: { label: 'Weekly hours before overtime', default: 40 } },
    code: 'return Math.round(unit.rows.shifts.length * params.rate_cents);'
  } }]
};

function sampleRecurrences() {
  let seed = 20261013;
  const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const int = (min, max) => min + Math.floor(random() * (max - min + 1));
  const some = (min, max, count) => [...new Set(Array.from({ length: count }, () => int(min, max)))].filter((value) => value !== 0);
  const list = [];
  for (let index = 0; index < 400; index += 1) {
    const frequency = ['daily', 'weekly', 'biweekly', 'semi_monthly', 'monthly', 'quarterly', 'yearly'][index % 7];
    const recurrence = { frequency };
    if (random() < 0.5) recurrence.interval = int(1, 5);
    if (random() < 0.7 || frequency === 'biweekly' || (recurrence.interval || 1) > 1) recurrence.anchor_date = `202${int(4, 7)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`;
    if (frequency === 'weekly' || frequency === 'biweekly') { if (random() < 0.5) recurrence.weekday = int(0, 6); else recurrence.weekdays = some(0, 6, int(1, 3)).concat(random() < 0.2 ? [0] : []); }
    if (!['daily', 'weekly', 'biweekly'].includes(frequency)) {
      const shape = int(0, 3);
      if (shape === 0) recurrence.day = [int(1, 31), -int(1, 31)][int(0, 1)];
      if (shape === 1 || shape === 3 || frequency === 'semi_monthly') recurrence.days = some(-31, 31, int(1, 3));
      if (shape === 2 || shape === 3) recurrence.nth_weekdays = Array.from({ length: int(1, 2) }, () => ({ nth: [1, 2, 3, 4, 5, -1, -2, -5][int(0, 7)], weekday: int(0, 6) }));
      if (frequency === 'semi_monthly' && !recurrence.days.length) recurrence.days = [1, 15];
    }
    if (random() < 0.35) recurrence.months = some(1, 12, int(1, 4));
    if (random() < 0.6) recurrence.adjust = ['none', 'previous_weekday', 'next_weekday'][int(0, 2)];
    list.push(recurrence);
  }
  return list;
}

test('payroll settings build any pay cadence, choose when the company pays, and edit and preview pay plans and pay rules', async () => {
  const { CONDITION_OPERATORS } = await import('../work/conditions.ts');
  const { PAY_SCHEDULE_EARNING_KINDS, PAY_PARAMETER_TYPES, PAY_PERIODS, PAY_VOCABULARY_LABELS } = await import('../payroll/pay-rules.ts');
  // What payroll.pay_rule_vocabulary publishes (payroll/pay-rule-publication.ts).
  const vocabulary = { parameter_types: PAY_PARAMETER_TYPES, earning_kinds: PAY_SCHEDULE_EARNING_KINDS.filter((kind) => kind !== '*' && kind !== 'clawback'), schedule_earning_kinds: PAY_SCHEDULE_EARNING_KINDS, periods: PAY_PERIODS, labels: PAY_VOCABULARY_LABELS };
  const { payrollPayDates } = await import('../payroll/schedule.ts');
  const { payrollScheduleInputSchema, payrollRecurrenceSchema } = await import('../payroll/schemas.ts');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('https://settings.test/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.startsWith('/libraries/')) return route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: await readFile(new URL('../../libraries/' + pathname.slice('/libraries/'.length), import.meta.url)) });
      return route.fulfill({ contentType: 'text/html', body: '<meta charset="utf-8"><style>body{font-family:Arial;margin:20px}</style><div id="host"></div>' });
    });
    await page.addInitScript(() => {
      const RealDate = Date;
      const fixed = new RealDate(2026, 5, 1, 12, 0, 0).getTime();
      window.Date = class extends RealDate {
        constructor(...values) { if (values.length) super(...values); else super(fixed); }
        static now() { return fixed; }
      };
    });
    await page.goto('https://settings.test/');
    await page.evaluate(({ rules, operators, vocabulary }) => {
      window.__APP = { userOrgId: 'org', userId: 'owner' };
      window.confirm = () => true;
      window.calls = [];
      window.toasts = [];
      // The organization default already holds a pay rule everyone starts from; choosing a schedule must send it back untouched.
      window.db = { schedules: [], rules, plans: [], orgDefault: { subject: { type: 'organization', id: 'org' }, revision: 4, entries: [{ id: 'e1', kind: 'add', rule_id: 'hourly_time_clock', effective_from: '2026-01-01', entered_at: '2026-01-02T10:00:00.000Z', entered_by: 'owner', entered_by_name: 'Olive Owner' }] } };
      const sources = [
        { id: 'payroll.project_records', provider: 'payroll', export: 'project_records', description: 'Every project with its stored custom field values.', units: {}, needs_args: false, required_args: [], args: ['facts'], fields: ['id', 'title', 'sold_at', 'canceled_at'] },
        { id: 'payroll.time_shifts', provider: 'payroll', export: 'time_shifts', description: 'One row per shift.', units: { worked_seconds: 'seconds' }, needs_args: false, required_args: [], args: [], fields: ['assignee_key', 'approval_status', 'clocked_out_at'] }
      ];
      const preview = { payee_count: 2, changed_payee_count: 1, difference_count: 1, change_cents: 2000, held_count: 0, unresolved_count: 0, truncated: false,
        payees: [{ payee: { type: 'organization_user', id: 'ana' }, payee_name: 'Ana', change_cents: 2000, unresolved: [], differences: [{ rule_id: 'estimator_commission_sold', unit: 'p1', line: 'main', posted_cents: 50000, without_change_cents: 50000, target_cents: 52000, change_cents: 2000, handling: 'normal' }] }] };
      const copy = (value) => JSON.parse(JSON.stringify(value));
      const saveVersioned = (list, input, version) => {
        let item = list.find((entry) => entry.id === input.id);
        if (!item) { item = { id: input.id || `new_${list.length + 1}`, versions: [], revision: 0 }; list.push(item); }
        Object.assign(item, { name: input.name, description: input.description || '', status: 'active', revision: item.revision + 1 });
        item.versions = [...item.versions.filter((entry) => entry.effective_from !== input.effective_from), { effective_from: input.effective_from, entered_at: '2026-06-01T12:00:00.000Z', entered_by: 'owner', ...version }];
        return copy(item);
      };
      window.PlatformAPI = { publication: { invoke: async () => ({ value: { roles: [], users: [], resource_groups: [], connections: [] } }) } };
      window.PayrollAPI = {
        schedules: {
          list: async () => ({ schedules: copy(db.schedules) }),
          create: async (_org, payload) => { calls.push({ op: 'schedule.create', payload: copy(payload) }); const schedule = { id: `schedule_${db.schedules.length + 1}`, revision: 1, ...copy(payload) }; db.schedules.push(schedule); return { schedule }; },
          update: async (_org, id, payload) => { calls.push({ op: 'schedule.update', id, payload: copy(payload) }); Object.assign(db.schedules.find((entry) => entry.id === id), copy(payload), { revision: payload.expected_revision + 1 }); return {}; },
          archive: async () => ({})
        },
        pay: {
          default: async () => copy(db.orgDefault),
          saveDefault: async (_org, payload) => {
            calls.push({ op: 'default.save', payload: copy(payload) });
            db.orgDefault = { ...copy(payload), revision: db.orgDefault.revision + 1, schedules: payload.schedules.map((choice, index) => ({ ...choice, id: `c${index}`, entered_at: '2026-06-01T12:00:00.000Z', entered_by: 'owner' })) };
            delete db.orgDefault.expected_revision;
            return copy(db.orgDefault);
          },
          ruleSources: async () => copy(sources),
          // The fixed words and their labels come from payroll.pay_rule_vocabulary; the page keeps no copy.
          vocabulary: async () => ({ operators, ...vocabulary }),
          previewRule: async (_org, rule) => { calls.push({ op: 'rule.preview', payload: copy(rule) }); return copy(preview); },
          previewPlan: async (_org, plan) => { calls.push({ op: 'plan.preview', payload: copy(plan) }); return { ...copy(preview), payee_count: 0, changed_payee_count: 0, difference_count: 0, change_cents: 0, payees: [] }; },
          rules: async () => copy(db.rules),
          plans: async () => copy(db.plans),
          saveRule: async (_org, rule) => { calls.push({ op: 'rule.save', payload: copy(rule) }); return saveVersioned(db.rules, rule, { version: 'ffff0000', definition: rule.definition }); },
          savePlan: async (_org, plan) => { calls.push({ op: 'plan.save', payload: copy(plan) }); return saveVersioned(db.plans, plan, { rules: plan.rules }); },
          archiveRule: async (_org, id, revision) => { calls.push({ op: 'rule.archive', id, revision }); db.rules.find((entry) => entry.id === id).status = 'archived'; return {}; },
          archivePlan: async (_org, id, revision) => { calls.push({ op: 'plan.archive', id, revision }); db.plans.find((entry) => entry.id === id).status = 'archived'; return {}; }
        }
      };
    }, { rules: [estimatorRule, hourlyRule], operators: CONDITION_OPERATORS, vocabulary });
    await page.addScriptTag({ url: 'https://settings.test/libraries/apps/settings/payroll.js' });
    await page.evaluate(() => { window.settings = FirstMatePayrollSettings.mount(document.querySelector('#host'), { orgId: 'org', showToast: (...values) => toasts.push(values) }); });
    const lastCall = (op) => page.evaluate((name) => calls.filter((call) => call.op === name).at(-1), op);
    const previewDates = () => page.locator('[data-cadence-preview] [data-pay-date]').evaluateAll((items) => items.map((item) => item.dataset.payDate));
    const shots = process.env.PAYROLL_SETTINGS_SHOTS;
    const shot = async (name) => { if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true }); } };

    // The client's pay dates are the server's, for every shape of recurrence.
    const recurrences = sampleRecurrences();
    const clientDates = await page.evaluate((list) => list.map((recurrence) => FirstMatePayrollSettings.payDates(recurrence, '2026-01-01', '2028-12-31')), recurrences);
    recurrences.forEach((recurrence, index) => assert.deepEqual(clientDates[index], payrollPayDates({ recurrence }, '2026-01-01', '2028-12-31'), JSON.stringify(recurrence)));
    assert.ok(clientDates.filter((dates) => dates.length).length > 300);

    // A new schedule starts weekly on Friday; the 3rd Thursday is a preset, one day off and one position on.
    await page.locator('[data-add-schedule]').first().click();
    await page.locator('[data-schedule-name]').fill('Salaries');
    assert.match(await page.locator('[data-cadence-summary]').innerText(), /^Weekly on Friday\.$/);
    assert.deepEqual((await previewDates()).slice(0, 2), ['2026-06-05', '2026-06-12']);
    await page.locator('[data-cadence-preset="monthly"]').click();
    await page.locator('[data-cadence-add-position]').click();
    await page.locator('[data-cadence-day="1"]').click();
    assert.equal(await page.locator('[data-cadence-nth]').inputValue(), '3');
    assert.equal(await page.locator('[data-cadence-position-weekday]').inputValue(), '4');
    assert.equal(await page.locator('[data-cadence-summary]').innerText(), 'Monthly on the 3rd Thursday.');
    assert.deepEqual(await previewDates(), ['2026-06-18', '2026-07-16', '2026-08-20', '2026-09-17', '2026-10-15', '2026-11-19']);
    await shot('schedule-third-thursday');
    await page.locator('[data-schedule-form] button[type="submit"]').click();
    await page.locator('[data-select-schedule="schedule_1"]').waitFor();
    const thirdThursday = (await lastCall('schedule.create')).payload;
    assert.deepEqual(thirdThursday.recurrence, { frequency: 'monthly', nth_weekdays: [{ nth: 3, weekday: 4 }] });
    assert.deepEqual(thirdThursday.metadata, { correction_policy: { increase: 'next_run', decrease: 'hold' } });
    assert.equal(payrollScheduleInputSchema.safeParse(thirdThursday).success, true);
    assert.match(await page.locator('[data-select-schedule="schedule_1"]').innerText(), /Monthly on the 3rd Thursday/);

    // Twice a month, moved off weekends to the Friday before, with decreases taken back on the next run.
    await page.locator('[data-add-schedule]').first().click();
    await page.locator('[data-schedule-name]').fill('Office');
    await page.locator('[data-cadence-preset="twice_monthly"]').click();
    await page.locator('[data-cadence-adjust]').selectOption('previous_weekday');
    assert.equal(await page.locator('[data-cadence-summary]').innerText(), 'Monthly on the 1st and the 15th. A pay day on a weekend moves to the Friday before.');
    assert.deepEqual(await previewDates(), ['2026-06-01', '2026-06-15', '2026-07-01', '2026-07-15', '2026-07-31', '2026-08-14']);
    await page.locator('[data-correction-decrease]').selectOption('next_run');
    await page.locator('[data-correction-increase]').selectOption('off_cycle');
    await page.locator('[data-schedule-form] button[type="submit"]').click();
    await page.locator('[data-select-schedule="schedule_2"]').waitFor();
    const twiceMonthly = (await lastCall('schedule.create')).payload;
    assert.deepEqual(twiceMonthly.recurrence, { frequency: 'semi_monthly', days: [1, 15], adjust: 'previous_weekday' });
    assert.deepEqual(twiceMonthly.metadata.correction_policy, { increase: 'off_cycle', decrease: 'next_run' });
    assert.equal(payrollScheduleInputSchema.safeParse(twiceMonthly).success, true);

    // The saved schedule opens with what was saved, and the rest of the patterns come out as the server expects them.
    assert.equal(await page.locator('[data-cadence-adjust]').inputValue(), 'previous_weekday');
    assert.equal(await page.locator('[data-correction-decrease]').inputValue(), 'next_run');
    const built = async (steps) => {
      await page.locator('[data-add-schedule]').first().click();
      await steps();
      const recurrence = await page.evaluate(() => {
        const form = document.querySelector('[data-schedule-form]');
        form.querySelector('[data-schedule-name]').value = 'Probe';
        form.requestSubmit();
        return new Promise((resolve) => setTimeout(() => resolve(calls.filter((call) => call.op === 'schedule.create').at(-1).payload.recurrence), 50));
      });
      assert.equal(payrollRecurrenceSchema.safeParse(recurrence).success, true, JSON.stringify(recurrence));
      await page.locator('[data-schedule-form][data-schedule-id^="schedule_"]').waitFor();
      return recurrence;
    };
    assert.deepEqual(await built(async () => { await page.locator('[data-cadence-preset="biweekly"]').click(); }), { frequency: 'biweekly', weekday: 5, anchor_date: '2026-06-05' });
    assert.deepEqual(await built(async () => { await page.locator('[data-cadence-weekday="2"]').click(); }), { frequency: 'weekly', weekdays: [2, 5] });
    assert.deepEqual(await built(async () => {
      await page.locator('[data-cadence-unit]').selectOption('month');
      await page.locator('[data-cadence-day="1"]').click();
      await page.locator('[data-cadence-day="-1"]').click();
    }), { frequency: 'monthly', day: -1 });
    assert.deepEqual(await built(async () => {
      await page.locator('[data-cadence-unit]').selectOption('quarter');
      await page.locator('[data-cadence-day="1"]').click();
      await page.locator('[data-cadence-day="10"]').click();
      await page.locator('[data-cadence-quarter]').selectOption('1');
    }), { frequency: 'quarterly', day: 10, anchor_date: '2026-02-01' });
    assert.deepEqual(await built(async () => {
      await page.locator('[data-cadence-unit]').selectOption('year');
      await page.locator('[data-cadence-month="1"]').click();
      await page.locator('[data-cadence-month="12"]').click();
      await page.locator('[data-cadence-day="1"]').click();
      await page.locator('[data-cadence-add-position]').click();
      await page.locator('[data-cadence-nth]').selectOption('2');
      await page.locator('[data-cadence-position-weekday]').selectOption('1');
      assert.equal(await page.locator('[data-cadence-summary]').innerText(), 'Yearly in December on the 2nd Monday.');
      assert.deepEqual((await previewDates()).slice(0, 2), ['2026-12-14', '2027-12-13']);
    }), { frequency: 'yearly', nth_weekdays: [{ nth: 2, weekday: 1 }], months: [12] });
    assert.deepEqual(await built(async () => {
      await page.locator('[data-cadence-unit]').selectOption('day');
      await page.locator('[data-cadence-interval]').fill('3');
      await page.locator('[data-cadence-interval]').blur();
      assert.equal(await page.locator('[data-cadence-anchor]').inputValue(), '2026-06-01');
      assert.deepEqual((await previewDates()).slice(0, 3), ['2026-06-01', '2026-06-04', '2026-06-07']);
    }), { frequency: 'daily', interval: 3, anchor_date: '2026-06-01' });
    assert.deepEqual(await built(async () => {
      await page.locator('[data-cadence-interval]').fill('3');
      await page.locator('[data-cadence-interval]').blur();
    }), { frequency: 'weekly', weekday: 5, interval: 3, anchor_date: '2026-06-05' });

    // When people are paid: nothing is chosen at first. The company pays on one schedule, salary on another, from today.
    assert.equal(await page.locator('[data-when-kind="*"] [data-when-schedule]').inputValue(), '');
    assert.equal(await page.locator('[data-when-kind]').count(), 8, 'everyone, and one row per kind of earning');
    assert.equal(await page.locator('[data-policy-form],[data-add-assignment]').count(), 0, 'the per-person assignment panel is gone');
    await page.locator('[data-when-kind="*"] [data-when-schedule]').selectOption('schedule_2');
    await page.locator('[data-when-kind="salary"] [data-when-schedule]').selectOption('schedule_1');
    await shot('when-people-are-paid');
    await page.locator('[data-when-form] button[type="submit"]').click();
    await page.locator('[data-select-schedule="schedule_2"] [data-schedule-use]').waitFor();
    assert.equal(await page.locator('[data-select-schedule="schedule_2"] [data-schedule-use]').innerText(), 'Default');
    assert.equal(await page.locator('[data-select-schedule="schedule_1"] [data-schedule-use]').innerText(), 'Salary');
    const chosen = (await lastCall('default.save')).payload;
    assert.deepEqual(chosen, { subject: { type: 'organization', id: 'org' }, entries: [{ kind: 'add', rule_id: 'hourly_time_clock', effective_from: '2026-01-01' }], expected_revision: 4,
      schedules: [{ effective_from: '2026-06-01', earning_kind: '*', schedule_id: 'schedule_2' }, { effective_from: '2026-06-01', earning_kind: 'salary', schedule_id: 'schedule_1' }] });
    assert.match(await page.locator('[data-when-kind="salary"] small').innerText(), /On Salaries since Jun 1, 2026/);
    // From July salary goes back to the company's schedule: the choice is ended the day before, not rewritten.
    await page.locator('[data-when-from]').fill('2026-07-01');
    await page.locator('[data-when-kind="salary"] [data-when-schedule]').selectOption('');
    await page.locator('[data-when-form] button[type="submit"]').click();
    await page.locator('.pycfg-notice', { hasText: 'Jul 1, 2026' }).waitFor();
    const ended = (await lastCall('default.save')).payload;
    assert.deepEqual([ended.expected_revision, ended.schedules], [5, [{ effective_from: '2026-06-01', earning_kind: '*', schedule_id: 'schedule_2' }, { effective_from: '2026-06-01', effective_through: '2026-06-30', earning_kind: 'salary', schedule_id: 'schedule_1' }]]);
    await page.locator('[data-when-form] button[type="submit"]').click();
    assert.equal(await page.locator('[data-when-form] [data-form-status]').innerText(), 'Nothing has changed.');
    assert.equal((await page.evaluate(() => calls.filter((call) => call.op === 'default.save').length)), 2);

    // Pay plans and rules: a rule shows what it reads and its formula.
    await page.locator('[data-pay-section="pay"]').click();
    await page.locator('[data-pay-card="rule:estimator_commission_sold"]').waitFor();
    await page.locator('[data-pay-card="rule:estimator_commission_sold"] > summary').click();
    const ruleCard = await page.locator('[data-pay-card="rule:estimator_commission_sold"]').innerText();
    assert.match(ruleCard, /In effect since Jan 1, 2026/);
    assert.match(ruleCard, /entered Jan 2, 2026 by Olive Owner/, 'history says who entered a version, by name');
    assert.match(ruleCard, /Once per row of projects/);
    assert.match(ruleCard, /sold_at/);
    assert.match(ruleCard, /assignee_keys\.assignments\.estimator contains \$payee\.key and canceled_at is empty/);
    assert.match(ruleCard, /default 500/);
    assert.match(ruleCard, /contract_cents \* params\.rate_bps/);

    // A plan from two rules, with one parameter the plan sets.
    await page.locator('[data-pay-new="plan"]').click();
    await page.locator('[data-plan="name"]').fill('Estimators');
    await page.locator('[data-plan-rule="estimator_commission_sold"] [data-plan-include]').check();
    await page.locator('[data-plan-rule="hourly_time_clock"] [data-plan-include]').check();
    assert.equal(await page.locator('[data-plan-count]').innerText(), '2 selected');
    await page.locator('[data-plan-rule="estimator_commission_sold"] [data-plan-param="rate_bps"]').fill('250');
    assert.equal(await page.locator('[data-plan-rule="hourly_time_clock"] [data-plan-param]').count(), 2);
    // A parameter declared as money is typed in whole units and stored in cents.
    assert.equal(await page.locator('[data-plan-rule="hourly_time_clock"] [data-plan-param="rate_cents"]').getAttribute('data-param-type'), 'cents');
    await page.locator('[data-plan-rule="hourly_time_clock"] [data-plan-param="rate_cents"]').fill('25.50');
    await page.locator('[data-pay-preview]').click();
    assert.match(await page.locator('[data-pay-preview-summary]').innerText(), /Nobody is paid by this yet/);
    assert.deepEqual((await lastCall('plan.preview')).payload.rules, [{ rule_id: 'estimator_commission_sold', params: { rate_bps: 250 } }, { rule_id: 'hourly_time_clock', params: { rate_cents: 2550 } }]);
    assert.equal(await page.locator('[data-backdated]').count(), 0);
    await page.locator('[data-plan="effective_from"]').fill('2026-03-01');
    await page.locator('[data-backdated]').waitFor();
    assert.match(await page.locator('[data-backdated]').innerText(), /backdated[\s\S]*next refresh[\s\S]*correction/);
    assert.equal(await page.locator('[data-plan-rule="estimator_commission_sold"] [data-plan-param="rate_bps"]').inputValue(), '250');
    await shot('plan-editor');
    await page.locator('[data-pay-form="plan"] button[type="submit"]').click();
    await page.locator('[data-pay-list="plans"] [data-pay-card]').waitFor();
    const plan = (await lastCall('plan.save')).payload;
    assert.deepEqual(plan, { name: 'Estimators', description: '', effective_from: '2026-03-01', rules: [{ rule_id: 'estimator_commission_sold', params: { rate_bps: 250 } }, { rule_id: 'hourly_time_clock', params: { rate_cents: 2550 } }] });
    const planCard = await page.locator('[data-pay-list="plans"] [data-pay-card]').innerText();
    assert.match(planCard, /Estimators/);
    assert.match(planCard, /2 rules/);
    assert.match(planCard, /Share of contract \(basis points\): 250/);
    assert.match(planCard, /Weekly hours before overtime: 40 \(rule default\)/);
    assert.match(planCard, /Hourly rate: 25\.50/);
    assert.match(await page.locator('.pycfg-notice').innerText(), /in the past/);

    // Editing a rule saves a new version of the same definition from an effective date.
    await page.locator('[data-pay-card="rule:estimator_commission_sold"] [data-pay-edit]').click();
    assert.equal(await page.locator('[data-rule="effective_from"]').inputValue(), '2026-06-01');
    assert.equal(await page.locator('[data-rule-input] [data-c="field"]').first().inputValue(), 'assignee_keys.assignments.estimator');
    // The collection is picked from what the server publishes, and the conditions offered are the server's list.
    assert.equal(await page.locator('[data-rule-input] [data-in="source"]').inputValue(), 'payroll.project_records');
    assert.equal(await page.locator('[data-rule-input] [data-in="provider"]').count(), 0);
    assert.match(await page.locator('[data-in-source-help]').innerText(), /Every project with its stored custom field values\. Options it takes: facts\./);
    assert.deepEqual(await page.locator('[data-rule-input] [data-c="operator"]').first().locator('option').evaluateAll((options) => options.map((option) => option.value)), CONDITION_OPERATORS.map((operator) => operator.id));
    assert.deepEqual(await page.locator('[data-rule-param] [data-p="type"]').first().locator('option').evaluateAll((options) => options.map((option) => option.value)), [...PAY_PARAMETER_TYPES], 'the parameter kinds come from the server');
    await page.locator('[data-rule-param] [data-p="default"]').fill('600');
    await page.locator('[data-rule-add-param]').click();
    await page.locator('[data-rule-param] [data-p="key"]').nth(1).fill('minimum_cents');
    await page.locator('[data-rule-param] [data-p="label"]').nth(1).fill('Smallest commission (cents)');
    await page.locator('[data-rule="code"]').fill('return Math.max(params.minimum_cents || 0, Math.round(unit.record.contract_cents * params.rate_bps / 10000));');
    // A preview sends exactly what a save would, says who it reaches, and goes away when the form is edited again.
    await page.locator('[data-rule-param] [data-p="type"]').first().selectOption('basis_points');
    await page.locator('[data-pay-preview]').click();
    assert.equal(await page.locator('[data-pay-preview-summary]').innerText(), 'It reaches 2 payees. 1 earning would come to a different amount for 1 payee: +20.00 in total. Nothing has been saved.');
    assert.match(await page.locator('[data-pay-preview-payee="organization_user:ana"]').innerText(), /Ana[\s\S]*p1: 500\.00 to 520\.00[\s\S]*\+20\.00/);
    const previewed = (await lastCall('rule.preview')).payload;
    assert.equal(await page.evaluate(() => calls.filter((call) => call.op === 'rule.save').length), 0, 'a preview saves nothing');
    await shot('rule-editor');
    await page.locator('[data-rule-param] [data-p="label"]').nth(1).fill('Smallest commission');
    assert.equal(await page.locator('[data-pay-preview-result]').count(), 0);
    await page.locator('[data-rule-param] [data-p="label"]').nth(1).fill('Smallest commission (cents)');
    await page.locator('[data-pay-form="rule"] button[type="submit"]').click();
    await page.locator('[data-pay-list="rules"]').waitFor();
    const rule = (await lastCall('rule.save')).payload;
    assert.deepEqual(rule, {
      id: 'estimator_commission_sold', name: 'Estimator commission when sold', description: 'A share of the contract.', effective_from: '2026-06-01', expected_revision: 3,
      definition: {
        grain: 'record', earned_at: 'sold_at', project: 'id', kind: 'commission',
        inputs: estimatorRule.versions[0].definition.inputs,
        parameters: { rate_bps: { label: 'Share of contract (basis points)', type: 'basis_points', default: 600 }, minimum_cents: { label: 'Smallest commission (cents)', type: 'number' } },
        code: 'return Math.max(params.minimum_cents || 0, Math.round(unit.record.contract_cents * params.rate_bps / 10000));'
      }
    });
    assert.deepEqual(previewed, rule);
    assert.match(await page.locator('[data-pay-card="rule:estimator_commission_sold"]').innerText(), /2 versions/);

    // A period rule keeps its shape through the form, and a new rule is checked before it is sent.
    await page.locator('[data-pay-card="rule:hourly_time_clock"] > summary').click();
    await page.locator('[data-pay-card="rule:hourly_time_clock"] [data-pay-edit]').click();
    await page.locator('[data-pay-form="rule"] button[type="submit"]').click();
    await page.locator('[data-pay-list="rules"]').waitFor();
    const hourly = (await lastCall('rule.save')).payload;
    assert.deepEqual(hourly.definition, { grain: 'period', period: 'week', week_starts: 1, kind: 'hourly', inputs: hourlyRule.versions[0].definition.inputs, parameters: { rate_cents: { label: 'Hourly rate', type: 'cents' }, overtime_after_hours: { label: 'Weekly hours before overtime', type: 'number', default: 40 } }, code: hourlyRule.versions[0].definition.code });
    await page.locator('[data-pay-new="rule"]').click();
    await page.locator('[data-rule="name"]').fill('Flat bonus');
    await page.locator('[data-pay-form="rule"] button[type="submit"]').click();
    assert.match(await page.locator('[data-pay-form="rule"] [data-form-status]').innerText(), /Input 1: name it/);
    await page.locator('[data-rule="grain"]').selectOption('period');
    await page.locator('[data-rule-remove-input]').click();
    await page.locator('[data-rule="period"]').selectOption('month');
    await page.locator('[data-rule="always"]').check();
    await page.locator('[data-rule="code"]').fill('return 50000;');
    await page.locator('[data-pay-form="rule"] button[type="submit"]').click();
    await page.locator('[data-pay-list="rules"]').waitFor();
    const bonus = (await lastCall('rule.save')).payload;
    assert.deepEqual(bonus, { name: 'Flat bonus', description: '', effective_from: '2026-06-01', definition: { grain: 'period', period: 'month', always: true, kind: 'commission', inputs: {}, parameters: {}, code: 'return 50000;' } });

    // Archive, for a plan and for a rule.
    await page.locator('[data-pay-list="plans"] [data-pay-archive]').click();
    await page.locator('[data-pay-list="plans"] .pycfg-pill.off').waitFor();
    assert.deepEqual(await lastCall('plan.archive'), { op: 'plan.archive', id: 'new_1', revision: 1 });
    await page.locator('[data-pay-card="rule:hourly_time_clock"] [data-pay-archive]').click();
    await page.locator('[data-pay-card="rule:hourly_time_clock"] .pycfg-pill.off').waitFor();
    assert.deepEqual(await lastCall('rule.archive'), { op: 'rule.archive', id: 'hourly_time_clock', revision: 2 });
    await shot('pay-lists');

    // The server accepts every rule and plan the forms sent, when its schemas can be loaded here.
    const payRules = await import('../payroll/pay-rules.ts').catch(() => null);
    if (payRules) {
      for (const payload of [rule, hourly, bonus]) assert.equal(payRules.payRuleSaveSchema.safeParse(payload).success, true, JSON.stringify(payRules.payRuleSaveSchema.safeParse(payload).error?.issues));
      assert.equal(payRules.payPlanSaveSchema.safeParse(plan).success, true);
      for (const payload of [chosen, ended]) assert.equal(payRules.payDefaultSaveSchema.safeParse(payload).success, true, JSON.stringify(payRules.payDefaultSaveSchema.safeParse(payload).error?.issues));
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
