import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const viewer = readFileSync(new URL('../../libraries/apps/projects/viewer.js', import.meta.url), 'utf8');
const measurements = readFileSync(new URL('../../libraries/apps/measurements/project.js', import.meta.url), 'utf8');

// The source of one top-level function of the viewer, by name.
function fn(source, name){
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++){
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(name);
}

const helpers = new Function('escapeHtml', 'projectStatusGroup', [
  fn(viewer, 'projectIncludesGutters'), fn(viewer, 'reportKindMeta'), fn(viewer, 'reportKindThumbBadgeHtml'),
  fn(viewer, 'reportKindRowTagHtml'), fn(viewer, 'projectReportMode'), fn(viewer, 'hasInstantProjectMarker'), fn(viewer, 'projectScopeLabel'),
  'return {reportKindMeta, reportKindThumbBadgeHtml, reportKindRowTagHtml, projectScopeLabel};',
].join('\n'))((s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'), () => 'ready');

test('every report carries one tag: Roof, Roof & Gutters or Full Exterior', () => {
  assert.equal(helpers.reportKindMeta({}).label, 'Roof');
  assert.equal(helpers.reportKindMeta({include_gutter_measurements: true}).label, 'Roof & Gutters');
  assert.equal(helpers.reportKindMeta({measurement_scope: 'full_house'}).label, 'Full Exterior');
  assert.match(helpers.reportKindThumbBadgeHtml({}), /data-role="kind-badge"><i class="fas fa-house-chimney"><\/i> Roof<\/div>/);
  assert.match(helpers.reportKindRowTagHtml({include_gutter_measurements: '1'}), /Roof &amp; Gutters<\/span>/);
  assert.equal(helpers.projectScopeLabel({}), 'Standard - Roof');
  assert.equal(helpers.projectScopeLabel({include_gutter_measurements: true, report_mode: 'both'}), 'Both - Roof & Gutters');
});

test('the tag wording has its own language keys, so the old catalog English cannot win', () => {
  // A reused key would keep showing "Roof Only" / "Roof + Gutters" from the compiled catalog.
  for (const source of [fn(viewer, 'reportKindMeta'), fn(viewer, 'projectScopeLabel'), fn(measurements, 'reportOrderKindHtml')]){
    assert.doesNotMatch(source, /Roof Only|Roof \+ Gutters|report_kind_roof_only|report_kind_roof_gutters|m_d2a894582092f8|m_bf38bfda2125d1/);
    assert.match(source, /report_kind_roof["'],["']Roof["']/);
    assert.match(source, /report_kind_roof_and_gutters["'],["']Roof & Gutters["']/);
  }
});
