import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../measure/internal/portal_scripts/manager_review.js', import.meta.url), 'utf8');
const helper = source.slice(source.indexOf('  function qualityRange('), source.indexOf('  const ISSUE_CATEGORIES'));
function context() {
  const body = { innerHTML: '', querySelectorAll: () => [] };
  const c = vm.createContext({ esc: String, document: { getElementById: id => id === 'mraResultsBody' ? body : null }, resultsData: null });
  vm.runInContext(helper, c);
  return { c, body };
}

test('quality bands use unrounded boundaries and preserve unknown scores', () => {
  const { c } = context();
  for (const [value, expected] of [[0,'Less than 70%'],[69.99,'Less than 70%'],[70,'70-80%'],[79.99,'70-80%'],[80,'80-90%'],[89.99,'80-90%'],[90,'90%+'],[100,'90%+'],['90','90%+'],[null,'—'],[undefined,'—'],['','—'],['invalid','—'],[-1,'—'],[101,'—']]) {
    c.value = value;
    assert.equal(vm.runInContext('qualityRange(value)', c), expected, String(value));
  }
});

test('summary and QA/team tables render ranges, not exact percentages', () => {
  const { c, body } = context();
  for (const name of ['resultsGroupTable','renderResultsBody']) {
    const line = source.split(/\r?\n/).find(l => l.trimStart().startsWith(`function ${name}(`));
    assert.ok(line, name);
    vm.runInContext(line, c);
  }
  c.resultsData = { summary: { pass_rate: 86.7 }, groups: { qa: [{label:'QA',pass_rate:92.1}], team: [{label:'Team',pass_rate:72.4}] }, access: {can_view_all:true}, results:[] };
  vm.runInContext('renderResultsBody()', c);
  for (const band of ['80-90%','90%+','70-80%']) assert.ok(body.innerHTML.includes(band));
  for (const exact of ['86.7%','92.1%','72.4%']) assert.ok(!body.innerHTML.includes(exact));
});
