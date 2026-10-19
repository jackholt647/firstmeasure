// The pay sheet editor (People › a group, an outside company or a user › Pay sheets, and the company-wide list) in a
// real browser. Its server calls go to the real pay sheet functions in this process, against temporary storage seeded
// with the sample sheets, so what the editor sends is held against the server's own schema and evaluation.
// Run from public/v1 with --import tsx. PAY_SHEET_SCREENSHOTS=0 skips the screenshots in <repo>/output/pay-sheets-ui/.
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { ZodError } from 'zod';

const dir = await mkdtemp(path.join(os.tmpdir(), 'pay-sheets-editor-'));
Object.assign(process.env, { NODE_ENV:'test', PLATFORM_STORAGE_ROOT:path.join(dir, 'platform'), PRICEBOOK_STORAGE_ROOT:path.join(dir, 'pricebook'), FIRSTMEASURE_STORAGE_ROOT:path.join(dir, 'firstmeasure'), FIRSTMEASURE_INDEX_DB_PATH:path.join(dir, 'index.sqlite'), PLATFORM_HEARTBEAT_DISABLED:'1' });
const lib = (...parts) => path.resolve(import.meta.dirname, '..', '..', 'libraries', ...parts);
const shots = process.env.PAY_SHEET_SCREENSHOTS === '0' ? '' : path.resolve(import.meta.dirname, '..', '..', '..', 'output', 'pay-sheets-ui');
const ORG = 'org_ps_ui';

