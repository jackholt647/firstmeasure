import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

// Bills (payees paid through payables) and export templates in the Payroll app, against a stubbed publication layer.
// The template catalog is the server's own (payroll/export-templates.ts). Desktop and 390px; screenshots go to
// output/payroll-ui/.
const libraries = new URL('../../libraries/', import.meta.url);
const shots = new URL('../../../output/payroll-ui/', import.meta.url);
const shotPath = (name) => new URL(`${name}.png`, shots).pathname.replace(/^\/(\w:)/, '$1');
const day = (offset) => { const date = new Date(Date.now() + offset * 86400000); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
const catalog = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "const m=await import('./payroll/export-templates.ts');process.stdout.write(JSON.stringify({templates:m.BUILT_IN_TEMPLATES,sources:m.EXPORT_SOURCES,date_formats:[...m.DATE_FORMATS],pay_item_labels:m.PAY_ITEM_LABELS,people:[{id:'employees',label:'Employees'},{id:'contractors',label:'Contractors'},{id:'bills',label:'Bills'}]}))"], { cwd:new URL('..', import.meta.url), encoding:'utf8' }));

function fixtures(){
  const ana = { type:'organization_user', id:'ana', name:'Ana Lopez', worker_type:'employee' };
  const dev = { type:'organization_user', id:'dev', name:'Dev Patel', worker_type:'independent_contractor' };
  const summit = { type:'organization_connection', id:'summit', name:'Summit Roofing LLC', worker_type:'subcontractor' };
  const haul = { type:'organization_connection', id:'haul', name:'Haul Away Disposal', worker_type:'subcontractor' };
  const weekly = { id:'weekly', name:'Weekly hourly', currency:'USD', timezone:'America/Chicago', recurrence:{ frequency:'weekly', weekday:5 }, delay:{}, timing_basis:'worked', clawback_cap_percent:25, status:'active', revision:2 };
  const net30 = { basis:'net_days', net_days:30 };
  const preview = (payee, totals, extra = {}) => {
    const gross = Object.values(totals).filter((v) => v > 0).reduce((s, v) => s + v, 0);
    const off = Math.abs(totals.off_cycle || 0);
    return { payee, worker_type:payee.worker_type, accrued:{ payee, gross_cents:gross, deduction_cents:off, off_cycle_cents:off, clawback_cents:0, net_cents:gross - off, subgroup_totals:totals, entry_count:2 }, projected:{ gross_cents:0, deduction_cents:0, net_cents:0, subgroup_totals:{}, entry_count:0 }, forecast_net_cents:gross - off, paid_through:'payroll', ...extra };
  };
  const item = (id, payee, totals, status, metadata = {}) => {
    const gross = Object.values(totals).filter((v) => v > 0).reduce((s, v) => s + v, 0);
    const deduction = Object.values(totals).filter((v) => v < 0).reduce((s, v) => s - v, 0);
    return { id, batch_id:'run_bills', payee, status, gross_cents:gross, commission_cents:0, deduction_cents:deduction, net_cents:gross - deduction, subgroup_totals:totals, payment_reference:status === 'paid' ? 'GUSTO-88' : '', metadata, entries:[], revision:2, run_at:'', paid_at:'' };
  };
  const nextFriday = (() => { for (let i = 1; i <= 7; i++) { const d = new Date(`${day(i)}T12:00:00`); if (d.getDay() === 5) return i; } return 1; })();
  const entered = { id:'run_bills', schedule_id:'weekly', pay_date:day(nextFriday + 7), period_start:day(nextFriday - 5), period_end:day(nextFriday + 1), status:'run', currency:'USD', run_type:'regular', approval:{ status:'finalized' }, metadata:{}, revision:5,
    items:[item('i_ana', ana, { hourly:118000 }, 'paid', { paid_through:'payroll' }), item('i_summit', summit, { piece_rate:640000, reimbursement:12000, off_cycle:-20000 }, 'run', { paid_through:'payables', payment_terms:net30, due_date:day(nextFriday + 37) })],
    total_cents:118000 + 632000, employee_total_cents:118000, subcontractor_total_cents:632000, created_at:'', updated_at:'', run_at:'', paid_at:'' };
  const dashboard = { from:day(0), through:day(62), schedules:[weekly], diagnostics:[], history:[], branch_scope:{ multiple:false },
    upcoming:[
      { schedule:weekly, pay_date:day(nextFriday), period_start:day(nextFriday - 12), period_end:day(nextFriday - 6), cutoff_at:`${day(nextFriday - 6)}T23:59:59Z`, batch:null,
        employees:[preview(ana, { hourly:120000 })], subcontractors:[preview(dev, { piece_rate:85000 }), preview(summit, { piece_rate:420000, reimbursement:5000 }, { paid_through:'payables', payment_terms:net30, due_date:day(nextFriday + 30) }), preview(haul, { piece_rate:30000 }, { paid_through:'payables', payment_terms:{ basis:'payroll_schedule', net_days:0 }, due_date:day(nextFriday) })],
        accrued_total_cents:660000, projected_additional_cents:0, forecast_total_cents:660000 },
      { schedule:weekly, pay_date:entered.pay_date, period_start:entered.period_start, period_end:entered.period_end, cutoff_at:'', batch:entered, employees:[], subcontractors:[], accrued_total_cents:750000, projected_additional_cents:0, forecast_total_cents:750000 }
    ] };
  const bills = [
    { id:'payment_payable_payroll_run_bills_i_summit', payee:summit, status:'partially_paid', amount_cents:632000, paid_cents:200000, currency:'USD', due_date:day(nextFriday + 37), pay_date:entered.pay_date, batch_id:'run_bills', item_id:'i_summit', payment_terms:net30, item_status:'run', needs_settlement:false },
    { id:'payment_payable_payroll_run_old_i_haul', payee:haul, status:'paid', amount_cents:30000, paid_cents:30000, currency:'USD', due_date:day(-3), pay_date:day(-3), batch_id:'run_old', item_id:'i_haul', payment_terms:{}, item_status:'run', needs_settlement:true },
    { id:'payment_payable_payroll_run_old_i_dev', payee:dev, status:'open', amount_cents:45000, paid_cents:0, currency:'USD', due_date:day(-1), pay_date:day(-16), batch_id:'run_old', item_id:'i_dev', payment_terms:{ basis:'net_days', net_days:15 }, item_status:'run', needs_settlement:false }
  ];
  const own = { id:'pay_export_a1b2c3', name:'ADP import', built_in:false, based_on:'gusto_employees', revision:2, formats:['csv'], definition:{ name:'ADP import', rows:'person', people:['employees'], columns:[{ header:'Co Code', source:'fixed', value:'ACM' }, { header:'File #', source:'person.field', field:'employee_number' }, { header:'Reg Earnings', source:'pay.hourly' }, { header:'Check Date', source:'run.pay_date', format:{ date:'MM/DD/YYYY' } }] } };
  return { dashboard, bills, templates:{ ...catalog, templates:[...catalog.templates, own] }, schedules:[weekly],
    myEarnings:{ subject:dev, currency:'USD', totals:{ projected_cents:0, accrued_cents:0, in_payroll_cents:45000, owed_cents:45000, paid_cents:90000, earned_cents:135000 }, projects:[], entries:[], off_cycle_payments:[],
      payments:[{ id:'p1', batch_id:'run_old', status:'run', pay_date:day(-16), currency:'USD', net_cents:45000, amount_cents:45000, schedule:{ id:'weekly', name:'Weekly hourly' }, allocations:[], paid_through:'payables', due_date:day(-1) }, { id:'p0', batch_id:'run_older', status:'paid', pay_date:day(-30), currency:'USD', net_cents:90000, amount_cents:90000, schedule:{ id:'weekly', name:'Weekly hourly' }, allocations:[], paid_through:'payables', due_date:day(-15) }] } };
}

