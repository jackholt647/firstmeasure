import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

// Mounts the Payroll settings page against a stubbed PayrollAPI with the clock held at 2026-06-01, and checks what
// the schedule editor and the pay plan and pay rule editors send. Run with `--import tsx` so the payloads can be
// held against the server's own schemas and the client's pay-date preview against payrollPayDates.

const estimatorRule = {
  id: 'estimator_commission_sold', name: 'Estimator commission when sold', description: 'A share of the contract.', status: 'active', revision: 3,
  versions: [{ version: 'abcdef0123456789', effective_from: '2026-01-01', entered_at: '2026-01-02T10:00:00.000Z', entered_by: 'owner', definition: {
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
    parameters: { rate_cents: { label: 'Hourly rate (cents)' }, overtime_after_hours: { label: 'Weekly hours before overtime', default: 40 } },
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

test('payroll settings build any pay cadence, set corrections, and edit pay plans and pay rules', async () => {
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
    await page.evaluate(({ rules }) => {
      window.__APP = { userOrgId: 'org', userId: 'owner' };
      window.confirm = () => true;
      window.calls = [];
      window.toasts = [];
      window.db = { schedules: [], rules, plans: [] };
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
        policies: { list: async () => ({ policies: [] }) },
        pay: {
          rules: async () => copy(db.rules),
          plans: async () => copy(db.plans),
          saveRule: async (_org, rule) => { calls.push({ op: 'rule.save', payload: copy(rule) }); return saveVersioned(db.rules, rule, { version: 'ffff0000', definition: rule.definition }); },
          savePlan: async (_org, plan) => { calls.push({ op: 'plan.save', payload: copy(plan) }); return saveVersioned(db.plans, plan, { rules: plan.rules }); },
          archiveRule: async (_org, id, revision) => { calls.push({ op: 'rule.archive', id, revision }); db.rules.find((entry) => entry.id === id).status = 'archived'; return {}; },
          archivePlan: async (_org, id, revision) => { calls.push({ op: 'plan.archive', id, revision }); db.plans.find((entry) => entry.id === id).status = 'archived'; return {}; }
        }
      };
    }, { rules: [estimatorRule, hourlyRule] });
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

    // Pay plans and rules: a rule shows what it reads and its formula.
    await page.locator('[data-pay-section="pay"]').click();
    await page.locator('[data-pay-card="rule:estimator_commission_sold"]').waitFor();
    await page.locator('[data-pay-card="rule:estimator_commission_sold"] > summary').click();
    const ruleCard = await page.locator('[data-pay-card="rule:estimator_commission_sold"]').innerText();
    assert.match(ruleCard, /In effect since Jan 1, 2026/);
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
    assert.equal(await page.locator('[data-backdated]').count(), 0);
    await page.locator('[data-plan="effective_from"]').fill('2026-03-01');
    await page.locator('[data-backdated]').waitFor();
    assert.match(await page.locator('[data-backdated]').innerText(), /backdated[\s\S]*next refresh[\s\S]*correction/);
    assert.equal(await page.locator('[data-plan-rule="estimator_commission_sold"] [data-plan-param="rate_bps"]').inputValue(), '250');
    await shot('plan-editor');
    await page.locator('[data-pay-form="plan"] button[type="submit"]').click();
    await page.locator('[data-pay-list="plans"] [data-pay-card]').waitFor();
    const plan = (await lastCall('plan.save')).payload;
    assert.deepEqual(plan, { name: 'Estimators', description: '', effective_from: '2026-03-01', rules: [{ rule_id: 'estimator_commission_sold', params: { rate_bps: 250 } }, { rule_id: 'hourly_time_clock' }] });
    const planCard = await page.locator('[data-pay-list="plans"] [data-pay-card]').innerText();
    assert.match(planCard, /Estimators/);
    assert.match(planCard, /2 rules/);
    assert.match(planCard, /Share of contract \(basis points\): 250/);
    assert.match(planCard, /Weekly hours before overtime: 40 \(rule default\)/);
    assert.match(await page.locator('.pycfg-notice').innerText(), /in the past/);

    // Editing a rule saves a new version of the same definition from an effective date.
    await page.locator('[data-pay-card="rule:estimator_commission_sold"] [data-pay-edit]').click();
    assert.equal(await page.locator('[data-rule="effective_from"]').inputValue(), '2026-06-01');
    assert.equal(await page.locator('[data-rule-input] [data-c="field"]').first().inputValue(), 'assignee_keys.assignments.estimator');
    await page.locator('[data-rule-param] [data-p="default"]').fill('600');
    await page.locator('[data-rule-add-param]').click();
    await page.locator('[data-rule-param] [data-p="key"]').nth(1).fill('minimum_cents');
    await page.locator('[data-rule-param] [data-p="label"]').nth(1).fill('Smallest commission (cents)');
    await page.locator('[data-rule="code"]').fill('return Math.max(params.minimum_cents || 0, Math.round(unit.record.contract_cents * params.rate_bps / 10000));');
    await shot('rule-editor');
    await page.locator('[data-pay-form="rule"] button[type="submit"]').click();
    await page.locator('[data-pay-list="rules"]').waitFor();
    const rule = (await lastCall('rule.save')).payload;
    assert.deepEqual(rule, {
      id: 'estimator_commission_sold', name: 'Estimator commission when sold', description: 'A share of the contract.', effective_from: '2026-06-01', expected_revision: 3,
      definition: {
        grain: 'record', earned_at: 'sold_at', project: 'id', kind: 'commission',
        inputs: estimatorRule.versions[0].definition.inputs,
        parameters: { rate_bps: { label: 'Share of contract (basis points)', default: 600 }, minimum_cents: { label: 'Smallest commission (cents)' } },
        code: 'return Math.max(params.minimum_cents || 0, Math.round(unit.record.contract_cents * params.rate_bps / 10000));'
      }
    });
    assert.match(await page.locator('[data-pay-card="rule:estimator_commission_sold"]').innerText(), /2 versions/);

    // A period rule keeps its shape through the form, and a new rule is checked before it is sent.
    await page.locator('[data-pay-card="rule:hourly_time_clock"] > summary').click();
    await page.locator('[data-pay-card="rule:hourly_time_clock"] [data-pay-edit]').click();
    await page.locator('[data-pay-form="rule"] button[type="submit"]').click();
    await page.locator('[data-pay-list="rules"]').waitFor();
    const hourly = (await lastCall('rule.save')).payload;
    assert.deepEqual(hourly.definition, { grain: 'period', period: 'week', week_starts: 1, kind: 'hourly', inputs: hourlyRule.versions[0].definition.inputs, parameters: hourlyRule.versions[0].definition.parameters, code: hourlyRule.versions[0].definition.code });
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
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
