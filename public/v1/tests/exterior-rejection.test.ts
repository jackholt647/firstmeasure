// FM-410: a rejected report says why in the left column. A Full Exterior turned down for its footage offers a
// retry with more footage or the roof alone, as new orders; coverage gaps offer no reorder; roofs keep their copy.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const api = await readFile(new URL('../firstmeasure/api.ts', import.meta.url), 'utf8');
const measurements = await readFile(new URL('../../libraries/apps/measurements/project.js', import.meta.url), 'utf8');
const request = await readFile(new URL('../../libraries/apps/project-request/app.js', import.meta.url), 'utf8');
const exteriors = await readFile(new URL('../firstmeasure/exteriors.ts', import.meta.url), 'utf8');
const viewer = await readFile(new URL('../../libraries/apps/projects/viewer.js', import.meta.url), 'utf8');

// The source of one top-level function, by name.
function fn(source: string, name: string){
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  let depth = 0;
  for (let i = source.indexOf('{', source.indexOf(')', start)); i < source.length; i++){
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(name);
}
const transpile = (code: string) => ts.transpileModule(code, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
const badRequest = (code: string, message: string) => Object.assign(new Error(message), {code});
const isCustomerExteriorId = (value: unknown) => /^exteriors_[a-f0-9]{32}$/.test(String(value ?? ''));
const EXTERIOR = 'exteriors_' + 'e'.repeat(32);
// The rejection copy and email functions, runnable.
function rejectionCopy(){
  const ctx = vm.createContext({asRecord: (x: any) => x && typeof x === 'object' ? x : {}, isCustomerExteriorId, URL,
    escapeHtml: (s: string) => s});
  const names = ['buildRejectionMessageParagraphs', 'isFullExteriorRejection', 'fullExteriorRejectionParagraphs', 'rejectionEmailTitle',
    'rejectionEmailFootageAction', 'buildRejectionRefundText', 'buildRejectionEmailTextBody', 'buildRejectionEmailHtmlBody',
    'fullExteriorUnofferedProjectType', 'rejectionEmailReorderUrl', 'normalizeStructureReorderProjectType', 'projectTypeLabelForCustomer'];
  vm.runInContext(transpile([api.match(/const APP_ORDER_REPORT_URL = [^;]+;/)![0], exteriors.match(/export const fullExteriorOffered = [^;]+;/)![0].replace('export ', ''),
    ...names.map((name) => fn(api, name))].join('\n')), ctx);
  return (expression: string) => vm.runInContext(expression, ctx);
}

test('staff can reject a Full Exterior for insufficient footage, and the customer is told how to try again', () => {
  assert.match(api.slice(api.indexOf('const DEFAULT_REJECTION_REASONS'), api.indexOf('let rejectionReasonsCache')), /id: "insufficient_footage"/);
  const run = rejectionCopy();
  const footage = run('buildRejectionMessageParagraphs({rejection_reason:"insufficient_footage",measurement_scope:"full_house"})').join(' ');
  assert.match(footage, /Full Exterior report because the photos and video do not show enough of the house/);
  assert.match(footage, /wider view of the house and more photos of each side, or order just the roof report/);
  // A roof rejected for coverage keeps its coverage copy: nothing to reorder.
  assert.match(run('buildRejectionMessageParagraphs({rejection_reason:"no_height_map"})').join(' '), /do not currently have coverage for this address/);
});

// FM-532: footage of another house than the order's address.
test('staff can reject a Full Exterior for incorrect footage, and the customer can upload the right footage', () => {
  assert.match(api.slice(api.indexOf('const DEFAULT_REJECTION_REASONS'), api.indexOf('let rejectionReasonsCache')), /id: "incorrect_footage", label: "Incorrect footage uploaded"/);
  const run = rejectionCopy();
  const copy = run(`buildRejectionMessageParagraphs({rejection_reason:"incorrect_footage",id:"${EXTERIOR}"})`).join(' ');
  assert.match(copy, /Full Exterior report because the uploaded footage doesn't seem to match the provided address/);
  assert.match(copy, /upload footage of the correct house, or order just the roof report/);
});

// FM-532: a Full Exterior's rejection email was the roof report's ("Unable to complete roof report", roof copy).
test('a Full Exterior rejection email says Full Exterior, in Full Exterior words; a roof email is unchanged', () => {
  const run = rejectionCopy();
  const exterior = (reason: string) => JSON.stringify({id: EXTERIOR, address: '11517 155th Ave SE', rejection_reason: reason, refund_issued: true, refund_amount: 25});
  for (const reason of ['no_satellite_image', 'no_height_map', 'obscured_visibility', 'invalid_pin_placement', 'insufficient_footage', 'incorrect_footage']) {
    const text = run(`buildRejectionEmailTextBody(${exterior(reason)})`);
    assert.match(text, /^Unable to complete Full Exterior report\n/, reason);
    assert.match(text, /Full Exterior report because/, reason);
    assert.doesNotMatch(text, /Unable to complete roof report/, reason);
    assert.match(text, /A credit of \$25 has been refunded/, reason);
    assert.match(run(`buildRejectionEmailHtmlBody(${exterior(reason)})`), /font-weight:700;">Unable to complete Full Exterior report<\/p>/, reason);
  }
  assert.match(run(`buildRejectionEmailTextBody(${exterior('no_satellite_image')})`), /aerial imagery coverage for this address/);
  // Ben's review (FM-532): the coverage copy no longer explains how a Full Exterior uses aerial imagery.
  assert.doesNotMatch(run(`buildRejectionEmailTextBody(${exterior('no_satellite_image')})`), /measures the roof from aerial imagery|as well as your footage/);
  // A footage reason links to the project, whose card starts the new order.
  const link = `https://app.1m8.ai/portal/?tab=viewer&project=${EXTERIOR}`;
  assert.ok(run(`buildRejectionEmailTextBody(${exterior('incorrect_footage')})`).includes(`Upload the correct footage: ${link}`));
  assert.ok(run(`buildRejectionEmailHtmlBody(${exterior('incorrect_footage')})`).includes(`href="${link}"`));
  assert.ok(run(`buildRejectionEmailTextBody(${exterior('insufficient_footage')})`).includes(`Try again with more footage: ${link}`));
  assert.doesNotMatch(run(`buildRejectionEmailTextBody(${exterior('no_satellite_image')})`), /https:/);
  // A roof keeps its title and coverage copy, without a link.
  const roof = run('buildRejectionEmailTextBody({id:"roof_fixture",address:"1 Main St",rejection_reason:"no_satellite_image"})');
  assert.match(roof, /^Unable to complete roof report\n/);
  assert.match(roof, /We do not currently have coverage for this address/);
  assert.doesNotMatch(roof, /Full Exterior|https:/);
  // The subject is the title.
  assert.match(fn(api, 'sendProjectRejectionEmail'), /const subject = `\$\{rejectionEmailTitle\(legacy\)\} - \$\{address\}`;/);
});

// FM-532 review: no Full Exterior can be ordered for a commercial or multi-family building (the order form and
// requireExteriorAccess offer it for residential only), so one rejected as that type says so and links no reorder.
test('a Full Exterior rejected as commercial says we do not offer them, with no reorder; a roof still reorders', () => {
  assert.match(fn(exteriors, 'requireExteriorAccess'), /!fullExteriorOffered\(projectType\)/);
  const run = rejectionCopy();
  const stored = {reorder_url: 'https://app.1m8.ai/portal/?reorder=1', rejection_reorder: {url: 'https://app.1m8.ai/portal/?reorder=1'}};
  for (const [type, label] of [['commercial', 'commercial'], ['multifamily', 'multi-family']]) {
    const order = JSON.stringify({id: EXTERIOR, address: '1 Main St', rejection_reason: 'incorrect_structure_type', correct_project_type: type, ...stored});
    assert.deepEqual([...run(`buildRejectionMessageParagraphs(${order})`)], [`It seems to be a ${label} building and we currently don't offer exterior reports for ${label} buildings.`]);
    const text = run(`buildRejectionEmailTextBody(${order})`);
    assert.match(text, /^Unable to complete Full Exterior report\n/);
    assert.doesNotMatch(text, /https:|Reorder/, type);
    assert.doesNotMatch(run(`buildRejectionEmailHtmlBody(${order})`), /href=|Reorder/, type);
  }
  const roof = JSON.stringify({id: 'roof_fixture', address: '1 Main St', rejection_reason: 'incorrect_structure_type', correct_project_type: 'commercial', project_type: 'residential', ...stored});
  assert.match(run(`buildRejectionEmailTextBody(${roof})`), /Reorder this project: https:\/\/app\.1m8\.ai\/portal\/\?reorder=1/);
  assert.match(run(`buildRejectionEmailHtmlBody(${roof})`), />Reorder as commercial<\/a>/);
  // The reject route stores no reorder link for it, and its customer copy is the same sentence.
  const reject = fn(api, 'rejectCoverageProject');
  assert.match(reject, /if \(fullExteriorUnofferedProjectType\(unoffered\)\) \{\s*rejectionPatch\.customer_rejection_message = buildRejectionMessageParagraphs\(unoffered\)\.join\(" "\);\s*\} else \{\s*rejectionPatch\.reorder_project_type/);
  assert.equal(reject.match(/rejectionPatch\.reorder_url = /g)?.length, 1);
});

test('footage reasons are refused for a roof order', async () => {
  const code = `const FULL_EXTERIOR_REJECTION_REASONS = ${api.match(/const FULL_EXTERIOR_REJECTION_REASONS = (new Set\([^)]*\));/)![1]};\n${fn(api, 'rejectCoverageProject')}`;
  for (const [reason, scope, refused] of [['insufficient_footage', undefined, true], ['insufficient_footage', 'full_house', false],
    ['incorrect_footage', undefined, true], ['incorrect_footage', 'full_house', false]] as const) {
    const ctx = vm.createContext({
      withPublicFirstMeasureLock: (_key: string, run: any) => run(),
      resolveRejectionReasonId: async (x: any) => x,
      readManifest: async () => ({id: 'fixture', status: 'processing', measurement_scope: scope}),
      buildLegacyManifest: (x: any) => x,
      normalizeOptionalPortalActor: () => { throw Object.assign(new Error('passed the guard'), {code: 'passed'}); },
      badRequest,
    });
    vm.runInContext(transpile(code), ctx);
    await assert.rejects(vm.runInContext(`rejectCoverageProject("fixture",{rejection_reason:"${reason}"})`, ctx), {code: refused ? 'invalid_rejection_reason' : 'passed'});
  }
});

test('a rejected Full Exterior is never reopened in place', async () => {
  const code = fn(api, 'reopenRejectedProjectForReorder');
  for (const [id, scope, expected] of [
    ['exteriors_' + 'a'.repeat(32), 'full_house', 'exterior_reorder_requires_new_order'],
    ['exteriors_' + 'b'.repeat(32), undefined, 'exterior_reorder_requires_new_order'],
    ['roof-fixture', undefined, 'passed'],
  ] as const) {
    const ctx = vm.createContext({
      readManifest: async () => ({id, status: 'rejected_no_coverage', measurement_scope: scope}),
      isCustomerExteriorId: (value: unknown) => /^exteriors_[a-f0-9]{32}$/.test(String(value ?? '')),
      toSqlDateString: () => { throw Object.assign(new Error('passed the guard'), {code: 'passed'}); },
      badRequest,
    });
    vm.runInContext(transpile(code), ctx);
    await assert.rejects(vm.runInContext(`reopenRejectedProjectForReorder(${JSON.stringify(id)},{},{})`, ctx), {code: expected});
  }
});

// The left column's rejected report card, rendered from the real functions with the project as state.
function renderRejected(project: Record<string, any>, {exteriorsOffered = true, summary = false} = {}){
  const names = ['rejectionReasonLabel', 'rejectedReportHtml', 'reportOrderReorderType', 'normalizeProjectTypeLabel',
    'customerRejectionCopy', 'fallbackCustomerRejectionCopy', 'reportOrderMeasurement', 'reportOrderManifest', 'reportOrderIsExterior',
    'rejectedExteriorUnofferedType', 'rejectionDetails', 'rejectionSummarySectionHtml'];
  const body = [
    'let activeBaseProject = project, selectedType = project.project_type || "residential";',
    'const reportOrderExpediteKey = () => String(reportOrderMeasurement().report_expedite_option || "");',
    'const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");',
    'const fmtCredit = (n) => "$" + n;',
    ...names.map((name) => fn(measurements, name)),
    'const reportOrderIsRejected = () => true;',
    'return summary ? rejectionSummarySectionHtml() : rejectedReportHtml();',
  ].join('\n');
  const window = {Portal: {ExteriorOrder: {offersChoice: (type: string) => exteriorsOffered && type === 'residential'}}};
  const html = new Function('project', 'window', 'globalThis', 'summary', body)(project, window, {}, summary);
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const unescape = (value: string) => value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  const tooltip = (attrs: string) => unescape(attrs.match(/data-fm-tooltip="([^"]*)"/)?.[1] ?? '');
  const buttons = [...html.matchAll(/<button([^>]*?(data-reorder-[\w-]+(?:="[^"]*")?)[^>]*)>([\s\S]*?)<\/button>/g)].map((m: any) => `${m[2]} ${m[3].replace(/<[^>]+>/g, '').trim()}`);
  const tips = [...html.matchAll(/<button([^>]*?data-reorder-[^>]*)>/g)].map((m: any) => tooltip(m[1]));
  const why = tooltip(html.match(/<button([^>]*data-rejection-why[^>]*)>/)?.[1] ?? '');
  return {html, text, buttons, tips, why};
}
const rejected = (scope: 'roof' | 'full_house', reason: string, extra: Record<string, any> = {}) => ({
  id: 'project_fixture', project_type: 'residential', refund_amount: 0,
  measurement_project: {id: scope === 'full_house' ? 'exteriors_' + 'c'.repeat(32) : 'roof_fixture', status: 'rejected_no_coverage',
    rejection_reason: reason, ...(scope === 'full_house' ? {measurement_scope: 'full_house'} : {}), ...extra},
});

test('a Full Exterior rejected for footage says so and offers more footage or the roof alone', () => {
  const card = renderRejected(rejected('full_house', 'insufficient_footage'));
  // Title, reason and buttons only (FM-410 review): every explanation is a tooltip, never a loose paragraph.
  assert.equal(card.text, 'Full Exterior report rejected Reason Not enough footage of the house Try again with more footage Order just the roof');
  assert.doesNotMatch(card.html, /<p>|r-pending-note/);
  assert.match(card.why, /photos and video do not show enough of the house/);
  assert.deepEqual(card.buttons, ['data-reorder-rejected-exterior="full_house" Try again with more footage', 'data-reorder-rejected-exterior="roof" Order just the roof']);
  assert.match(card.tips[0] ?? '', /whole house in view/);
  assert.match(card.tips[1] ?? '', /aerial imagery and needs no photos/);
  // With Full Exterior off for the organization, only the roof is offered.
  assert.deepEqual(renderRejected(rejected('full_house', 'insufficient_footage'), {exteriorsOffered: false}).buttons, ['data-reorder-rejected-exterior="roof" Order just the roof']);
});

test('coverage, visibility and pin rejections show their reason and offer no reorder, roof or exterior', () => {
  for (const scope of ['roof', 'full_house'] as const) {
    for (const [reason, label] of <Array<[string, string]>>[['no_height_map', 'No imagery coverage'], ['no_satellite_image', 'No imagery coverage'], ['obscured_visibility', 'hidden in the imagery'], ['invalid_pin_placement', 'pin is not on a structure']]) {
      const card = renderRejected(rejected(scope, reason, {customer_rejection_message: 'Server copy.'}));
      assert.match(card.text, new RegExp(`^${scope === 'full_house' ? 'Full Exterior report' : 'Report'} rejected Reason [^.]*${label}`), `${scope} ${reason}`);
      assert.equal(card.why, 'Server copy.');
      assert.doesNotMatch(card.text, /Server copy/);
      assert.deepEqual(card.buttons, [], `${scope} ${reason}`);
    }
  }
});

test('a wrong project type still reorders as the right one', () => {
  const card = renderRejected(rejected('roof', 'incorrect_structure_type', {correct_project_type: 'commercial'}));
  assert.match(card.text, /Reason It needs a different project type/);
  assert.deepEqual(card.buttons, ['data-reorder-rejected-report Reorder as Commercial']);
  assert.match(card.tips[0] ?? '', /new order/);
  // A refund is told in the reason's tooltip, not as another row.
  const refunded = renderRejected({...rejected('roof', 'incorrect_structure_type', {correct_project_type: 'commercial'}), refund_amount: 30});
  assert.match(refunded.why, /\$30 returned to credits$/);
  assert.doesNotMatch(refunded.text, /returned to credits/);
});

test('the reason tooltip also opens on a tap (phones have no hover)', () => {
  assert.match(fn(measurements, 'showRejectionWhy'), /PlatformUI\?\.showTooltip\?\.\(/);
  assert.match(measurements, /\[data-rejection-why\][\s\S]{0,200}showRejectionWhy\(button\)/);
});

test('a Full Exterior rejected for incorrect footage offers to upload the right footage, or the roof alone', () => {
  const card = renderRejected(rejected('full_house', 'incorrect_footage'));
  assert.equal(card.text, 'Full Exterior report rejected Reason Incorrect footage uploaded Upload the correct footage Order just the roof');
  assert.match(card.why, /uploaded footage doesn't seem to match the provided address/);
  assert.deepEqual(card.buttons, ['data-reorder-rejected-exterior="full_house" Upload the correct footage', 'data-reorder-rejected-exterior="roof" Order just the roof']);
  assert.match(card.tips[0] ?? '', /Record or upload footage of this house/);
});

// FM-532: the left column's card redraws itself, so its own click handler runs these buttons; the measurements
// app binds them only elsewhere (both binding them ran a reorder twice, or neither did after a redraw).
test('the left column order status runs the rejected card buttons itself', () => {
  const status = fn(request, 'mountMeasurementOrderStatus');
  assert.match(status, /'reorderRejectedExterior' in data\)action=\['reorderRejectedExteriorReport',\[data\.reorderRejectedExterior\]\]/);
  assert.match(status, /'rejectionWhy' in data\)\{[^}]*projectMeasurementsInvoke\('showRejectionWhy',\[button\]\)/);
  for (const selector of ['data-reorder-rejected-report', 'data-rejection-why', 'data-reorder-rejected-exterior']) {
    assert.match(measurements, new RegExp(`\\[${selector}\\]'\\)\\.forEach\\(\\(button\\) => \\{\\s*if \\(outsideOrderStatus\\(button\\)\\)`), selector);
  }
});

// FM-532: in an organization without expanded access (FirstMeasure only), a project lives in the browser that
// placed the order, and My Projects opens an order as its own flat record. A rejected order opened from there failed
// ("Unable to load this project": its cached copy still said queued) or, on another device, opened as a new order.
function requestFunctions(){
  const body = [
    'const isRejectedStatus = (...v) => v.some((s) => ["rejected", "rejected_no_coverage"].includes(String(s ?? "").toLowerCase()));',
    'const localIsPlatformProjectId = (v) => /^(project|base|__optimistic)_/i.test(String(v || ""));',
    request.match(/  const ORDER_STATE_KEYS = \[[\s\S]*?\];/)![0],
    ...['projectText', 'firstMeasurementId', 'mergeProjectForViewing', 'adoptBoardRejectedOrder'].map((name) => fn(request, name)),
    'return {mergeProjectForViewing, adoptBoardRejectedOrder};',
  ].join('\n');
  return new Function(body)();
}
const boardOrder = (status: string) => ({id: EXTERIOR, address: '1 Main St', status, rejection_reason: 'incorrect_footage',
  customer_rejection_message: 'The footage is of another house.', refund_issued: true, refund_amount: 25, measurement_scope: 'full_house'});

test("a browser's cached copy of an order takes the board's newer state: a rejected order opens as rejected", () => {
  const {mergeProjectForViewing} = requestFunctions();
  const cached = {id: 'project_local', workflow_state: 'measurement_ordered', status: 'queued', rejection_reason: '', refund_amount: 0,
    measurement_project: {id: EXTERIOR, folder: EXTERIOR, status: 'queued', raw: {folder: EXTERIOR, project: {id: EXTERIOR}}}};
  const merged = mergeProjectForViewing(cached, boardOrder('rejected'));
  assert.equal(merged.id, 'project_local');
  assert.equal(merged.measurement_project.status, 'rejected');
  assert.equal(merged.measurement_project.rejection_reason, 'incorrect_footage');
  assert.equal(merged.rejection_reason, 'incorrect_footage');
  assert.equal(merged.refund_amount, 25);
  assert.equal(merged.measurement_project.measurement_scope, 'full_house');
  // Another order's record (a replaced report) does not overwrite this project's order.
  const other = mergeProjectForViewing(cached, {...boardOrder('rejected'), id: 'exteriors_' + 'f'.repeat(32)});
  assert.equal(other.measurement_project.status, 'queued');
});

test("a rejected order the board opens bare is that project's order, not a new order form", () => {
  const {adoptBoardRejectedOrder} = requestFunctions();
  const bare = boardOrder('rejected');
  assert.equal(adoptBoardRejectedOrder(bare), true);
  assert.equal((bare as any).measurement_project.id, EXTERIOR);
  assert.equal((bare as any).measurement_project.status, 'rejected');
  assert.equal((bare as any).measurement_project.raw.measurement_scope, 'full_house');
  // Only a bare rejected order: a project with its own workflow (a reorder being prepared) or an open order is not.
  assert.equal(adoptBoardRejectedOrder({...boardOrder('rejected'), workflow_state: 'reorder_prefill'}), false);
  assert.equal(adoptBoardRejectedOrder(boardOrder('processing')), false);
  assert.equal(adoptBoardRejectedOrder({id: 'project_draft', status: 'rejected'}), false);
  assert.match(request, /const hasBaseMeasurement = projectHasReportOrder\(base\) \|\| adoptBoardRejectedOrder\(base\);/);
  // A window without order state never fails over its add-on list.
  assert.doesNotMatch(fn(request, 'setProjectionMode'), /reportOrderState\.include/);
});

test('every reorder of a rejected Full Exterior is a new order; the footage choices start with their scope chosen', () => {
  // "Reorder as Commercial" included: the server refuses to reopen an exteriors_ order in place.
  assert.match(fn(measurements, 'reorderCurrentReportOrder'), /if \(reportOrderIsExterior\(\)\) reorderSourceCanReopenInPlace = false;/);
  const reorder = fn(measurements, 'reorderRejectedExteriorReport');
  assert.match(reorder, /reorderCurrentReportOrder\(''\)/);
  assert.match(reorder, /ExteriorOrder\?\.prefer\?\.\(/);
  assert.match(reorder, /callHost\('orderMeasurements'\)/);
  assert.match(measurements, /\[data-reorder-rejected-exterior\][\s\S]{0,200}reorderRejectedExteriorReport\(button\.dataset\.reorderRejectedExterior\)/);
});

test("re-reading the order's manifest brings its rejection and refund into the project, and redraws the cards", () => {
  const body = [
    'const isRejectedStatus = (...v) => v.some((s) => ["rejected", "rejected_no_coverage"].includes(String(s ?? "").toLowerCase()));',
    'let reportOrderState = null; const calls = [];',
    'const persistActiveBaseProject = () => calls.push("persist"); const renderMeasurementsPanel = () => calls.push("render");',
    'const document = {dispatchEvent: (event) => calls.push(event.type)}; const CustomEvent = class { constructor(type){ this.type = type; } };',
    measurements.match(/  const REJECTION_MANIFEST_KEYS = \[[\s\S]*?\];/)![0],
    fn(measurements, 'mergeReportManifestIntoActiveProject'),
    'mergeReportManifestIntoActiveProject(manifest); return calls;',
  ].join('\n');
  // The copy this browser cached when the order was placed: queued, nothing rejected, nothing refunded.
  const project: any = {id: 'project_local', rejection_reason: '', customer_rejection_message: '', refund_amount: 0,
    measurement_project: {id: EXTERIOR, status: 'queued', raw: {}}};
  const manifest = {status: 'rejected', rejection_reason: 'incorrect_footage', customer_rejection_message: 'Footage of another house.',
    refund_issued: true, refund_amount: 25, measurement_scope: 'full_house'};
  const calls = new Function('activeBaseProject', 'manifest', body)(project, manifest);
  assert.equal(project.rejection_reason, 'incorrect_footage');
  assert.equal(project.customer_rejection_message, 'Footage of another house.');
  assert.equal(project.refund_amount, 25);
  assert.equal(project.measurement_project.rejection_reason, 'incorrect_footage');
  assert.equal(project.measurement_project.measurement_scope, 'full_house');
  assert.deepEqual(calls, ['persist', 'render', 'fm:measure-order-status']);
  // An order still in progress keeps the project's fields as they are.
  const open: any = {id: 'project_local', rejection_reason: '', measurement_project: {id: EXTERIOR, status: 'queued', raw: {}}};
  assert.deepEqual(new Function('activeBaseProject', 'manifest', body)(open, {status: 'processing', rejection_reason: 'stale'}), ['persist']);
  assert.equal(open.rejection_reason, '');
});

test("a route naming the open project's order is that project (its window keeps the order under a local id)", () => {
  const body = [
    'const $ = () => ({classList: {contains: () => true}});',
    'const localIsPlatformProjectId = (v) => /^(project|base|__optimistic)_/i.test(String(v || ""));',
    'const projectOpenId = () => "project_local"; const activeMeasurementProjectId = () => order;',
    fn(request, 'activeModalMatchesProject'),
    'return activeModalMatchesProject;',
  ].join('\n');
  const matches = new Function('order', body)(EXTERIOR);
  assert.equal(matches('project_local'), true);
  assert.equal(matches(EXTERIOR), true);
  assert.equal(matches('exteriors_' + 'f'.repeat(32)), false);
  assert.equal(matches('project_other'), false);
  assert.equal(new Function('order', body)('')(''), false);
});

// FM-532 review: the card of a Full Exterior rejected as commercial offered "Reorder as Commercial", a roof report.
test('a Full Exterior rejected as commercial or multi-family says we do not offer them and offers no reorder', () => {
  for (const [type, label] of [['commercial', 'commercial'], ['multifamily', 'multi-family']]) {
    // Stored before this review: the old copy and a reorder.
    const card = renderRejected(rejected('full_house', 'incorrect_structure_type', {correct_project_type: type,
      customer_rejection_message: 'This was ordered as residential, but it appears to require a commercial report.', rejection_reorder: {project_type: type}}));
    assert.equal(card.text, 'Full Exterior report rejected Reason It needs a different project type');
    assert.equal(card.why, `It seems to be a ${label} building and we currently don't offer exterior reports for ${label} buildings.`);
    assert.deepEqual(card.buttons, [], type);
  }
  // A roof keeps its reorder.
  assert.deepEqual(renderRejected(rejected('roof', 'incorrect_structure_type', {correct_project_type: 'commercial'})).buttons, ['data-reorder-rejected-report Reorder as Commercial']);
  // The older projects viewer doesn't offer it either.
  const button = new Function('escapeHtml', 'globalThis', `${fn(viewer, 'rejectedReorderButtonHtml')}; return rejectedReorderButtonHtml;`)((x: string) => x, {});
  assert.equal(button({id: EXTERIOR, correct_project_type: 'commercial'}), '');
  assert.equal(button({id: 'roof', measurement_scope: 'full_house', correct_project_type: 'commercial'}), '');
  assert.match(button({id: 'roof', correct_project_type: 'commercial'}), /Reorder as Commercial/);
});

test('a Full Exterior coverage rejection stored with the aerial-imagery sentence shows without it', () => {
  const card = renderRejected(rejected('full_house', 'no_satellite_image', {customer_rejection_message:
    'We were not able to complete this Full Exterior report because we do not currently have aerial imagery coverage for this address. A Full Exterior report measures the roof from aerial imagery, so it needs coverage of the house as well as your footage. We\'ve logged your interest.'}));
  assert.equal(card.why, "We were not able to complete this Full Exterior report because we do not currently have aerial imagery coverage for this address. We've logged your interest.");
});

// FM-532 review: on a phone Reports opens on Summary, which said only REJECTED; the reason was a tab further on.
test("a rejected order's summary shows its reason, why, the refund and the card's actions, in the open", () => {
  const order = {...rejected('full_house', 'incorrect_footage', {customer_rejection_message: "The uploaded footage doesn't seem to match the provided address."}), refund_amount: 25};
  const summary = renderRejected(order, {summary: true});
  assert.equal(summary.text, "Why it was rejected Reason Incorrect footage uploaded The uploaded footage doesn't seem to match the provided address. $25 returned to credits Upload the correct footage Order just the roof");
  assert.deepEqual(summary.buttons, ['data-reorder-rejected-exterior="full_house" Upload the correct footage', 'data-reorder-rejected-exterior="roof" Order just the roof']);
  const commercial = renderRejected(rejected('full_house', 'incorrect_structure_type', {correct_project_type: 'commercial'}), {summary: true});
  assert.equal(commercial.text, "Why it was rejected Reason It needs a different project type It seems to be a commercial building and we currently don't offer exterior reports for commercial buildings.");
  // It leads the summary; nothing is drawn for an order that wasn't rejected.
  assert.match(fn(measurements, 'reportSummaryHtml'), /<div class="r-report-summary-grid">\s*\$\{rejectionSummarySectionHtml\(\)\}/);
  assert.match(fn(measurements, 'rejectionSummarySectionHtml'), /if \(!reportOrderIsRejected\(\)\) return '';/);
});