const people = {
  manager:{ userId:'owner', permissions:{ manage_payroll:true, manage_company_settings:true } },
  contractor:{ userId:'dev', permissions:{} }
};

async function openApp(browser, who, viewport){
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => { errors.push(`dialog: ${dialog.message()}`); dialog.dismiss(); });
  await page.route('https://payroll.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/libraries/')) return route.fulfill({ contentType:'application/javascript; charset=utf-8', body:await readFile(new URL(path.replace('/libraries/', ''), libraries)) });
    if (path.startsWith('/v1/')) return route.fulfill({ contentType:'text/csv', body:'ok' });
    return route.fulfill({ contentType:'text/html', body:'<!doctype html><meta charset="utf-8"><style>body{margin:0;font:14px Inter,Arial,sans-serif;--bg:#f2f4f7}main{height:100vh}</style><main></main>' });
  });
  await page.goto('https://payroll.test/');
  await Promise.race([page.addStyleTag({ url:'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css' }).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 4000))]);
  await page.evaluate(({ who, data }) => {
    window.data = data; window.calls = [];
    window.__APP = { userOrgId:'org', userId:who.userId };
    const route = { tab:'payroll' }, handlers = [];
    window.Portal = {
      currentUser:{ id:who.userId, permissions:who.permissions, appEntitlements:[] }, util:{ hasPerm:(key) => who.permissions[key] === true }, ui:{ showToast:(...values) => { (window.toasts = window.toasts || []).push(values); } },
      capabilities:{ current:() => ({ definitions_by_key:{}, effective_by_key:{ 'apps.payroll':true, 'payroll.pay_runs':true, 'payroll.self_service_earnings':true } }) },
      navigation:{ read:() => route, registerHandler:(id, handler) => { handlers.push(handler); return () => {}; }, navigate:(patch) => { Object.assign(route, patch); handlers.forEach((handler) => handler.apply(route)); }, push:(patch) => Object.assign(route, patch), replace:(patch) => Object.assign(route, patch) }
    };
    const value = (v) => JSON.parse(JSON.stringify(v));
    const reads = { bills:() => data.bills, export_templates:() => data.templates, configuration:() => ({ schedules:data.schedules, schedule_choices:[], settings:{ approval_required:true, revision:1 } }), pay_rule_vocabulary:() => ({ labels:{} }), my_approvals:() => ({ count:0, approvals:[] }), pay_review:() => ({ held:[], off_cycle:[] }), pay_unresolved:() => [], off_cycle_payments:() => [] };
    window.PlatformAPI = { publication:{
      read:async (org, ref) => {
        if (ref.provider === 'organization-branches') return { status:'ready', value:{ multiple:false } };
        window.calls.push({ read:ref.export, args:ref.args });
        const read = reads[ref.export];
        return read ? { status:'ready', value:value(read(ref)) } : { status:'ready', value:{} };
      },
      invoke:async (org, action, target, input) => {
        window.calls.push({ action, target, input });
        const ok = (v) => ({ receipt:{ status:'succeeded' }, value:value(v) });
        switch (action) {
          case 'payroll.dashboard.read': return ok(data.dashboard);
          case 'payroll.earnings.me': return ok({ earnings:[data.myEarnings], count:1 });
          case 'payroll.exports.catalog': return ok([]);
          case 'payroll.bills.reconcile': return ok({ settled_count:1, removed_count:0 });
          case 'payroll.artifact.generate': return ok({ id:'art', download_url:'/v1/payroll/organizations/org/artifacts/art/download', metadata:{} });
          case 'payroll.exportTemplate.preview': {
            const columns = input.definition.columns;
            if (!input.definition.name) throw new Error('A file needs a name.');
            const sample = (column) => column.source === 'fixed' ? column.value || '' : column.source.startsWith('pay.') || column.source === 'line.amount' ? '1200.00' : column.source === 'person.name' ? 'Ana Lopez' : column.source === 'run.pay_date' ? '07/10/2026' : 'E-0042';
            return ok({ headers:columns.map((column) => column.header), rows:[columns.map(sample), columns.map(sample)], row_count:2, person_count:2, warnings:[], file:{ extension:'csv' } });
          }
          case 'payroll.exportTemplate.save': return ok({ id:input.id || 'pay_export_new', name:input.definition.name, built_in:false, based_on:input.based_on || '', revision:(input.expected_revision || 0) + 1, formats:['csv'], definition:input.definition });
          default: return ok({ batch:data.dashboard.upcoming[1].batch, bills:[] });
        }
      }
    } };
  }, { who:people[who], data:fixtures() });
  for (const script of ['app-runtime/firstmate-embeddable-apps.js', 'app-runtime/app-chrome.js', 'apps/people/people-kit.js', 'apps/people/entity-modal.js', 'payroll-api/payroll-api.js', 'apps/settings/payroll.js', 'apps/payroll/my-pay.js', 'apps/payroll/app.js']) await page.addScriptTag({ url:`https://payroll.test/libraries/${script}` });
  await page.evaluate(async (who) => { window.handle = await window.FirstMateEmbeddableApps.mount(document.querySelector('main'), 'portal.payroll', { surface:'portal_tab', orgId:'org', permissions:who.permissions }); }, people[who]);
  return { page, errors };
}
async function show(page, view){
  await page.locator(`[data-app-header] [data-payroll-view="${view}"]`).click();
  await page.locator(`.fmp[data-payroll-view="${view}"]`).waitFor();
  await page.waitForFunction(() => !document.querySelector('.fmp .fmp-state[role=status]'));
}
async function shoot(page, name, phone){
  await page.waitForTimeout(350);
  await page.screenshot({ path:shotPath(name), fullPage:true });
  if (phone) assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${name} scrolls sideways`);
}

test('payroll app: bills are their own part of a pay run, and files are made from export templates', async () => {
  await mkdir(shots, { recursive:true });
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  try {
    for (const [width, height, suffix] of [[1440, 900, 'desktop'], [390, 844, 'phone']]) {
      const phone = suffix === 'phone';
      const { page, errors } = await openApp(browser, 'manager', { width, height });
      await show(page, 'upcoming');

      // Open bills, with what payables paid and a payment the pay run does not show yet.
      const bills = page.locator('[data-section="bills"]');
      await bills.waitFor();
      const billsText = await bills.innerText();
      assert.match(billsText, /Summit Roofing LLC[\s\S]*\$6,320\.00\s+\$2,000\.00 paid[\s\S]*Partly paid/);
      assert.match(billsText, /Dev Patel[\s\S]*Overdue/);
      assert.doesNotMatch(billsText, /Haul Away/, 'a paid bill is not waiting');
      if (!phone) assert.match(await page.locator('[data-section="runs"] thead').innerText(), /Bills/);
      await shoot(page, `bills-pay-runs-${suffix}`, phone);
      await bills.locator('[data-act="reconcile-bills"]').click();
      await page.waitForFunction(() => calls.some((call) => call.action === 'payroll.bills.reconcile'));

      // An undrafted run: employees, contractors paid with payroll, and bills with their due dates.
      await page.locator('[data-section="runs"] tbody tr').first().click();
      const panel = page.locator('.pp-modal [data-modal-panel="people"]');
      await page.locator('.pp-modal [data-run-steps="none"]').waitFor();
      const text = await panel.innerText();
      assert.match(text, /Employees[\s\S]*Ana Lopez[\s\S]*Contractors[\s\S]*Dev Patel[\s\S]*Bills[\s\S]*Haul Away Disposal[\s\S]*Due on the pay date[\s\S]*Summit Roofing LLC[\s\S]*Net 30/);
      assert.match(await page.locator('.pp-modal [data-run-steps]').innerText(), /paid through payables become bills when it is entered/);
      await shoot(page, `bills-pay-run-preview-${suffix}`);
      await page.keyboard.press('Escape');

      // An entered run: payroll is paid, the bill is partly paid in payables.
      await page.locator('[data-section="runs"] tbody tr').nth(1).click();
      await page.locator('.pp-modal [data-run-steps="bills"]').waitFor();
      assert.match(await page.locator('.pp-modal [data-run-steps]').innerText(), /Everyone paid with payroll is paid/);
      assert.match(await panel.innerText(), /Summit Roofing LLC[\s\S]*\$2,000\.00 paid/);
      assert.equal(await page.locator('.pp-modal [data-run-act="paid"]').count(), 0, 'nothing is left to mark paid for the whole run');
      await shoot(page, `bills-pay-run-entered-${suffix}`);

      // Copy out: the built-in files and the company's own.
      await page.locator('.pp-modal [data-modal-tab="export"]').click();
      await page.locator('.pp-modal [data-file="pay_export_a1b2c3"]').waitFor();
      assert.deepEqual(await page.locator('.pp-modal [data-file]').evaluateAll((rows) => rows.map((row) => row.dataset.file)), ['pay_run_summary', 'gusto_employees', 'gusto_contractors', 'quickbooks_payroll', 'quickbooks_bills', 'pay_export_a1b2c3']);
      assert.match(await page.locator('.pp-modal [data-file="pay_export_a1b2c3"]').innerText(), /ADP import[\s\S]*Your file, from Gusto: employees/);
      await shoot(page, `templates-copy-out-${suffix}`);
      await page.locator('.pp-modal [data-export-template="pay_export_a1b2c3"]').click();
      await page.waitForFunction(() => calls.some((call) => call.action === 'payroll.artifact.generate' && call.input.template_id === 'pay_export_a1b2c3' && call.input.batch_id === 'run_bills'));
      await page.locator('.pp-modal [data-export="gusto_employees"]').click();
      await page.waitForFunction(() => calls.some((call) => call.action === 'payroll.artifact.generate' && call.input.type === 'gusto_employees'));

      // Change the company's own file: rename a header, add a column of fixed text, move it first; the preview follows.
      await page.locator('.pp-modal [data-template-menu="pay_export_a1b2c3"]').click();
      await page.locator('.pp-menu').getByRole('menuitem', { name:'Change', exact:true }).click();
      const editor = page.locator('.pp-modal [data-template-editor]');
      await editor.waitFor();
      await editor.locator('[data-tpl-preview] table').waitFor();
      await editor.locator('[data-col-header="2"]').fill('Regular');
      await editor.locator('[data-col-add]').click();
      await editor.locator('[data-col-source="4"]').selectOption('fixed');
      await editor.locator('[data-col-value="4"]').fill('WEEKLY');
      for (let i = 0; i < 4; i++) await editor.locator(`[data-col-up="${4 - i}"]`).click();
      await page.waitForFunction(() => { const head = [...document.querySelectorAll('.pp-modal [data-tpl-preview] th')].map((th) => th.textContent); return head[0] === 'Fixed text' && head.includes('Regular'); });
      await editor.locator('[data-tpl="number"]').selectOption('grouped');
      await shoot(page, `templates-editor-${suffix}`, phone);
      await page.waitForFunction(() => /WEEKLY/.test(document.querySelector('.pp-modal [data-tpl-preview]')?.textContent || ''));
      await editor.locator('[data-tpl-preview]').scrollIntoViewIfNeeded();
      await shoot(page, `templates-editor-preview-${suffix}`, phone);
      await editor.locator('[data-tpl-save]').click();
      await page.waitForFunction(() => calls.some((call) => call.action === 'payroll.exportTemplate.save' && call.input.id === 'pay_export_a1b2c3' && call.input.expected_revision === 2));
      const saved = await page.evaluate(() => calls.filter((call) => call.action === 'payroll.exportTemplate.save').pop().input.definition);
      assert.deepEqual(saved.columns.map((column) => [column.header, column.source]), [['Fixed text', 'fixed'], ['Co Code', 'fixed'], ['File #', 'person.field'], ['Regular', 'pay.hourly'], ['Check Date', 'run.pay_date']]);
      assert.equal(saved.columns[0].value, 'WEEKLY'); assert.deepEqual(saved.number, { decimals:2, thousands:true });
      await page.locator('.pp-modal [data-file="pay_export_a1b2c3"]').waitFor();

      // Make your own file from a built-in one.
      await page.locator('.pp-modal [data-template-new]').click();
      await page.locator('.pp-menu .pp-menu-item', { hasText:'QuickBooks: contractor bills' }).click();
      await editor.waitFor();
      assert.equal(await editor.locator('[data-tpl="name"]').inputValue(), 'QuickBooks: contractor bills (yours)');
      assert.equal(await editor.locator('[data-tpl="rows"]').inputValue(), 'pay_item');
      assert.equal(await editor.locator('[data-tpl-people="bills"]').getAttribute('aria-pressed'), 'true');
      await editor.locator('[data-tpl="date"]').selectOption('MM/DD/YYYY');
      await shoot(page, `templates-new-from-bills-${suffix}`, phone);
      // The editor fits its tab: only the preview table scrolls sideways, inside its own box.
      assert.ok(await page.evaluate(() => { const editor = document.querySelector('.pp-modal [data-template-editor]'); return editor.scrollWidth <= editor.clientWidth + 1; }), 'the template editor fits its tab');
      await editor.locator('[data-tpl-save]').click();
      await page.waitForFunction(() => calls.some((call) => call.action === 'payroll.exportTemplate.save' && !call.input.id && call.input.based_on === 'quickbooks_bills' && call.input.definition.date === 'MM/DD/YYYY'));
      assert.ok(await page.evaluate(() => calls.filter((call) => call.action === 'payroll.exportTemplate.preview').every((call) => call.input.batch_id === 'run_bills')));
      await page.keyboard.press('Escape');

      // Earnings say who is paid through payables.
      await show(page, 'payees');
      assert.match(await page.locator('[data-section="payees"]').innerText(), /Summit Roofing LLC[\s\S]*Company, bills \(net 30\)/);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('payroll app: a contractor paid through payables sees their bills in My pay', async () => {
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  try {
    for (const [width, height, suffix] of [[1440, 900, 'desktop'], [390, 844, 'phone']]) {
      const { page, errors } = await openApp(browser, 'contractor', { width, height });
      await show(page, 'mine');
      const text = await page.locator('[data-section="payments"]').innerText();
      assert.match(text, /Billed, due/);
      assert.match(text, /Paid/);
      await shoot(page, `bills-my-pay-${suffix}`, suffix === 'phone');
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});
