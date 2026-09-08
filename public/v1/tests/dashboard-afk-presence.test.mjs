import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile('../measure/internal/portal_scripts/shifts.js', 'utf8');
const start = source.indexOf('function workerLatestActivityMs(');
const end = source.indexOf('\n  function ', start + 10);
assert.ok(start >= 0 && end > start, 'AFK activity helper is available');

const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);
context.worker = {
  last_activity_at: '2026-09-08T19:59:00Z',
  projects: [{
    started_at: '2026-09-08T15:00:00Z',
    editor_presence: { at: '2026-09-08T19:58:45Z' }
  }],
  qa_items: []
};
context.parseTimestamp = value => Date.parse(String(value || '')) || 0;

assert.equal(
  vm.runInContext('workerLatestActivityMs(worker, parseTimestamp)', context),
  Date.parse('2026-09-08T19:59:00Z'),
  'live shared-user activity wins over the old assignment start'
);

context.worker.last_activity_at = '';
assert.equal(
  vm.runInContext('workerLatestActivityMs(worker, parseTimestamp)', context),
  Date.parse('2026-09-08T19:58:45Z'),
  'project editor presence is also accepted as activity'
);

console.log('PASS: dashboard AFK state uses live user/editor presence, not only assignment age.');
