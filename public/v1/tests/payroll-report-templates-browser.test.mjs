import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';

// Reports for dates are export templates (docs/architecture/pay-rules.md "Export templates"): Payroll › Reports lists
// the built-in ones, makes a company's own from one of them in the same editor pay run files use, with a preview of the
// dates chosen (worked out here by the server's own renderTemplate over the captured July 2026 ledger), and downloads
// it as CSV or PDF. Run with `--import tsx`. PAYROLL_UI_SHOTS=<dir> saves desktop and 390px screenshots.
const root = await mkdtemp(path.join(os.tmpdir(), 'payroll-report-ui-'));
Object.assign(process.env, { NODE_ENV: 'test', FIRSTMATE_ENV: 'test', PLATFORM_STORAGE_ROOT: root, FIRSTMEASURE_DATABASE_MODE: 'local', FIRSTMEASURE_INDEX_DB_PATH: path.join(root, 'index.sqlite') });
const templates = await import('../payroll/export-templates.ts');
const range = JSON.parse(await readFile(new URL('./fixtures/payroll-date-range-reports.json', import.meta.url), 'utf8'));
const shotsDir = process.env.PAYROLL_UI_SHOTS;

test('Reports makes a company’s own report for dates from a built-in one, previews the dates and downloads it', async () => {
  const context = { batch: {}, emails: new Map(), range: range.range,
    entries: range.entries.filter((entry) => entry.eligible_at.slice(0, 10) >= range.range.from && entry.eligible_at.slice(0, 10) <= range.range.through && entry.state !== 'projected'),
    reimbursements: range.receipts.map((receipt) => receipt.reimbursement_request).filter((request) => request.id) };
  const catalog = { templates: templates.BUILT_IN_TEMPLATES, sources: templates.EXPORT_SOURCES, date_formats: [...templates.DATE_FORMATS], pay_item_labels: templates.PAY_ITEM_LABELS, people: [{ id: 'employees', label: 'Employees' }, { id: 'contractors', label: 'Contractors' }, { id: 'bills', label: 'Bills' }] };
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('https://payroll.test/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.startsWith('/libraries/')) return route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: await readFile(new URL('../../libraries/' + pathname.slice('/libraries/'.length), import.meta.url)) });
      return route.fulfill({ contentType: 'text/html', body: '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Arial;margin:0}</style><div id="host"></div>' });
    });
    // The preview is the server's: the same renderTemplate a download uses, over the captured month.
    await page.exposeFunction('renderReport', (definition) => {
      const parsed = templates.templateDefinitionSchema.parse(definition);
      const table = templates.renderTemplate(parsed, context);
      return { headers: table.headers, rows: table.rows.slice(0, 8), row_count: table.rows.length, person_count: table.person_count, warnings: [] };
    });
    await page.goto('https://payroll.test/');
    await page.evaluate((catalog) => {
      window.__APP = { userOrgId: 'org', userId: 'manager' };
      window.calls = [];
      window.FirstMateEmbeddableApps = { registerApp: () => {} };
      window.AppChrome = { registerGroup: () => {}, resolve: (_app, view) => view || 'exports', header: (o) => `<header><h2>${o.title}</h2></header>`, tabs: () => '', settings: () => '' };
      window.Portal = { currentUser: { id: 'manager', permissions: { manage_payroll: true } }, ui: { showToast: () => {} } };
      window.db = { catalog };
      window.PlatformAPI = { publication: {
        read: async (_org, source) => ({ status: 'ready', value: JSON.parse(JSON.stringify(source.export === 'export_templates' ? db.catalog : source.export === 'pay_rule_vocabulary' ? {} : [])) }),
        invoke: async (_org, action, target, input) => {
          calls.push({ action, target, input: JSON.parse(JSON.stringify(input || {})) });
          let value = {};
          if (action === 'payroll.exportTemplate.preview') value = await window.renderReport(input.definition);
          else if (action === 'payroll.exportTemplate.save') {
            const saved = { id: input.id || 'pay_export_mine', name: input.definition.name, built_in: false, based_on: input.based_on || '', revision: (input.expected_revision || 0) + 1, formats: ['csv', 'pdf'], scope: 'date_range', definition: input.definition };
            db.catalog.templates = [...db.catalog.templates.filter((entry) => entry.id !== saved.id), saved];
            value = saved;
          } else if (action === 'payroll.exportTemplate.archive') db.catalog.templates = db.catalog.templates.filter((entry) => entry.id !== target.id);
          return { receipt: { status: 'succeeded' }, value };
        } } };
    }, catalog);
    for (const script of ['apps/people/people-kit.js', 'apps/people/entity-modal.js', 'payroll-api/payroll-api.js', 'apps/payroll/app.js']) await page.addScriptTag({ url: 'https://payroll.test/libraries/' + script });
    await page.evaluate(() => {
      const report = (type, label) => ({ type, label, description: label, purpose: '', scope: 'date_range', formats: ['csv', 'pdf'] });
      PayrollAPI.artifacts.catalog = async () => ({ exports: [report('earnings_ledger', 'All earnings'), report('commissions', 'Commission report'), report('reimbursements', 'Reimbursement report')] });
      PayrollAPI.artifacts.list = async () => ({ artifacts: [] });
      PayrollAPI.artifacts.create = async (_org, payload) => { calls.push({ action: 'artifact.create', input: payload }); return { artifact: { id: 'a1', download_url: 'data:text/csv,ok' } }; };
      window.view = FirstMatePayroll.mountView({ root: document.querySelector('#host'), orgId: 'org', params: { standalone: 'exports' } });
    });
    const last = (action) => page.evaluate((name) => calls.filter((call) => call.action === name).at(-1), action);
    const own = page.locator('[data-section="own-reports"]');
    await own.waitFor();
    assert.match(await own.innerText(), /You have not made a report of your own yet/);
    await page.locator('[data-report-from]').fill('2026-07-01');
    await page.locator('[data-report-through]').fill('2026-07-31');

    // Start from the commission report: earning rows, commissions only, previewed for July.
    await own.locator('[data-report-new]').click();
    await page.locator('.pp-menu .pp-menu-item', { hasText: 'Commission report' }).click();
    const editor = page.locator('.pp-modal [data-template-editor]');
    await editor.locator('[data-tpl-preview] table').waitFor();
    assert.equal(await editor.locator('[data-tpl="rows"]').inputValue(), 'earning');
    assert.equal(await editor.locator('[data-tpl-kind="commission"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await editor.locator('[data-tpl-kind="hourly"]').getAttribute('aria-pressed'), 'false');
    const firstPreview = await last('payroll.exportTemplate.preview');
    assert.deepEqual([firstPreview.input.from, firstPreview.input.through, firstPreview.input.batch_id], ['2026-07-01', '2026-07-31', undefined]);
    assert.match(await editor.locator('[data-tpl-preview]').innerText(), /Mary Ann de la Cruz/);
    // Only the sources an earning row can fill are offered; pay run line items are not.
    const offered = await editor.locator('[data-col-source="0"] option').evaluateAll((options) => options.map((option) => option.value));
    assert.ok(offered.includes('entry.amount') && offered.includes('range.from'));
    assert.ok(!offered.includes('line.amount') && !offered.includes('reimbursement.amount'));

    // Hourly pay too, a total at the end, and a column for the first day of the dates.
    await editor.locator('[data-tpl="name"]').fill('Sales and hours');
    await editor.locator('[data-tpl-kind="hourly"]').click();
    await editor.locator('[data-tpl="totals"]').selectOption('grand');
    await editor.locator('[data-col-add]').click();
    const added = (await editor.locator('[data-col-header]').count()) - 1;
    await editor.locator(`[data-col-source="${added}"]`).selectOption('range.from');
    await page.waitForFunction(() => /Ana Lopez/.test(document.querySelector('.pp-modal [data-tpl-preview]')?.textContent || '') && /Total/.test(document.querySelector('.pp-modal [data-tpl-preview]')?.textContent || ''));
    if (shotsDir) {
      await mkdir(shotsDir, { recursive: true });
      for (const [suffix, width] of [['desktop', 1280], ['390', 390]]) { await page.setViewportSize({ width, height: 1000 }); await page.waitForTimeout(80); await page.locator('.pp-modal').screenshot({ path: path.join(shotsDir, `report-template-editor-${suffix}.png`) }); }
      await page.setViewportSize({ width: 1280, height: 1000 });
    }
    await editor.locator('[data-tpl-save]').click();
    await page.waitForFunction(() => calls.some((call) => call.action === 'payroll.exportTemplate.save'));
    const saved = (await last('payroll.exportTemplate.save')).input;
    assert.equal(saved.based_on, 'commissions');
    assert.deepEqual(saved.definition.kinds, ['hourly', 'commission']);
    assert.equal(saved.definition.totals, 'grand');
    assert.equal(saved.definition.columns.at(-1).source, 'range.from');
    assert.equal(templates.templateDefinitionSchema.safeParse(saved.definition).success, true, JSON.stringify(templates.templateDefinitionSchema.safeParse(saved.definition).error?.issues));
    await page.locator('.pp-modal').waitFor({ state: 'detached' });

    // The report is listed as the company's own, downloads for the dates as a PDF, and can be removed.
    await own.locator('[data-own-report="pay_export_mine"]').waitFor();
    assert.match(await own.innerText(), /Sales and hours[\s\S]*Your report, from Commission report/);
    if (shotsDir) {
      for (const [suffix, width] of [['desktop', 1280], ['390', 390]]) { await page.setViewportSize({ width, height: 1000 }); await page.waitForTimeout(80); await page.screenshot({ path: path.join(shotsDir, `reports-own-${suffix}.png`), fullPage: true }); }
      await page.setViewportSize({ width: 1280, height: 1000 });
    }
    await own.locator('[data-report-template="pay_export_mine"][data-format="pdf"]').click();
    await page.waitForFunction(() => calls.some((call) => call.action === 'artifact.create'));
    assert.deepEqual((await last('artifact.create')).input, { template_id: 'pay_export_mine', format: 'pdf', from: '2026-07-01', through: '2026-07-31' });
    await own.locator('[data-report-menu="pay_export_mine"]').click();
    await page.locator('.pp-menu').getByRole('menuitem', { name: 'Remove', exact: true }).click();
    await page.locator('.pp-confirm [data-confirm], .pp-pop button.danger, button:has-text("Remove")').last().click();
    await page.waitForFunction(() => calls.some((call) => call.action === 'payroll.exportTemplate.archive'));
    assert.deepEqual((await last('payroll.exportTemplate.archive')).target.id, 'pay_export_mine');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
