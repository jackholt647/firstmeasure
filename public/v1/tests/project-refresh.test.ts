import assert from 'node:assert/strict';
import test from 'node:test';
import { projectPageChanges } from '../firstmeasure/project_refresh.js';

test('unchanged pages transfer no projects; edits, removals and insertions reconcile in server order', () => {
  const scope = { actor: 'a', organization: 'one', page: 1 };
  const initial = projectPageChanges(scope, [{id:'a',status:'queued'}, {id:'b',status:'ready'}]);
  assert.equal(initial.reset, true);
  assert.deepEqual(projectPageChanges(scope, [{id:'a',status:'queued'}, {id:'b',status:'ready'}], initial.cursor).projects, []);
  const next = projectPageChanges(scope, [{id:'c',status:'queued'}, {id:'a',status:'ready'}], initial.cursor);
  assert.deepEqual(next.removed, ['b']);
  assert.deepEqual(next.order, ['c','a']);
  assert.equal(next.projects.length, 2);
});
test('organization, permission, filters and page changes cannot reuse a cursor; tampering resets', () => {
  const initial = projectPageChanges({actor:'a',org:'one',roles:['admin']}, [{id:'secret'}]);
  const revoked = projectPageChanges({actor:'a',org:'one',roles:[]}, [], initial.cursor);
  assert.equal(revoked.reset, true); assert.deepEqual(revoked.projects, []);
  assert.equal(projectPageChanges({actor:'b'}, [], initial.cursor).reset, true);
  assert.equal(projectPageChanges({}, [], initial.cursor+'x').reset, true);
});
test('large unchanged pages have zero response bodies and independently changed artifact revisions refresh', () => {
  const rows = Array.from({length:200}, (_,i) => ({id:String(i),artifact_revision:'1'}));
  const initial = projectPageChanges('large', rows);
  assert.equal(projectPageChanges('large', rows, initial.cursor).projects.length, 0);
  rows[99]!.artifact_revision = '2';
  assert.deepEqual(projectPageChanges('large', rows, initial.cursor).projects.map(x=>x.id), ['99']);
});
