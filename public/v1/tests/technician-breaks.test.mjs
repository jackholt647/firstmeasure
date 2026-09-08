import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const internal = readFileSync(new URL('../internal/api.ts', import.meta.url), 'utf8');
const action = internal.split('case "set_break_status": {')[1].split('case "manager_review_data":')[0].trim().replace(/}\s*$/, '');
const run = new Function('actor', 'body', 'readInternalUser', 'patchInternalUser', 'unauthorized', 'notFound', `return (async () => {${action}})()`);
const queue = readFileSync(new URL('../firstmeasure/queue.ts', import.meta.url), 'utf8');
const statusBody = queue.split('export async function getClaimableQueueStatus(input: QueueClaimInput) {')[1].split('async function getClaimableQueueStatusWithoutBreak')[0].trim().replace(/}\s*$/, '');
const status = new Function('input', 'getClaimableQueueStatusWithoutBreak', 'readInternalUser', `return (async () => {${statusBody}})()`);

test('break state persists, repeated start preserves timestamp, end clears it', async () => {
  let user = { email: 'tech@1m8.ai', on_break: false };
  const read = async email => email === user.email ? user : null;
  const patch = async (_email, values) => { user = { ...user, ...values }; return user; };
  const error = (code, message) => Object.assign(new Error(message), { code });
  const invoke = value => run({ email: user.email }, { on_break: value }, read, patch, error, error);
  const started = await invoke('1');
  assert.equal(started.on_break, true);
  assert.ok(started.break_started_at);
  assert.equal((await invoke(true)).break_started_at, started.break_started_at);
  const blocked = await status({ actor: { email: user.email } }, async () => ({ queue_blocked: false, claimable_count: 1, claimable_next_id: 'test' }), read);
  assert.equal(blocked.queue_blocked, true);
  assert.equal(blocked.claimable_count, 0);
  assert.equal(blocked.queue_blocked_reason, 'on_break');
  assert.equal((await invoke('0')).on_break, false);
  assert.equal(user.break_started_at, null);
  const available = await status({ actor: { email: user.email } }, async () => ({ queue_blocked: false, claimable_count: 1 }), read);
  assert.equal(available.queue_blocked, false);
  assert.equal(available.claimable_count, 1);
});

test('claim guard runs before either database implementation', () => {
  const claim = queue.split('export async function claimNextInQueue(input: QueueClaimInput) {')[1];
  assert.ok(claim.indexOf('throw conflict("on_break"') < claim.indexOf('if (isFirstMeasurePostgresEnabled())'));
});
