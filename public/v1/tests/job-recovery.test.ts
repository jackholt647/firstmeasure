import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { runWithJobLease } from '../firstmeasure/job_lease.js';

test('job fencing, renewal, retry exhaustion and concurrent claims', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fm-job-recovery-'));
  const postgres = Boolean(process.env.TEST_POSTGRES_URL);
  process.env.FIRSTMATE_ENV = 'test';
  process.env.FIRSTMEASURE_DATABASE_MODE = postgres ? 'postgres' : 'sqlite';
  process.env.DATABASE_URL = process.env.TEST_POSTGRES_URL ?? '';
  process.env.DATABASE_ADMIN_URL = '';
  process.env.DATABASE_CA_CERT_PATH = '';
  process.env.POSTGRES_AUTO_MIGRATE = 'false';
  process.env.FIRSTMEASURE_STORAGE_ROOT = root;
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, 'index.sqlite');
  const jobs = await import('../firstmeasure/job_queue.js');
  const db = await import('../src/database/postgres.js');
  const index = await import('../firstmeasure/project_index.js');
  const expire = async (id: string) => {
    if (postgres) await db.queryPostgres('UPDATE firstmeasure_jobs SET lease_until_ms=1 WHERE id=$1', [id]);
    else index.getFirstMeasureProjectIndexDb().prepare('UPDATE firstmeasure_jobs SET lease_until_ms=1 WHERE id=?').run(id);
  };
  try {
    const id = await jobs.enqueueFirstMeasureJob('test.recovery', {}, { maxAttempts: 3 });
    const first = await jobs.claimNextFirstMeasureJob('same-owner', ['test.recovery'], 1000);
    assert.ok(first);
    assert.equal(await jobs.renewFirstMeasureJobLease(id, { ...first, lease_owner: 'wrong' }, 5000), false);
    assert.equal(await jobs.renewFirstMeasureJobLease(id, first, 5000), true);
    assert.ok((await jobs.getFirstMeasureJob(id))!.lease_until_ms > first.lease_until_ms);
    assert.equal(await jobs.claimNextFirstMeasureJob('other', ['test.recovery']), null);
    await expire(id);
    assert.equal(await jobs.renewFirstMeasureJobLease(id, first, 5000), false);
    assert.equal(await jobs.completeFirstMeasureJob(id, {}, first), false);
    const second = await jobs.claimNextFirstMeasureJob('same-owner', ['test.recovery']);
    assert.ok(second);
    assert.equal(second.attempts, 2);
    assert.equal(await jobs.completeFirstMeasureJob(id, {}, first), false);
    assert.equal(await jobs.failFirstMeasureJob(id, 'stale', first), false);
    assert.equal(await jobs.renewFirstMeasureJobLease(id, first, 5000), false);
    assert.equal(await jobs.failFirstMeasureJob(id, 'retryable', second), true);
    const third = await jobs.claimNextFirstMeasureJob('new-owner', ['test.recovery']);
    assert.ok(third);
    assert.equal(third.attempts, 3);
    assert.equal(await jobs.completeFirstMeasureJob(id, { ok: true }, third), true);
    assert.equal(await jobs.failFirstMeasureJob(id, 'late failure', third), false);
    assert.equal((await jobs.getFirstMeasureJob(id))!.status, 'completed');

    const exhausted = await jobs.enqueueFirstMeasureJob('test.exhausted');
    await jobs.claimNextFirstMeasureJob('crashed', ['test.exhausted']);
    await expire(exhausted);
    assert.equal(await jobs.reapExhaustedFirstMeasureJobs(['unrelated']), 0);
    assert.equal(await jobs.reapExhaustedFirstMeasureJobs(['test.exhausted']), 1);
    assert.equal((await jobs.getFirstMeasureJob(exhausted))!.status, 'failed');
    assert.equal(await jobs.reapExhaustedFirstMeasureJobs(['test.exhausted']), 0);

    for (let i=0;i<12;i++) await jobs.enqueueFirstMeasureJob('test.concurrent');
    const claims = await Promise.all(Array.from({length: 24}, (_, i) => jobs.claimNextFirstMeasureJob(`owner${i}`, ['test.concurrent'])));
    // SQLite contenders may lose their optimistic candidate race; PG's SKIP LOCKED should fill all slots.
    const claimed = claims.filter((row) => row != null);
    assert.ok(claimed.length > 0);
    assert.equal(new Set(claimed.map((row) => row.id)).size, claimed.length);
    if (postgres) assert.equal(claimed.length, 12);
  } finally { await db.closePostgresPools(); }
});

test('lease guard renews long work and stops its timer after completion', async () => {
  let renewals=0;
  const result = await runWithJobLease({ execute: async () => { await sleep(120); return 42; },
    renew: async () => { renewals++; return true; }, leaseUntilMs: Date.now()+1000,
    leaseMs: 1000, intervalMs: 10, safetyMarginMs: 10, maxRuntimeMs: 1000,
    fatal: assert.fail, warn: (error) => assert.fail(String(error)) });
  assert.equal(result, 42);
  assert.ok(renewals > 0);
  const before=renewals;
  await sleep(40);
  assert.equal(renewals, before);
});

for (const failure of ['lost', 'database-down', 'hung-renewal', 'hung-handler'] as const) {
  test(`lease guard fails safely for ${failure}`, async () => {
    let fatals=0;
    await assert.rejects(runWithJobLease({ execute: () => new Promise(() => {}),
      renew: async () => {
        if (failure === 'lost') return false;
        if (failure === 'database-down') throw new Error('unavailable');
        if (failure === 'hung-renewal') return new Promise(() => {});
        return true;
      }, leaseUntilMs: Date.now()+150, leaseMs: 1000, intervalMs: 10,
      safetyMarginMs: 20, maxRuntimeMs: 180,
      fatal: () => { fatals++; }, warn: () => {} }));
    assert.equal(fatals, 1);
  });
}
