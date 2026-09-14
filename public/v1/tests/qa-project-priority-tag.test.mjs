import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const qa = await readFile(new URL('../../measure/internal/portal_scripts/qa.js', import.meta.url), 'utf8');
const projects = await readFile(new URL('../../measure/internal/portal_scripts/projects.js', import.meta.url), 'utf8');
const start = projects.indexOf('    normalizeReportExpediteOption(');
const end = projects.indexOf('    normalizeCompletedTodayPriorityFilter(', start);
const c = vm.createContext({window:{}});
vm.runInContext(`window.Projects = {${projects.slice(start,end)}}`, c);
vm.runInContext(qa.slice(qa.indexOf('  function qaProjectPriorityPill('), qa.indexOf('  function genId(')), c);

test('review tags reuse project priority rules, including explicit overrides', () => {
  for (const [project,level] of [[{priority_level:1},1],[{queue_priority_level:'2'},2],[{report_expedite_option:'rush_under_1'},1],[{report_expedite_option:'rush_1_3'},2],[{is_vip:true},2],[{qa_priority:true},1],[{is_expedited:true},2],[{priority_level:3,is_vip:true},null],[{},null]]) {
    c.project = project;
    const html = vm.runInContext('qaProjectPriorityPill(project)', c);
    if (level) { assert.match(html,new RegExp(`>P${level}</span>`)); assert.match(html,new RegExp(`title="Project priority ${level}"`)); }
    else assert.equal(html,'');
  }
});

test('embedded and standalone review headers both include priority beside VIP', () => {
  assert.equal((qa.match(/extra \+= qaProjectPriorityPill\(currentManifest \|\| item\)/g)||[]).length,2);
  assert.match(qa,/qaProjectPriorityPill\(currentManifest \|\| item\);[\s\S]*?setEmbeddedHeaderText\(esc\(addrText\) \+ extra/);
});
