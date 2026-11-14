// FM-410: a rejected report says why in the left column. A Full Exterior turned down for its footage offers a
// retry with more footage or the roof alone, as new orders; coverage gaps offer no reorder; roofs keep their copy.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const api = await readFile(new URL('../firstmeasure/api.ts', import.meta.url), 'utf8');
const measurements = await readFile(new URL('../../libraries/apps/measurements/project.js', import.meta.url), 'utf8');

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

test('staff can reject a Full Exterior for insufficient footage, and the customer is told how to try again', () => {
  assert.match(api.slice(api.indexOf('const DEFAULT_REJECTION_REASONS'), api.indexOf('let rejectionReasonsCache')), /id: "insufficient_footage"/);
  const ctx = vm.createContext({asRecord: (x: any) => x && typeof x === 'object' ? x : {}});
  vm.runInContext(transpile(fn(api, 'buildRejectionMessageParagraphs')), ctx);
  const footage = vm.runInContext('buildRejectionMessageParagraphs({rejection_reason:"insufficient_footage",measurement_scope:"full_house"})', ctx).join(' ');
  assert.match(footage, /Full Exterior report because the photos and video do not show enough of the house/);
  assert.match(footage, /wider view of the house and more photos of each side, or order just the roof report/);
  // A roof rejected for coverage keeps its coverage copy: nothing to reorder.
  assert.match(vm.runInContext('buildRejectionMessageParagraphs({rejection_reason:"no_height_map"})', ctx).join(' '), /do not currently have coverage for this address/);
});

test('insufficient footage is refused for a roof order', async () => {
  const code = fn(api, 'rejectCoverageProject');
  for (const [scope, refused] of [[undefined, true], ['full_house', false]] as const) {
    const ctx = vm.createContext({
      withPublicFirstMeasureLock: (_key: string, run: any) => run(),
      resolveRejectionReasonId: async (x: any) => x,
      readManifest: async () => ({id: 'fixture', status: 'processing', measurement_scope: scope}),
      buildLegacyManifest: (x: any) => x,
      normalizeOptionalPortalActor: () => { throw Object.assign(new Error('passed the guard'), {code: 'passed'}); },
      badRequest,
    });
    vm.runInContext(transpile(code), ctx);
    await assert.rejects(vm.runInContext('rejectCoverageProject("fixture",{rejection_reason:"insufficient_footage"})', ctx), {code: refused ? 'invalid_rejection_reason' : 'passed'});
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
function renderRejected(project: Record<string, any>, {exteriorsOffered = true} = {}){
  const names = ['rejectionReasonLabel', 'rejectedReportHtml', 'reportOrderReorderType', 'normalizeProjectTypeLabel',
    'customerRejectionCopy', 'fallbackCustomerRejectionCopy', 'reportOrderMeasurement', 'reportOrderManifest', 'reportOrderIsExterior'];
  const body = [
    'let activeBaseProject = project, selectedType = project.project_type || "residential";',
    'const reportOrderExpediteKey = () => String(reportOrderMeasurement().report_expedite_option || "");',
    'const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");',
    'const fmtCredit = (n) => "$" + n;',
    ...names.map((name) => fn(measurements, name)),
    'return rejectedReportHtml();',
  ].join('\n');
  const window = {Portal: {ExteriorOrder: {offersChoice: (type: string) => exteriorsOffered && type === 'residential'}}};
  const html = new Function('project', 'window', 'globalThis', body)(project, window, {});
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
  assert.match(measurements, /\[data-rejection-why\][\s\S]{0,200}PlatformUI\?\.showTooltip\?\.\(/);
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