test('the pay sheet editor creates, edits, checks coverage, tries a project, validates, archives and duplicates, and hides itself without access', { timeout:240000 }, async () => {
  const { closePlatformFixtureStores, enableExpandedPlatformFixture } = await import('./helpers/platform-fixture.js');
  const s = await import('../platform/storage.js');
  const sheets = await import('../labor/pay-sheets.js');
  const editor = await import('../labor/pay-sheet-editor.js');
  const caps = await import('../labor/capabilities.js');
  const d = await import('../platform/publication/datasets.js');
  const workforce = await import('../workforce/storage.js'), connections = await import('../connections/storage.js');
  const { systemPublicationContext, userPublicationContext } = await import('../platform/publication/context.js');
  const { saveManualScope } = await import('../labor/scope-artifacts.js');
  let browser;
  try {
    await s.createOrganization({ id:ORG, name:'Pay sheet UI' });
    await s.saveGlobal(ORG, { data:{ app_flags:{ platform:{ expanded_access:true, materials:true } } } }, { replace:false });
    await enableExpandedPlatformFixture(ORG, { 'platform.materials':true, 'platform.pricebook':true });
    const owner = { orgId:ORG, userId:'owner', role:'owner', permissions:{} };
    await (await import('../labor/sample-pay-sheets.js')).seedInstantPaySheets(ORG, owner);
    const crewD = await workforce.createResourceGroup(ORG, { name:'Crew D', kind_id:'crew' });
    const peak = await connections.createOrganizationConnection(ORG, { name:'Peak Exteriors', relationship_type_ids:['work_provider'] });
    await caps.saveCapabilities(ORG, { assignee:{ type:'resource_group', id:String(crewD.id) }, schema_ids:['roofing'] }, owner);
    // A project with 30 squares, 6 of them steep, and work in its scope.
    await s.upsertDocument(ORG, 'projects', { id:'oak', data:{ title:'12 Oak St' } });
    const writer = systemPublicationContext({ kind:'module', organizationId:ORG, projectId:'oak', operations:['datasets.save', 'datasets.select', 'datasets.value'], mode:'command' });
    const target = { scope:'project', organizationId:ORG, projectId:'oak' };
    const dataset = await d.importMeasurementDataset(writer, target, { name:'Manual', value:{ measurements:{ roofSquares:{ value:30, unit:'roofing_square', source:'manual' }, pitch9to12Squares:{ value:6, unit:'roofing_square', source:'manual' } } } });
    await d.selectProjectDataset(writer, target, 'measurements', dataset.id, Number((await s.readDocument(ORG, 'projects', 'oak')).revision));
    const ctx = userPublicationContext({ ...owner, permissions:{ '*':true }, capabilities:{ effectiveByKey:{ 'platform.materials':true } }, applicationAccess:{ management:{ enabled:true, permissions:{ '*':true } } } }, { projectId:'oak' });
    // The price book's item types and the organization's project fields, which the pickers offer.
    const pricebook = await import('../pricebook/storage.js');
    const book = await pricebook.getOrganizationPricebook(ORG);
    await pricebook.saveOrganizationCatalog(ORG, { ...book.catalog, items:[...book.catalog.items, { id:'shingle_hdz', kind:'atomic', name:'Timberline HDZ shingles', type:'Shingles', category:'shingle_roofs', unit:'bundle', unit_price:42 }, { id:'shingle_duration', kind:'atomic', name:'Duration shingles', type:'Shingles', category:'shingle_roofs', unit:'bundle', unit_price:40 }, { id:'ps_seal_a_ridge', kind:'atomic', name:'Seal-A-Ridge cap', type:'Hip & Ridge', category:'shingle_roofs', unit:'bundle', unit_price:60 }] }, Number(book.manifest.revision));
    await s.saveBranchModule(ORG, 'default', 'custom_fields', { data:{ fields:[{ key:'pack_out_feet', path:'pack_out_feet', label:'Pack-out distance', type:'number', entity:'project' }, { key:'steep_access', path:'access.steep', label:'Steep access', type:'boolean', entity:'project' }, { key:'gate_code', path:'gate_code', label:'Gate code', type:'text', entity:'project' }] } });
    (await import('../platform/publication/bootstrap.js')).initializePublication();
    const { readPublishedData } = await import('../platform/publication/providers.js');
    const reader = (projectId) => userPublicationContext({ ...owner, permissions:{ '*':true }, capabilities:{ effectiveByKey:{ 'platform.materials':true, 'platform.pricebook':true } }, applicationAccess:{ management:{ enabled:true, permissions:{ '*':true } } } }, projectId ? { projectId } : {});
    const publicationReads = [];
    await saveManualScope(ctx, 'oak', { work:['roofing.tear_off', 'disposal.debris', 'roofing.dry_in', 'roofing.install', 'roofing.cleanup'].map((item) => ({ item })) });

    const groups = (await workforce.listResourceGroups(ORG, {})).map((row) => ({ id:String(row.id), name:String(row.name), kind_id:row.kind_id }));
    const companies = (await connections.listOrganizationConnections(ORG, {})).map((row) => ({ id:String(row.id), name:String(row.name) }));
    const group = (name) => groups.find((row) => row.name.startsWith(name));
    const company = (name) => companies.find((row) => row.name.startsWith(name));
    const summit = company('Summit'), ridgeline = company('Ridgeline'), crewA = group('Crew A');
    const stored = async () => sheets.listPaySheets(ORG);
    const sheetOf = async (id) => (await stored()).find((sheet) => sheet.subject.id === id);

    // ---- The server, as the routes call it ----
    const calls = [];
    let forceIssue = null;
    async function serverCall(method, route, body){
      try {
        const rest = route.replace(/^\/organizations\/[^/]+\//, '');
        let match;
        let data;
        if (method === 'GET' && rest === 'pay-sheets') data = { ok:true, pay_sheets:await sheets.listPaySheets(ORG) };
        else if (method === 'GET' && rest === 'pay-sheets/kinds-of-work') data = { ok:true, ...editor.paySheetKindsOfWork() };
        else if (method === 'GET' && rest === 'pay-sheets/overview') data = { ok:true, ...await editor.paySheetOverview(ORG) };
        else if (method === 'POST' && rest === 'pay-sheets') { const { id:_id, ...input } = body || {}; data = { ok:true, pay_sheet:await sheets.savePaySheet(ORG, input, owner) }; }
        else if ((match = rest.match(/^pay-sheets\/([^/]+)$/)) && method === 'PATCH') {
          if (forceIssue) { const issues = forceIssue; forceIssue = null; return { error:true, status:400, message:'validation_error', data:{ ok:false, error:'validation_error', issues } }; }
          data = { ok:true, pay_sheet:await sheets.savePaySheet(ORG, { ...body, id:decodeURIComponent(match[1]) }, owner) };
        }
        else if (match && method === 'DELETE') data = { ok:true, ...await sheets.archivePaySheet(ORG, { id:decodeURIComponent(match[1]), ...(body?.expected_revision !== undefined ? { expected_revision:body.expected_revision } : {}) }, owner) };
        else if ((match = rest.match(/^projects\/([^/]+)\/pay-sheets\/try$/)) && method === 'POST') data = { ok:true, ...await editor.tryPaySheet(ORG, decodeURIComponent(match[1]), body || {}) };
        else if ((match = rest.match(/^assignees\/([^/]+)\/([^/]+)\/capabilities$/))) data = { ok:true, capabilities:await caps.assigneeCapabilities(ORG, { type:match[1], id:decodeURIComponent(match[2]) }) };
        else return { error:true, status:404, message:'Not found', data:{ ok:false, error:'not_found' } };
        calls.push({ method, route:rest, body });
        return { data:JSON.parse(JSON.stringify(data)) };
      } catch (error) {
        if (error instanceof ZodError) return { error:true, status:400, message:'validation_error', data:{ ok:false, error:'validation_error', issues:JSON.parse(JSON.stringify(error.issues)) } };
        return { error:true, status:error.statusCode || 500, message:error.message, data:{ ok:false, error:error.code || 'error', message:error.message } };
      }
    }

    let executablePath;
    for (const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', chromium.executablePath()]) { try { await access(candidate); executablePath = candidate; break; } catch {} }
    browser = await chromium.launch({ executablePath, headless:true });
    const page = await browser.newPage({ viewport:{ width:1360, height:900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.exposeFunction('serverCall', serverCall);
    await page.exposeFunction('publicationRead', async (source) => { publicationReads.push(`${source.provider}.${source.export}`); return JSON.parse(JSON.stringify(await readPublishedData(reader(source.target?.projectId), source))); });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css"><style>:root{--primary:#d93025;--primary-readable:#c5221f;--primary-rgb:217,48,37;--on-primary:#fff}html,body{margin:0;background:#f0f2f5;font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#101828}</style></head><body><div id="loose" class="pp" style="max-width:820px;box-sizing:border-box;padding:16px;background:#fff"></div></body></html>`);
    await page.evaluate(({ org, groups, companies }) => {
      window.__APP = { userOrgId:org, userBranchId:'default' };
      window.perms = new Set(['manage_company_settings', 'manage_projects']);
      window.flags = new Set(['platform.materials']);
      window.toasts = [];
      window.Portal = { util:{ hasPerm:(key) => window.perms.has(key) }, ui:{ showToast:(title, message, ok) => window.toasts.push([title, message, ok]) } };
      window.PlatformAPI = { appFlags:{ has:(groupName, name) => window.flags.has(`${groupName}.${name}`) }, search:{ projectsAndContacts:async (_org, options) => ({ results:['12 Oak St', '40 Elm Ave'].filter((title) => title.toLowerCase().includes(String(options.q).toLowerCase())).map((title) => ({ type:'project', id:title === '12 Oak St' ? 'oak' : 'elm', project_id:title === '12 Oak St' ? 'oak' : 'elm', title, subtitle:'Springfield' })) }) } };
      PlatformAPI.publication = { read:async (_org, source) => (window.publicationDown || window.publicationDownFor === `${source.provider}.${source.export}` ? { status:'error', code:'source_failed', message:'Down' } : window.publicationRead(source)) };
      window.MaterialsAPI = { request:async (route, options = {}) => { const result = await window.serverCall(String(options.method || 'GET').toUpperCase(), route, options.body ?? null); if (result.error) { const error = new Error(result.data?.message || result.message); error.status = result.status; error.data = result.data; throw error; } return result.data; } };
      window.seed = { groups, companies };
    }, { org:ORG, groups, companies });
    for (const file of ['people-kit.js', 'list-page.js', 'entity-modal.js', 'slots.js', 'people-data.js', 'pay-sheets-model.js', 'pay-sheets-editor.js', 'pay-sheets-list.js']) await page.addScriptTag({ path:lib('apps', 'people', file) });
    await page.evaluate(() => {
      Object.assign(FirstMatePeople.data.state, { groups:seed.groups, connections:seed.companies, users:[{ id:'ana', name:'Ana Lopez', email:'ana@example.com' }], groupLabels:{ singular:'Group', plural:'Groups', connectionSingular:'Subcontractor', connectionPlural:'Subcontractors' } });
    });
    if (shots) await mkdir(shots, { recursive:true });
    const shot = async (name) => { await page.waitForTimeout(300); if (shots) await page.screenshot({ path:path.join(shots, `${name}.png`), fullPage:false }); };
    const openModal = (kind, id, name, tab = 'pay_sheets') => page.evaluate(({ kind, id, name, tab }) => {
      window.modal = FirstMatePeople.entityModal.open({ label:name, summary(host){ host.innerHTML = FirstMatePeople.kit.summary({ kind, id, name, secondary:kind === 'resource_group' ? 'Group' : 'Subcontractor' }, 'panel'); }, tabs:[{ id:'details', needs:null, label:'Details', mount(panel){ panel.textContent = 'Details'; } }, FirstMatePeople.slots.tab('pay_sheets', FirstMatePeople.slots.entity(kind, id, name), { orgId:window.__APP.userOrgId })], tab });
    }, { kind, id, name, tab });
    const closeModal = async () => { await page.evaluate(() => window.modal?.close(true)); await page.waitForFunction(() => document.querySelectorAll('.pp-modal-back').length === 0); };
    const modal = page.locator('.pp-modal');
    const save = async () => { await modal.locator('[data-modal-save]').click(); };
    const status = () => modal.locator('.pp-modal-status').innerText();

    // ---- Without company settings access, or with Materials off, there is no Pay sheets tab and no list button ----
    await page.evaluate(() => { window.perms.delete('manage_company_settings'); });
    await openModal('organization_connection', summit.id, summit.name, 'details');
    assert.equal(await modal.locator('[data-modal-tab="pay_sheets"]').count(), 0, 'no tab without company settings access');
    await closeModal();
    await page.evaluate(() => { window.perms.add('manage_company_settings'); window.flags.delete('platform.materials'); });
    await openModal('organization_connection', summit.id, summit.name, 'details');
    assert.equal(await modal.locator('[data-modal-tab="pay_sheets"]').count(), 0, 'no tab when the organization has Materials off');
    assert.deepEqual(await page.evaluate(() => [FirstMatePeople.data.allows('pay_sheets'), FirstMatePeople.data.allows('pay_sheets.edit'), FirstMatePeople.data.allows('pay_sheets.try')]), [false, false, false]);
    await closeModal();
    await page.evaluate(() => { window.flags.add('platform.materials'); window.perms.delete('manage_projects'); });
    assert.deepEqual(await page.evaluate(() => [FirstMatePeople.data.allows('pay_sheets'), FirstMatePeople.data.allows('pay_sheets.try')]), [true, false], 'trying on a project also needs project access');
    await openModal('organization_connection', summit.id, summit.name);
    await modal.locator('.pp-row').first().waitFor();
    await modal.locator('[data-row-open]').first().click();
    await modal.locator('[data-ps-editor]').waitFor();
    assert.equal(await modal.locator('[data-ps-section="try"]').count(), 0, 'no Try it section without project access');
    await closeModal();
    await page.evaluate(() => { window.perms.add('manage_projects'); });

    // ---- An outside company's sheets, listed by kind of work, and the editor reading as sentences ----
    await openModal('organization_connection', summit.id, summit.name);
    const summitSheet = await sheetOf(summit.id);
    const summitRow = modal.locator(`.pp-row[data-row-key="sheet:${summitSheet.id}"]`);
    await summitRow.waitFor();
    assert.match(await summitRow.innerText(), /Summit Roofing piece rates \(sample\)[\s\S]*Roofing[\s\S]*Pays \$95\/sq for tear off and install/);
    await shot('tab-list-desktop');
    await summitRow.locator('[data-row-open]').click();
    await modal.locator('[data-ps-editor]').waitFor();
    const summary = () => modal.locator('[data-ps-summary]').innerText();
    assert.equal(await summary(), 'Pays $95/sq for tear off and install, $8/bundle for hip & ridge cap, steep charge $15/sq on squares over 8/12 up to 12/12 and 3 more, brings a dump truck (12 yd³/load), ~1.5 days for a 30-square roof.');
    assert.match(await modal.locator('[data-ps-strip]').innerText(), /Everything accounted for/i);
    const steepLine = modal.locator('[data-ps-line]').nth(1);
    assert.equal(await steepLine.locator('[data-ps-line-field="label"]').inputValue(), 'Steep charge');
    const adjusts = steepLine.locator('.pp-pill', { hasText:'Adjusts the price' });
    assert.equal(await adjusts.count(), 1, 'a line reading part of the squares the work is measured in adjusts the price');
    assert.match(await adjusts.getAttribute('data-fm-tooltip'), /Squares over 8\/12 up to 12\/12 are part of roof squares, which is what tear off old roofing, underlayment and dry-in and install roofing is measured in/);
    assert.equal(await modal.locator('[data-ps-line]').first().locator('.pp-pill', { hasText:'Adjusts the price' }).count(), 0, 'the line on the whole squares is the pay');
    assert.equal(await steepLine.locator('[data-ps-line-field="per"] option:checked').innerText(), 'Squares over 8/12 up to 12/12');
    const visibleText = await modal.locator('[data-ps-editor]').innerText();
    for (const id of ['roof.squares', 'roofing.tear_off', 'disposal.debris', 'steep_squares', 'piece_rate', '{']) assert.equal(visibleText.includes(id), false, `no ids or code on screen (${id})`);
    assert.equal(await modal.locator('[data-ps-section="inputs"]').count(), 0, 'inputs are advanced');
    await modal.locator('[data-ps-advanced]').click();
    await modal.locator('[data-ps-section="inputs"]').waitFor();
    assert.equal(await modal.locator('[data-ps-input="pack_out_feet"] [data-ps-input-field="key"]').inputValue(), 'pack_out_feet');
    await modal.locator('[data-ps-advanced]').click();
    await shot('editor-desktop');

    // ---- Editing a pay line: the sentence follows, Save keeps the revision, the server has the new rate ----
    const firstLine = modal.locator('[data-ps-line]').first();
    await firstLine.locator('[data-ps-line-field="rate"]').fill('97.50');
    assert.match(await summary(), /^Pays \$97\.50\/sq for tear off and install/);
    assert.equal(await modal.locator('[data-modal-save]').isDisabled(), false);
    await save();
    await modal.locator('.pp-modal-status[data-state="saved"]').waitFor();
    let saved = await sheetOf(summit.id);
    assert.equal(saved.entries[0].rate_cents, 9750); assert.equal(saved.revision, summitSheet.revision + 1);
    assert.deepEqual(calls.filter((call) => call.method === 'PATCH').at(-1).body.expected_revision, summitSheet.revision, 'saved against the revision it was opened at');
    assert.deepEqual(saved.inputs.map((input) => input.name), summitSheet.inputs.map((input) => input.name), 'inputs are kept as they were');

    // ---- Coverage: taking the truck away leaves the debris open, before anything is saved ----
    await modal.locator('[data-ps-eq] [data-ps-eq-remove]').click();
    assert.match(await modal.locator('[data-ps-strip]').innerText(), /1 left open/i);
    assert.equal(await modal.locator('[data-ps-strip] .pp-chip.danger').innerText(), 'Debris disposal');
    assert.equal(await modal.locator('[data-ps-work="disposal.debris"] .pp-chip').innerText(), 'Open');
    assert.doesNotMatch(await summary(), /brings/);

    // ---- Problems are shown on their field: one seen here, one the server names ----
    await modal.locator('[data-ps-name]').fill('');
    await save();
    await modal.locator('.pp-modal-status[data-state="notice"]').waitFor();
    assert.equal(await modal.locator('[data-ps-name]').getAttribute('aria-invalid'), 'true');
    assert.match(await modal.locator('.ps-head .ps-err').innerText(), /Give the sheet a name/);
    await modal.locator('[data-ps-name]').fill('Summit 2026 rates');
    forceIssue = [{ code:'custom', path:['entries', 1, 'input'], message:'Entry Steep charge reads steep_squares, which is not a declared input.' }];
    await save();
    await modal.locator('.pp-modal-status[data-state="notice"]').waitFor();
    assert.equal(await modal.locator('[data-ps-line]').nth(1).getAttribute('class'), 'ps-line invalid');
    assert.equal(await modal.locator('[data-ps-line]').nth(1).locator('.ps-err').innerText(), 'Steep charge reads Squares over 8/12 up to 12/12, which this sheet does not have.', 'a server message, in words');
    assert.equal(await modal.locator('[data-ps-line]').nth(1).locator('[data-ps-line-field="per"]').getAttribute('aria-invalid'), 'true');
    // Going back with unsaved changes asks first, and nothing is saved.
    await modal.locator('[data-ps-back]').click();
    await page.locator('.pp-confirm [data-confirm="yes"]').click();
    await summitRow.waitFor();
    saved = await sheetOf(summit.id);
    assert.equal(saved.name, 'Summit Roofing piece rates (sample)'); assert.equal(saved.equipment.length, 1);

    // ---- Try it on a project: priced lines, what it read, a value typed for the trial, and the project's work ----
    await summitRow.locator('[data-row-open]').click();
    await modal.locator('[data-ps-try-search]').fill('oak');
    await modal.locator('[data-ps-try-pick="oak"]').click();
    await modal.locator('[data-ps-try-lines]').waitFor();
    const lines = () => modal.locator('[data-ps-try-lines]').innerText();
    assert.match(await lines(), /Tear off and install\s+30 sq × \$97\.50\s+\$2,925\.00/);
    assert.match(await lines(), /Steep charge\s+6 sq × \$15\.00\s+\$90\.00/);
    assert.match(await lines(), /Dump truck\s+Included\s+\$0\.00/);
    assert.match(await lines(), /Total\s+\$3,015\.00/);
    assert.match(await modal.locator('[data-ps-try-read] [data-ps-read="squares"]').innerText(), /30 sq · From the project's measurements/);
    assert.equal(await modal.locator('[data-ps-try-read] [data-ps-read="squares"] input').count(), 0, 'a measured project\'s measurements are not typed over');
    assert.match(await modal.locator('[data-ps-try-work]').innerText(), /Tear off old roofing · 30 sq[\s\S]*Debris disposal · 12 yd³/);
    await modal.locator('[data-ps-try-value="extra_layers"]').fill('1');
    await modal.locator('[data-ps-try-lines]', { hasText:'Extra layer tear off' }).waitFor({ timeout:5000 });
    assert.match(await lines(), /Extra layer tear off\s+1 layer × \$250\.00\s+\$250\.00[\s\S]*Total\s+\$3,265\.00/);
    // An unsaved change is tried as it stands.
    await firstLine.locator('[data-ps-line-field="rate"]').fill('100');
    await modal.locator('[data-ps-try-lines]', { hasText:'$3,000.00' }).waitFor({ timeout:5000 });
    await modal.locator('[data-ps-section="try"]').scrollIntoViewIfNeeded();
    await shot('try-desktop');
    assert.equal((await sheetOf(summit.id)).entries[0].rate_cents, 9750, 'trying never saves');
    await modal.locator('[data-ps-back]').click();
    await page.locator('.pp-confirm [data-confirm="yes"]').click();
    await closeModal();

    // ---- A new sheet for a group able to do roofing that has none ----
    await openModal('resource_group', String(crewD.id), 'Crew D');
    await modal.locator('[data-ps-capable="roofing"]').waitFor();
    assert.match(await modal.locator('[data-ps-capable="roofing"]').innerText(), /Able to do Roofing work, with no roofing pay sheet/);
    await modal.locator('.pp-list-tools [data-list-action]').click();
    await page.locator('.pp-menu-item', { hasText:'Roofing' }).click();
    await modal.locator('[data-ps-editor]').waitFor();
    assert.equal(await modal.locator('[data-ps-name]').inputValue(), 'Crew D roofing pay');
    assert.match(await modal.locator('[data-ps-status]').innerText(), /Not saved yet/);
    const starter = modal.locator('[data-ps-line]').first();
    assert.equal(await starter.locator('[data-ps-line-field="label"]').inputValue(), 'Tear off old roofing, underlayment and dry-in and install roofing');
    assert.equal(await starter.locator('[data-ps-line-field="per"] option:checked').innerText(), 'Roof squares');
    await starter.locator('[data-ps-line-field="rate"]').fill('80');
    // A line with nothing to be paid per is caught before anything is sent.
    await modal.locator('[data-ps-add-line]').click();
    const extra = modal.locator('[data-ps-line]').nth(1);
    await extra.locator('[data-ps-line-field="label"]').fill('Chimney flashing');
    const before = calls.length;
    await save();
    await modal.locator('.pp-modal-status[data-state="notice"]').waitFor();
    assert.equal(calls.length, before, 'nothing is sent while the sheet has a problem');
    assert.equal(await extra.locator('[data-ps-line-field="per"]').getAttribute('aria-invalid'), 'true');
    assert.match(await extra.locator('.ps-err').innerText(), /Choose what this line is paid per/);
    // A number typed for each job, named in plain words; the input is made for it.
    await extra.locator('[data-ps-line-field="per"]').selectOption('new:manual');
    await page.locator('.pp-form input[name="label"]').fill('Chimneys');
    await page.locator('.pp-form input[name="unit"]').fill('chimney');
    await page.locator('.pp-form [type="submit"]').click();
    await extra.locator('[data-ps-line-field="rate"]').fill('150');
    assert.match(await summary(), /Pays \$80\/sq for tear off old roofing, underlayment and dry-in and install roofing and \$150\/chimney for chimney flashing\./);
    // Material is chosen from the price book: a type (every item of it, now and later) or one item, searchable.
    await modal.locator('[data-ps-add-line]').click();
    const ridgeLine = modal.locator('[data-ps-line]').nth(2);
    await ridgeLine.locator('[data-ps-line-field="label"]').fill('Ridge cap');
    // When the price book cannot be read, it can still be typed in.
    await page.evaluate(() => { window.publicationDown = true; });
    await ridgeLine.locator('[data-ps-line-field="per"]').selectOption('new:material');
    await page.locator('.pp-form input[name="type"]').waitFor();
    await page.locator('.pp-form [data-form-cancel]').click();
    await page.evaluate(() => { window.publicationDown = false; });
    await ridgeLine.locator('[data-ps-line-field="per"]').selectOption('new:material');
    const menu = page.locator('.pp-menu');
    await menu.waitFor();
    assert.match(await menu.innerText(), /Material on the project's lists[\s\S]*Item types[\s\S]*Hip & Ridge\s*1 item[\s\S]*Shingle roofs\s*\d+ items[\s\S]*Shingles\s*2 items[\s\S]*One item[\s\S]*Duration shingles\s*Shingles[\s\S]*Seal-A-Ridge cap\s*Hip & Ridge/i, 'types by their words (a price book category reads as words), then single items');
    await shot('picker-material-desktop');
    await menu.locator('input[type="search"]').fill('ridge');
    const found = await menu.locator('.pp-menu-item:not([hidden]) .pp-menu-label').allInnerTexts();
    assert.ok(found.length >= 2 && found.length < 10 && found.every((label) => /ridge/i.test(label)) && found.includes('Hip & Ridge') && found.includes('Seal-A-Ridge cap'), `searching narrows the price book (${found.join(', ')})`);
    await menu.locator('.pp-menu-item:not([hidden])', { hasText:'Hip & Ridge' }).first().click();
    assert.equal(await ridgeLine.locator('[data-ps-line-field="per"] option:checked').innerText(), 'Hip & Ridge (on the lists)');
    assert.equal(await ridgeLine.locator('[data-ps-unit]').innerText(), '/bundle', 'counted in the unit the price book sells it in');
    await ridgeLine.locator('[data-ps-line-field="rate"]').fill('8');
    // A project field is chosen by its label from the organization's number fields; text fields are not offered.
    await modal.locator('[data-ps-add-line]').click();
    const packLine = modal.locator('[data-ps-line]').nth(3);
    await packLine.locator('[data-ps-line-field="label"]').fill('Pack out');
    await packLine.locator('[data-ps-line-field="per"]').selectOption('new:field');
    await menu.waitFor();
    assert.match(await menu.innerText(), /A project field[\s\S]*Pack-out distance\s*Number[\s\S]*Steep access\s*Yes or no/);
    assert.doesNotMatch(await menu.innerText(), /Gate code/);
    await shot('picker-field-desktop');
    await menu.locator('.pp-menu-item', { hasText:'Pack-out distance' }).click();
    assert.equal(await packLine.locator('[data-ps-line-field="per"] option:checked').innerText(), 'Pack-out distance (project field)');
    await packLine.locator('[data-ps-line-field="rate"]').fill('1');
    assert.ok(publicationReads.includes('materials-inputs.products') && publicationReads.includes('custom-fields-project.definitions'), 'both lists are read through the published data layer');
    assert.equal(publicationReads.includes('custom-fields-project.contract'), false, 'project fields are read for the organization, not from a project');
    // Where the organization read is not available, a project's own field contract stands in.
    const fallback = await page.evaluate(async () => { window.publicationDownFor = 'custom-fields-project.definitions'; try { return (await FirstMatePeople.paySheetModel.api.projectFieldChoices(window.__APP.userOrgId, 'oak')).map((field) => [field.label, field.key]); } finally { window.publicationDownFor = ''; } });
    assert.deepEqual(fallback, [['Pack-out distance', 'pack_out_feet'], ['Steep access', 'access.steep']]);
    assert.ok(publicationReads.includes('custom-fields-project.contract'));
    // Coverage before saving: the trim and the debris are open; included work closes some of it.
    assert.match(await modal.locator('[data-ps-strip]').innerText(), /6 left open/i);
    await modal.locator('[data-ps-work="roofing.cleanup"] [data-ps-work-field="included"]').check();
    await modal.locator('[data-ps-work="roofing.tear_off"] [data-ps-work-field="hours"]').fill('0.15');
    assert.match(await modal.locator('[data-ps-strip]').innerText(), /5 left open/i);
    assert.equal(await modal.locator('[data-ps-work="roofing.tear_off"] [data-ps-work-field="included"]').isDisabled(), true, 'work a line pays for is not also free');
    await modal.locator('[data-ps-duration-mode="amount"]').click();
    await modal.locator('[data-ps-duration-field="units_per_day"]').fill('15');
    assert.match(await modal.locator('[data-ps-days]').innerText(), /About 2 days for a 30-square roof/);
    await modal.locator('[data-ps-section="work"]').scrollIntoViewIfNeeded();
    await shot('new-sheet-work-desktop');
    await modal.locator('[data-ps-section="duration"]').scrollIntoViewIfNeeded();
    await shot('new-sheet-duration-desktop');
    await save();
    await modal.locator('.pp-modal-status[data-state="saved"]').waitFor();
    const made = await sheetOf(String(crewD.id));
    assert.deepEqual([made.name, made.schema_ids, made.entries.map((entry) => [entry.label, entry.kind, entry.rate_cents, entry.unit, entry.covers.length])], ['Crew D roofing pay', ['roofing'], [['Tear off old roofing, underlayment and dry-in and install roofing', 'piece_rate', 8000, 'sq', 3], ['Chimney flashing', 'piece_rate', 15000, 'chimney', 0], ['Ridge cap', 'piece_rate', 800, 'bundle', 0], ['Pack out', 'piece_rate', 100, undefined, 0]]]);
    assert.deepEqual(made.inputs.map((input) => [input.label, input.source.kind, input.required, input.default]), [['Roof squares', 'measurement', true, undefined], ['Chimneys', 'manual', false, 0], ['Hip & Ridge', 'material', false, undefined], ['Pack-out distance', 'field', false, undefined]]);
    assert.deepEqual(made.inputs.slice(2).map((input) => input.source), [{ kind:'material', item_type:'Hip & Ridge' }, { kind:'field', key:'pack_out_feet' }]);
    assert.deepEqual(made.work, [{ item:'roofing.cleanup', included:true }, { item:'roofing.tear_off', included:false, hours_per_unit:0.15 }]);
    assert.deepEqual(made.duration, { input:made.inputs[0].name, units_per_day:15 });
    assert.match(await modal.locator('[data-ps-status]').innerText(), /In use/);

    // ---- Duplicate: refused where that assignee already prices that kind of work, made where it does not ----
    await modal.locator('[data-ps-more]').click();
    await page.locator('.pp-menu-item', { hasText:'Duplicate' }).click();
    await page.locator('.pp-form select[name="assignee"]').selectOption(`resource_group:${crewA.id}`);
    await page.locator('.pp-form [type="submit"]').click();
    await page.locator('.pp-form-error', { hasText:'already covers that kind of work' }).waitFor();
    await page.locator('.pp-form select[name="assignee"]').selectOption(`organization_connection:${peak.id}`);
    await page.locator('.pp-form input[name="name"]').fill('Peak roofing rates');
    await page.locator('.pp-form [type="submit"]').click();
    await page.locator('.pp-form').waitFor({ state:'detached' });
    const copy = await sheetOf(String(peak.id));
    assert.deepEqual([copy.name, copy.schema_ids, copy.entries.length, copy.entries[0].rate_cents], ['Peak roofing rates', ['roofing'], 4, 8000]);
    assert.notEqual(copy.id, made.id);
    assert.deepEqual(await page.evaluate(() => toasts.at(-1).slice(0, 2)), ['Copy made', 'Peak roofing rates']);

    // ---- Archive ----
    await modal.locator('[data-ps-more]').click();
    await page.locator('.pp-menu-item', { hasText:'Archive' }).click();
    await page.locator('.pp-confirm [data-confirm="yes"]').click();
    await modal.locator('.pp-list-state', { hasText:'No pay sheet yet' }).waitFor();
    assert.equal(await sheetOf(String(crewD.id)), undefined);
    assert.equal(calls.filter((call) => call.method === 'DELETE').at(-1).body.expected_revision, made.revision, 'archived against the revision it was showing');
    await closeModal();

    // ---- Every sample sheet opens cleanly ----
    const vocabResponse = editor.paySheetKindsOfWork();
    const all = await stored();
    for (const sheet of all) {
      const report = await page.evaluate(({ sheet, words }) => {
        const host = document.getElementById('loose');
        const vocab = FirstMatePeople.paySheetModel.vocabulary(words);
        const handle = FirstMatePeople.paySheetEditor.mount(host, { orgId:window.__APP.userOrgId, sheet, vocab, sheets:[sheet], assigneeName:'Sample', canTry:false });
        const result = { errors:host.querySelectorAll('.ps-err').length, local:FirstMatePeople.paySheetModel.localIssues(FirstMatePeople.paySheetModel.draftOf(sheet), vocab, [sheet]).map((issue) => issue.message), summary:host.querySelector('[data-ps-summary]').innerText, dirty:handle.isDirty(), unchanged:JSON.stringify(FirstMatePeople.paySheetModel.payload(FirstMatePeople.paySheetModel.draftOf(sheet))) };
        handle.destroy();
        return result;
      }, { sheet, words:vocabResponse });
      assert.equal(report.errors, 0, `${sheet.name} opens with no problems`); assert.deepEqual(report.local, []); assert.equal(report.dirty, false, `${sheet.name} is not changed by opening it`);
      assert.match(report.summary, /^(Pays|Salaried time costs) /);
      // What the editor would send for an untouched sheet is the sheet itself.
      const sent = JSON.parse(report.unchanged);
      const parsed = sheets.paySheetInputSchema.parse(sent);
      assert.deepEqual(parsed.entries.map((entry) => [entry.label, entry.rate_cents, entry.input, entry.covers]), sheet.entries.map((entry) => [entry.label, entry.rate_cents, entry.input, entry.covers]), `${sheet.name} round-trips`);
      assert.deepEqual(parsed.inputs, sheet.inputs); assert.deepEqual(parsed.work, sheet.work); assert.deepEqual(parsed.duration ?? null, sheet.duration);
    }

    // ---- The company-wide list: by kind of work, filterable, with who is missing a sheet ----
    await page.evaluate(() => { window.listModal = FirstMatePeople.paySheets.openList({ assigneeKind:'all' }); });
    await modal.locator('.pp-list-section').first().waitFor();
    assert.equal(await modal.locator('.pp-modal-foot').isHidden(), true, 'no Save while only the list is shown');
    const listText = () => modal.locator('.pp-list').innerText();
    assert.match(await listText(), /Roofing/);
    for (const name of ['Summit Roofing', 'Ridgeline Exteriors', 'Crew A (sample)', 'Crew B (sample)', 'Crew C (sample)', 'Peak Exteriors']) assert.match(await listText(), new RegExp(name.replace(/[()]/g, '\\$&')));
    const missing = modal.locator(`.pp-row[data-row-key="missing:resource_group:${crewD.id}:roofing"]`);
    assert.match(await missing.innerText(), /Crew D[\s\S]*No pay sheet/);
    assert.match(await modal.locator('.pp-modal-summary').innerText(), /Missing a sheet\s*1/);
    await shot('list-desktop');
    await modal.locator('[data-ps-assignee-filter]').selectOption('organization_connection');
    assert.doesNotMatch(await listText(), /Crew A/); assert.match(await listText(), /Summit Roofing/);
    await modal.locator('[data-ps-assignee-filter]').selectOption('all');
    await modal.locator('.pp-list-head [data-list-search]').fill('ridge');
    await modal.locator('.pp-row').first().waitFor();
    await page.waitForTimeout(200);
    assert.equal(await modal.locator('.pp-row').count(), 1);
    await modal.locator('.pp-list-head [data-list-search]').fill('');
    await page.waitForTimeout(200);
    // A missing row opens a new sheet for that assignee and kind of work.
    await missing.locator('[data-row-open]').click();
    await modal.locator('[data-ps-editor]').waitFor();
    assert.equal(await modal.locator('.pp-modal-foot').isVisible(), true, 'Save shows once a sheet is open');
    assert.equal(await modal.locator('[data-ps-name]').inputValue(), 'Crew D roofing pay');
    await modal.locator('[data-ps-back]').click();
    await page.locator('.pp-confirm [data-confirm="yes"]').click();
    await page.evaluate(() => window.listModal.close(true)); await page.waitForFunction(() => document.querySelectorAll('.pp-modal-back').length === 0);

    // ---- Phone width ----
    await page.setViewportSize({ width:390, height:844 });
    await openModal('organization_connection', summit.id, summit.name);
    await summitRow.waitFor();
    await shot('tab-list-phone');
    await summitRow.locator('[data-row-open]').click();
    await modal.locator('[data-ps-editor]').waitFor();
    await modal.locator('[data-ps-try-search]').fill('oak');
    await modal.locator('[data-ps-try-pick="oak"]').click();
    await modal.locator('[data-ps-try-lines]').waitFor();
    const widths = await page.evaluate(() => { const panel = document.querySelector('.pp-modal-panel:not([hidden])'); const editorRoot = panel.querySelector('[data-ps-editor]'); return { page:document.documentElement.scrollWidth, panel:panel.scrollWidth, client:panel.clientWidth, wide:[...editorRoot.querySelectorAll('*')].filter((node) => node.getBoundingClientRect().right > window.innerWidth + 1 && !node.closest('[hidden]')).map((node) => node.className).slice(0, 5) }; });
    assert.ok(widths.page <= 390, `the page does not scroll sideways at 390px (${widths.page})`);
    assert.ok(widths.panel <= widths.client + 1, `the editor fits its panel (${widths.panel} > ${widths.client})`);
    assert.deepEqual(widths.wide, [], 'nothing in the editor runs off the screen');
    await modal.locator('.pp-modal-panel:not([hidden])').evaluate((panel) => { panel.scrollTop = 0; });
    await shot('editor-phone');
    await modal.locator('[data-ps-section="pay"]').scrollIntoViewIfNeeded();
    await shot('editor-phone-lines');
    await modal.locator('[data-ps-section="try"]').scrollIntoViewIfNeeded();
    await shot('try-phone');
    await modal.locator('[data-ps-add-line]').click();
    await modal.locator('[data-ps-line]').last().locator('[data-ps-line-field="per"]').selectOption('new:material');
    await menu.waitFor();
    await shot('picker-material-phone');
    await page.keyboard.press('Escape');
    await menu.waitFor({ state:'detached' });
    await closeModal();
    await page.evaluate(() => { window.listModal = FirstMatePeople.paySheets.openList({ assigneeKind:'all' }); });
    await modal.locator('.pp-list-section').first().waitFor();
    await shot('list-phone');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 390);
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await browser?.close();
    await closePlatformFixtureStores();
    await rm(dir, { recursive:true, force:true }).catch(() => {});
  }
});
