import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../libraries/apps/project-request/app.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
function choice(settings, workflow = 'report', project = null) {
  const flags = {
    current: () => settings,
    value: (group, flag, fallback) => settings[`${group}.${flag}`] ?? fallback
  };
  const context = vm.createContext({ window: { Portal: { appFlags: flags } } });
  vm.runInContext(functionSource('appFlagValue') + '\n' + functionSource('initialReportProjectChoice'), context);
  return context.initialReportProjectChoice(workflow, project);
}
test('automatic entry follows the primary New button, including legacy default', () => {
  assert.equal(choice({}), 'new');
  assert.equal(choice({ 'platform.new_button_mode': 'report' }), 'new');
  for (const mode of ['selector', 'project', 'doc:proposal', 'off']) {
    assert.equal(choice({ 'platform.new_button_mode': mode }), 'search');
  }
});
test('explicit on and off override either primary button mode', () => {
  for (const mode of ['report', 'selector']) {
    assert.equal(choice({ 'platform.new_button_mode': mode, 'firstmeasure.new_report_project': 'on' }), 'new');
    assert.equal(choice({ 'platform.new_button_mode': mode, 'firstmeasure.new_report_project': 'off' }), 'search');
  }
});
test('existing-project reports and non-report workflows retain their entry behavior', () => {
  for (const mode of ['auto', 'on', 'off']) {
    const settings = { 'firstmeasure.new_report_project': mode };
    assert.equal(choice(settings, 'report', { id: 'existing-project' }), 'existing');
    assert.equal(choice(settings, 'project'), '');
  }
  assert.match(source, /reportProjectChoice = initialReportProjectChoice\(overviewWorkflowMode, baseProject\)/);
});
