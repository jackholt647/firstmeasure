import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Export templates (docs/architecture/pay-rules.md#export-templates). The built-in templates make exactly the files the
// pay run export made before templates existed (tests/fixtures/payroll-pay-run-files.json, captured from that code on
// one pay run of employees, a contractor paid with payroll, bills, reimbursements, payments made outside a run and
// clawbacks). A company's own template chooses its columns, their order, formatting and who is in the file.
// Storage is chosen when the first module loads, so the temporary root is set before anything is imported.
const root = await mkdtemp(path.join(os.tmpdir(), 'payroll-templates-'));
Object.assign(process.env, { NODE_ENV: 'test', FIRSTMATE_ENV: 'test', PLATFORM_STORAGE_ROOT: root, FIRSTMEASURE_DATABASE_MODE: 'local', FIRSTMEASURE_INDEX_DB_PATH: path.join(root, 'index.sqlite') });
const golden = JSON.parse(await readFile(new URL('./fixtures/payroll-pay-run-files.json', import.meta.url), 'utf8'));
const templates = await import('../payroll/export-templates.js');
const range = JSON.parse(await readFile(new URL('./fixtures/payroll-date-range-reports.json', import.meta.url), 'utf8'));
const contextOf = (extra: Record<string, unknown> = {}): any => ({ batch: golden.batch, emails: new Map(Object.entries(golden.emails)), ...extra });
const parse = (definition: unknown) => templates.templateDefinitionSchema.parse(definition);
const rows = (csv: string, delimiter = ',') => csv.replace(/^﻿/, '').trim().split('\r\n').map((line) => line.split(delimiter));

test('the built-in templates make exactly the files the pay run export made before', () => {
  const payRun = templates.BUILT_IN_TEMPLATES.filter((template) => template.scope === 'pay_run');
  assert.deepEqual(payRun.map((template) => template.id), ['pay_run_summary', 'gusto_employees', 'gusto_contractors', 'quickbooks_payroll', 'quickbooks_bills']);
  for (const template of payRun) {
    const csv = templates.tableCsv(templates.renderTemplate(template.definition, contextOf()), template.definition);
    assert.equal(csv, golden.files[template.id], template.id);
  }
  // The summary keeps its PDF, with the columns it always had.
  const summary = templates.BUILT_IN_TEMPLATES[0]!;
  assert.deepEqual(summary.formats, ['csv', 'pdf']);
  assert.deepEqual(templates.renderTemplate(summary.definition, contextOf()).keys, ['section', 'name', 'hourly_cents', 'salary_cents', 'piece_rate_cents', 'commission_cents', 'adjustment_cents', 'reimbursement_cents', 'off_cycle_cents', 'taken_back_cents', 'net_cents', 'status', 'payment_reference']);
});

// The reports for a date range are templates too, and make exactly the files they made before (July 2026 of the same organization).
test('the built-in date-range reports make exactly the files they made before, and print', () => {
  const dated = templates.BUILT_IN_TEMPLATES.filter((template) => template.scope === 'date_range');
  assert.deepEqual(dated.map((template) => [template.id, template.formats.join()]), [['earnings_ledger', 'csv,pdf'], ['commissions', 'csv,pdf'], ['reimbursements', 'csv,pdf']]);
  const ctx = (projected = false): any => ({ batch: {}, emails: new Map(), range: range.range,
    entries: range.entries.filter((entry: any) => entry.eligible_at.slice(0, 10) >= range.range.from && entry.eligible_at.slice(0, 10) <= range.range.through && (projected || entry.state !== 'projected')),
    reimbursements: range.receipts.map((receipt: any) => receipt.reimbursement_request).filter((request: any) => request.id && request.requested_at.slice(0, 10) >= range.range.from && request.requested_at.slice(0, 10) <= range.range.through) });
  for (const [file, id, projected] of [['earnings_ledger', 'earnings_ledger', false], ['commissions', 'commissions', false], ['reimbursements', 'reimbursements', false], ['earnings_ledger_projected', 'earnings_ledger', true]] as const) {
    const template = dated.find((entry) => entry.id === id)!;
    assert.equal(templates.tableCsv(templates.renderTemplate(template.definition, ctx(projected)), template.definition), range.files[file], file);
  }
  // A company's report for dates: its own columns, a total, sorted by name.
  const own = parse({ name: 'Commissions by rep', rows: 'earning', kinds: ['commission'], people: ['employees'], sort: 'name', totals: 'grand',
    columns: [{ header: 'Rep', source: 'person.name' }, { header: 'Day', source: 'entry.earned_on', format: { date: 'MM/DD/YYYY' } }, { header: 'Amount', source: 'entry.amount' }, { header: 'From', source: 'range.from' }] });
  assert.deepEqual(templates.renderTemplate(own, ctx()).rows, [['Ana Lopez', '07/06/2026', '250.00', '2026-07-01'], ['Mary Ann de la Cruz', '07/06/2026', '999.99', '2026-07-01'], ['Total', '', '1249.99', '']]);
  assert.throws(() => parse({ name: 'x', rows: 'earning', people: ['employees'], columns: [{ header: 'Gross', source: 'pay.net' }] }), /one row per person of a pay run or one row per pay item/);
});

test('a company template sets its columns, their order, formatting and who is in the file', () => {
  const definition = parse({
    name: 'ADP import', rows: 'person', people: ['employees', 'bills'], sort: 'last_name', group: 'none', totals: 'grand', skip_zero: true,
    number: { thousands: true, negative: 'parentheses' }, date: 'MM/DD/YYYY', file: { type: 'csv', delimiter: 'semicolon', bom: false },
    columns: [
      { header: 'Co Code', source: 'fixed', value: 'ACM' },
      { header: 'File #', source: 'person.id' },
      { header: 'Worker', source: 'person.name' },
      { header: 'Paid through', source: 'person.paid_through' },
      { header: 'Terms', source: 'person.payment_terms' },
      { header: 'Reg Earnings', source: 'pay.hourly', format: { unit: 'cents', thousands: false } },
      { header: 'Taken off', source: 'pay.deductions' },
      { header: 'Net', source: 'pay.net' },
      { header: 'Commission', source: 'pay.commission', format: { zero: 'blank' } },
      { header: 'Check date', source: 'run.pay_date' },
      { header: 'Due', source: 'bill.due_date', format: { date: 'YYYYMMDD' } }
    ]
  });
  const csv = templates.tableCsv(templates.renderTemplate(definition, contextOf()), definition);
  assert.ok(!csv.startsWith('﻿'), 'no byte order mark when turned off');
  const table = rows(csv, ';');
  assert.deepEqual(table[0], ['Co Code', 'File #', 'Worker', 'Paid through', 'Terms', 'Reg Earnings', 'Taken off', 'Net', 'Commission', 'Check date', 'Due']);
  // Employees and bills only (Cora, paid with payroll as a contractor, is left out), all together by last name.
  assert.deepEqual(table.slice(1, -1).map((row) => row[2]), ['Cher', 'Haul Away', 'Ben "Benny" Carter', 'Mary Ann de la Cruz', 'Acme Roofing, LLC', 'Amy Lopez', 'Ana Lopez', 'Dev Patel'].map((name) => name.includes('"') ? `"${name.replace(/"/g, '""')}"` : name));
  const ana = table.find((row) => row[2] === 'Ana Lopez')!;
  assert.deepEqual(ana, ['ACM', 'u_ana', 'Ana Lopez', 'Payroll', '', '123456', '(300.00)', '1,226.56', '250.00', '07/10/2026', '20260710']);
  const acme = table.find((row) => row[2] === 'Acme Roofing, LLC')!;
  assert.deepEqual(acme, ['ACM', 'conn_acme_roofing', 'Acme Roofing, LLC', 'Payables', 'Net 30', '0', '(100.00)', '7,915.00', '', '07/10/2026', '20260809']);
  const total = table[table.length - 1]!;
  assert.equal(total[2], 'Pay run total'); assert.equal(total[7], '13,542.06', 'the grand total adds up the people shown');
});

test('pay item rows rename their items, and a person-row template cannot use pay item columns', () => {
  const definition = parse({
    name: 'Bills, renamed', rows: 'pay_item', pay_items: 'work_and_reimbursement', people: ['bills'], pay_item_labels: { work: 'Subcontract labor', reimbursements: 'Job materials' },
    columns: [{ header: 'Vendor', source: 'person.name' }, { header: 'Account', source: 'line.label' }, { header: 'Code', source: 'line.key' }, { header: 'Amount', source: 'line.amount' }]
  });
  const table = templates.renderTemplate(definition, contextOf());
  assert.deepEqual(table.rows, [['Acme Roofing, LLC', 'Subcontract labor', 'work', '7900.00'], ['Acme Roofing, LLC', 'Job materials', 'reimbursements', '15.00'], ['Dev Patel', 'Subcontract labor', 'work', '580.00'], ['Haul Away', 'Subcontract labor', 'work', '120.00']]);
  assert.throws(() => parse({ name: 'x', rows: 'person', people: ['employees'], columns: [{ header: 'Item', source: 'line.label' }] }), /one row per pay item/);
  assert.throws(() => parse({ name: 'x', rows: 'pay_item', people: ['employees'], totals: 'sections', columns: [{ header: 'A', source: 'person.name' }] }), /Totals need one row per person/);
  assert.throws(() => parse({ name: 'x', rows: 'person', people: ['employees'], columns: [{ header: 'A', source: 'person.field' }] }), /Choose which custom field/);
  assert.throws(() => parse({ name: 'x', rows: 'person', people: [], columns: [{ header: 'A', source: 'person.name' }] }));
});

test('branches, departments, approved hours and custom fields come from what the template reads', () => {
  const definition = parse({ name: 'Detail', rows: 'person', people: ['employees'], columns: [{ header: 'Name', source: 'person.name' }, { header: 'Branch', source: 'person.branch' }, { header: 'Department', source: 'person.department' }, { header: 'Hours', source: 'person.hours' }, { header: 'Emp #', source: 'person.field', field: 'employee_number' }] });
  const table = templates.renderTemplate(definition, contextOf({
    people: new Map([['organization_user:u_ana', { branches: ['Main branch', 'North yard'], departments: ['Roofing'] }]]),
    hours: new Map([['u_ana', 37.5 * 3600]]), fields: new Map([['u_ana', { employee_number: 'E-0042' }]])
  }));
  assert.deepEqual(table.rows.find((row) => row[0] === 'Ana Lopez'), ['Ana Lopez', 'Main branch; North yard', 'Roofing', '37.50', 'E-0042']);
  assert.deepEqual(table.rows.find((row) => row[0] === 'Cher'), ['Cher', '', '', '0.00', '']);
  assert.equal(templates.EXPORT_SOURCES.every((source) => source.label && source.description && source.group), true, 'every source says what it is');
});

test('templates are stored per organization, previewed, used for files, gated by payroll management and branch scope', async (t) => {
  const core = await import('../platform/storage.js'), store = await import('../payroll/storage.js'), service = await import('../payroll/service.js');
  const { saveCapabilityValues } = await import('../platform/capabilities.js'), { userPublicationContext } = await import('../platform/publication/context.js');
  const { readPublishedData } = await import('../platform/publication/providers.js');
  const { invokeAction } = await import('../platform/publication/actions.js');
  const org = 'org_templates';
  try {
    await core.createOrganization({ id: org, name: 'Templates' });
    await saveCapabilityValues(org, { 'platform.expanded_access': true, 'apps.payroll': true, 'payroll.pay_runs': true, 'platform.money': true });
    await core.upsertDocument(org, 'users', { id: 'alice', data: { name: 'Alice Archer', email: 'alice@example.com', status: 'active', worker_classification: 'employee', custom_fields: { employee_number: 'E-1' } } });
    await core.upsertDocument(org, 'users', { id: 'bob', data: { name: 'Bob Builder', email: 'bob@example.com', status: 'active', worker_classification: 'employee', branch_id: 'north', custom_fields: { employee_number: 'E-2' } } });
    const caps = { effectiveByKey: { 'apps.payroll': true, 'payroll.pay_runs': true } };
    const auth = (userId: string, permissions: Record<string, boolean>, extra: Record<string, unknown> = {}): any => ({ orgId: org, userId, role: 'member', user: { id: userId, name: userId }, permissions, applicationAccess: { management: { enabled: true, permissions: { '*': true } } }, capabilities: caps, ...extra });
    const manager = auth('alice', { manage_payroll: true, manage_company_settings: true });
    const command = userPublicationContext(manager, { mode: 'command' }), target = { scope: 'organization' as const, organizationId: org };
    (await import('../platform/publication/bootstrap.js')).initializePublication();
    let key = 0;
    const run = async (ctx: any, action: string, input: any = {}, id?: string) => (await invokeAction(ctx, { action, target: { ...target, ...(id ? { id } : {}) } }, input, { idempotencyKey: `${action}:${++key}` })).value as any;
    const schedule = await store.createPayrollSchedule(org, { name: 'Weekly', recurrence: { frequency: 'weekly', weekday: 5 } } as any);
    await (await import('../payroll/pay-rules.js')).savePayDefault(org, { subject: { type: 'organization', id: org }, entries: [], schedules: [{ effective_from: '2026-01-01', schedule_id: schedule.id }] }, { userId: 'alice' } as any);
    for (const [id, name, cents] of [['alice', 'Alice Archer', 150000], ['bob', 'Bob Builder', 90000]] as const) await service.recordPayrollLedgerEntries(org, [{ payee: { type: 'organization_user', id, name }, schedule_id: schedule.id, kind: 'hourly', state: 'accrued', amount_cents: cents, currency: 'USD', worked_at: '2026-07-06T15:00:00.000Z', source_event_id: `hours-${id}` } as any]);
    const batch = (await run(command, 'payroll.batch.create', { schedule_id: schedule.id, pay_date: '2026-07-10' })).batch;
    const csvOf = async (artifactId: string) => (await store.readPayrollArtifact(org, artifactId, true) as any).content.toString('utf8');
    const definition = { name: 'Paychex', rows: 'person', people: ['employees'], columns: [{ header: 'Employee ID', source: 'person.field', field: 'employee_number' }, { header: 'Gross', source: 'pay.hourly' }] };
    let saved: any, firstFile: any;

    await t.test('the list holds the built-in templates and every source a column can use', async () => {
      const catalog = (await readPublishedData(userPublicationContext(manager), { provider: 'payroll', export: 'export_templates', target }) as any).value;
      assert.deepEqual(catalog.templates.map((row: any) => [row.id, row.built_in, row.scope]), [['pay_run_summary', true, 'pay_run'], ['gusto_employees', true, 'pay_run'], ['gusto_contractors', true, 'pay_run'], ['quickbooks_payroll', true, 'pay_run'], ['quickbooks_bills', true, 'pay_run'], ['earnings_ledger', true, 'date_range'], ['commissions', true, 'date_range'], ['reimbursements', true, 'date_range']]);
      assert.deepEqual(catalog.sources.find((source: any) => source.id === 'entry.amount').rows, ['earning']);
      assert.ok(catalog.sources.some((source: any) => source.id === 'person.field' && source.needs === 'field'));
      assert.deepEqual(catalog.date_formats, ['YYYY-MM-DD', 'MM/DD/YYYY', 'M/D/YYYY', 'DD/MM/YYYY', 'YYYYMMDD']);
    });

    await t.test('a saved template is the organization’s, with a revision; a built-in cannot be changed', async () => {
      saved = await run(command, 'payroll.exportTemplate.save', { based_on: 'gusto_employees', definition });
      assert.match(saved.id, /^pay_export_/); assert.equal(saved.revision, 1); assert.equal(saved.based_on, 'gusto_employees'); assert.equal(saved.built_in, false);
      await assert.rejects(run(command, 'payroll.exportTemplate.save', { id: 'gusto_employees', definition }), /does not match|Invalid|built-in/);
      await assert.rejects(run(command, 'payroll.exportTemplate.save', { id: saved.id, expected_revision: 9, definition }), /changed this export template/);
      const listed = (await readPublishedData(userPublicationContext(manager), { provider: 'payroll', export: 'export_templates', target }) as any).value.templates;
      assert.equal(listed.at(-1).id, saved.id);
    });

    await t.test('a preview shows the first rows of a pay run without saving anything', async () => {
      const before = (await store.listPayrollArtifacts(org)).length;
      const preview = await run(userPublicationContext(manager), 'payroll.exportTemplate.preview', { batch_id: batch.id, definition: { ...definition, columns: [...definition.columns, { header: 'Note', source: 'fixed', value: 'July' }] } });
      assert.deepEqual(preview.headers, ['Employee ID', 'Gross', 'Note']);
      assert.deepEqual(preview.rows, [['E-1', '1500.00', 'July'], ['E-2', '900.00', 'July']]);
      assert.equal(preview.row_count, 2);
      assert.equal((await store.listPayrollArtifacts(org)).length, before);
      assert.deepEqual((await run(userPublicationContext(manager), 'payroll.exportTemplate.preview', { batch_id: batch.id, template_id: saved.id, limit: 1 })).rows, [['E-1', '1500.00']]);
    });

    await t.test('a file made from a template records it, and later changes to the template leave the file as it was', async () => {
      firstFile = await run(command, 'payroll.artifact.generate', { template_id: saved.id, batch_id: batch.id });
      assert.equal(firstFile.report_type, 'pay_run_template'); assert.equal(firstFile.metadata.template.id, saved.id); assert.equal(firstFile.metadata.template.revision, 1);
      assert.match(firstFile.file_name, /^Paychex - Weekly - pay date Jul 10, 2026 - Generated/);
      const original = await csvOf(firstFile.id);
      assert.equal(original, '﻿Employee ID,Gross\r\nE-1,1500.00\r\nE-2,900.00\r\n');
      const changed = await run(command, 'payroll.exportTemplate.save', { id: saved.id, expected_revision: 1, definition: { ...definition, name: 'Paychex', columns: [{ header: 'Gross pay', source: 'pay.hourly', format: { unit: 'cents' } }] } });
      assert.equal(changed.revision, 2);
      const second = await run(command, 'payroll.artifact.generate', { template_id: saved.id, batch_id: batch.id });
      assert.notEqual(second.id, firstFile.id); assert.equal(second.metadata.template.revision, 2);
      assert.equal(await csvOf(second.id), '﻿Gross pay\r\n150000\r\n90000\r\n');
      assert.equal(await csvOf(firstFile.id), original, 'the earlier file is unchanged');
      // The same template on the same pay run gives the same file back.
      assert.equal((await run(command, 'payroll.artifact.generate', { template_id: saved.id, batch_id: batch.id })).id, second.id);
      // A built-in file is made by its template too.
      const gusto = await run(command, 'payroll.artifact.generate', { type: 'gusto_employees', format: 'csv', batch_id: batch.id });
      assert.equal(gusto.metadata.template.id, 'gusto_employees'); assert.equal(gusto.report_type, 'gusto_employees');
      const summaryPdf = await run(command, 'payroll.artifact.generate', { type: 'pay_run_summary', format: 'pdf', batch_id: batch.id });
      assert.equal(summaryPdf.content_type, 'application/pdf');
    });

    await t.test('a private custom field is left blank for someone who may not read it', async () => {
      await core.saveBranchModule(org, 'default', 'custom_fields', { data: { fields: [{ entity: 'user', path: 'employee_number', key: 'employee_number', label: 'Employee number', type: 'text', private: true }] } });
      const numbers = { name: 'Numbers', rows: 'person', people: ['employees'], columns: [{ header: 'Name', source: 'person.name' }, { header: 'Emp #', source: 'person.field', field: 'employee_number' }] };
      const payrollOnly = auth('alice', { manage_payroll: true });
      const hidden = await run(userPublicationContext(payrollOnly), 'payroll.exportTemplate.preview', { batch_id: batch.id, definition: numbers });
      assert.deepEqual(hidden.rows, [['Alice Archer', ''], ['Bob Builder', '']]);
      assert.match(hidden.warnings.join(' '), /employee_number is private/);
      const shown = await run(userPublicationContext(manager), 'payroll.exportTemplate.preview', { batch_id: batch.id, definition: numbers });
      assert.deepEqual(shown.rows, [['Alice Archer', 'E-1'], ['Bob Builder', 'E-2']]);
    });

    await t.test('only payroll managers see, save or use templates, and a branch-limited viewer previews only their branch', async () => {
      const crew = userPublicationContext(auth('bob', {}), { mode: 'command' });
      assert.equal((await readPublishedData(userPublicationContext(auth('bob', {})), { provider: 'payroll', export: 'export_templates', target }) as any).status, 'denied');
      await assert.rejects(run(crew, 'payroll.exportTemplate.save', { definition }));
      await assert.rejects(run(crew, 'payroll.exportTemplate.preview', { batch_id: batch.id, template_id: saved.id }));
      await assert.rejects(run(crew, 'payroll.artifact.generate', { template_id: saved.id, batch_id: batch.id }));
      const structure = { branches: [{ id: 'default', status: 'active' }, { id: 'north', status: 'active' }], catalog: { regions: [] }, users: [{ id: 'alice', branch_ids: ['default'] }, { id: 'bob', branch_ids: ['north'] }], groups: [], connections: [] };
      const local = auth('alice', { manage_payroll: true }, { organizationStructure: structure, user: { id: 'alice', name: 'Alice', branch_id: 'default' }, capabilities: { effectiveByKey: { ...caps.effectiveByKey, 'platform.multiple_branches': true } } });
      const preview = await run(userPublicationContext(local), 'payroll.exportTemplate.preview', { batch_id: batch.id, definition: { name: 'Names', rows: 'person', people: ['employees'], columns: [{ header: 'Name', source: 'person.name' }] } });
      assert.deepEqual(preview.rows, [['Alice Archer']]);
    });

    await t.test('a removed template is no longer offered or used', async () => {
      const current = (await readPublishedData(userPublicationContext(manager), { provider: 'payroll', export: 'export_templates', target }) as any).value.templates.find((row: any) => row.id === saved.id);
      await run(command, 'payroll.exportTemplate.archive', { expected_revision: current.revision }, saved.id);
      assert.equal((await readPublishedData(userPublicationContext(manager), { provider: 'payroll', export: 'export_templates', target }) as any).value.templates.some((row: any) => row.id === saved.id), false);
      await assert.rejects(run(command, 'payroll.artifact.generate', { template_id: saved.id, batch_id: batch.id }), /was removed/);
      await assert.rejects(run(command, 'payroll.exportTemplate.archive', { expected_revision: 1 }, 'gusto_employees'), /cannot be removed/);
      assert.ok(await csvOf(firstFile.id), 'files made from it stay');
    });
  } finally {
    await (await import('./helpers/platform-fixture.js')).closePlatformFixtureStores();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
