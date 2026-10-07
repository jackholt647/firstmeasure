import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('full-house qualifications, reviewed PDFs, QA and quality audits; roof compatibility', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'full-house-workflow-'));
  const postgres = process.env.TEST_POSTGRES_URL;
  Object.assign(process.env, {
    FIRSTMATE_ENV: 'test', FIRSTMEASURE_DATABASE_MODE: postgres ? 'postgres' : 'sqlite',
    DATABASE_URL: postgres || '', DATABASE_ADMIN_URL: postgres || '', POSTGRES_AUTO_MIGRATE: 'true',
    FIRSTMEASURE_STORAGE_ROOT: path.join(root, 'reports'), FIRSTMEASURE_INDEX_DB_PATH: path.join(root, 'index.sqlite'),
    INTERNAL_STORAGE_ROOT: path.join(root, 'internal'), PLATFORM_STORAGE_ROOT: path.join(root, 'platform'),
    FIRSTMEASURE_JOB_WORKERS: '0', EMAIL_OUTBOUND_DISABLED: '1', PLATFORM_HEARTBEAT_DISABLED: '1'
  });
  const storage = await import('../firstmeasure/storage.js');
  const users = await import('../internal/storage.js');
  const queue = await import('../firstmeasure/queue.js');
  const jobs = await import('../firstmeasure/job_queue.js');
  const contracts = await import('../firstmeasure/full_house_workflow.js');
  const { buildApp } = await import('../src/app.js');
  const tech = { email: 'full-tech@example.test', name: 'Full tech' };
  const qa = { email: 'full-qa@example.test', name: 'Full QA' };
  const roof = { email: 'roof-only@example.test', name: 'Roof only' };
  await users.saveInternalUser({ ...tech, role: 'technician', can_draft_full_house: true });
  await users.saveInternalUser({ ...qa, role: 'qa', can_qa_full_house: true });
  await users.saveInternalUser({ ...roof, role: 'qa', permissions: { perform_manager_review: true } });
  assert.equal(await contracts.fullHouseEligible(tech.email, 'qa'), false);
  assert.equal(await contracts.fullHouseEligible(qa.email, 'draft'), false);
  const app = await buildApp();
  const post = (route: string, payload: object) => app.inject({ method: 'POST', url: '/v1/firstmeasure/' + route, payload });
  const id = 'exteriors_' + 'a'.repeat(32);
  const roofId = 'roof-compatibility-report';
  const create = async (projectId: string, full: boolean) => {
    await storage.createProject({ id: projectId, address: 'Synthetic workflow fixture', project_type: 'residential', status: 'queued',
      ...(full ? { measurement_scope: 'full_house', include_gutter_measurements: true } : {})
    }, full ? { customerExteriors: true } : {});
    await storage.saveArtifact(projectId, 'google.png', Buffer.from('synthetic queue thumbnail'));
  };
  try {
    await create(id, true);
    await create(roofId, false);
    await assert.rejects(queue.reserveProject(id, { reserved_for: roof }), { code: 'full_house_qualification_required' });
    const denied = await post(`projects/${id}/queue/claim`, { actor: { ...roof, can_draft_full_house: true } });
    assert.equal(denied.statusCode, 403, denied.body);
    const next = await queue.claimNextInQueue({ actor: { ...roof, drafter_rank: 'senior' } });
    assert.equal(next.project.id, roofId, 'unqualified worker skips full house without blocking roof work');
    await queue.reserveProject(id, { reserved_for: tech });
    assert.equal((await queue.claimNextInQueue({ actor: { ...tech, drafter_rank: 'senior' } })).project.id, id);
    await assert.rejects(storage.patchManifest(id, { include_gutter_measurements: false }), { code: 'full_house_gutters_required' });
    const noPdf = await post(`projects/${id}/status`, { status: 'awaiting_review' });
    assert.equal(noPdf.statusCode, 409, noPdf.body);
    const snapshot = { folderId: id, report: { lines: [{ type: 'eave' }] }, exteriorReport: { walls: [{ id: 'wall', gross: 100 }], roof: [{ id: 'roof' }], totals: { gross: 100 } }, exteriorSettings: { include: true }, gutterSettings: { stories: { north: '1', south: '1', east: '1', west: '1' } } };
    const manifest = await storage.readManifest(id);
    contracts.assertFullHouseSnapshot(manifest, snapshot);
    assert.throws(() => contracts.assertFullHouseSnapshot(manifest, { ...snapshot, exteriorReport: null }), { code: 'full_house_exterior_required' });
    assert.throws(() => contracts.assertFullHouseSnapshot(manifest, { ...snapshot, gutterSettings: {} }), { code: 'full_house_gutters_required' });
    contracts.assertFullHouseSnapshot(await storage.readManifest(roofId), {});
    const pdf = Buffer.from('%PDF-1.4\nworkflow fixture; rendering is tested separately\n%%EOF');
    const revision = 'reviewed-full-house';
    const sync = await jobs.enqueueFirstMeasureJob('pdf.sync', { project_id: id, revision, snapshot, outputs: [{ slot: 'main', mode: 'full', persist: true }] });
    await storage.patchManifest(id, { pdf_sync: { latest_job_id: sync, latest_revision: revision, status: 'queued' } });
    const unfinished = await post(`projects/${id}/status`, { status: 'awaiting_review' });
    assert.equal(unfinished.statusCode, 409, unfinished.body);
    const claimed = await jobs.claimNextFirstMeasureJob('fixture-worker', ['pdf.sync']);
    assert.ok(claimed);
    await storage.saveStoredPdf(id, 'main', pdf);
    await jobs.completeFirstMeasureJob(sync, { outputs: [{ slot: 'main', mode: 'full', sha256: createHash('sha256').update(pdf).digest('hex') }] }, claimed);
    await storage.patchManifest(id, { pdf_sync: { status: 'completed', checksum_match: true } });
    const submitted = await post(`projects/${id}/status`, { status: 'awaiting_review', pdf_sync_job_id: sync, pdf_sync_revision: revision });
    assert.equal(submitted.statusCode, 200, submitted.body);
    assert.equal((await post(`projects/${id}/qa/claim`, { actor: tech })).statusCode, 403);
    const peek = await post('qa/queue/peek', { actor: roof });
    assert.equal(peek.statusCode, 200, peek.body);
    assert.ok(!peek.json().projects.some((p: { id: string }) => p.id === id));
    const qaClaim = await post(`projects/${id}/qa/claim`, { actor: qa });
    assert.equal(qaClaim.statusCode, 200, qaClaim.body);
    const incomplete = await post(`projects/${id}/qa/decision`, { actor: qa, status: 'approved' });
    assert.equal(incomplete.statusCode, 409, incomplete.body);
    const review = Object.fromEntries(contracts.FULL_HOUSE_REVIEW_FIELDS.map(key => [key, true]));
    await storage.saveStoredPdf(id, 'main', Buffer.from('replaced artifact'));
    const replaced = await post(`projects/${id}/qa/decision`, { actor: qa, status: 'approved', full_house_review: review });
    assert.equal(replaced.statusCode, 409, replaced.body);
    await storage.saveStoredPdf(id, 'main', pdf);
    await users.saveInternalUser({ ...qa, can_qa_full_house: false });
    assert.equal((await post(`projects/${id}/qa/decision`, { actor: qa, status: 'approved', full_house_review: review })).statusCode, 403);
    await users.saveInternalUser({ ...qa, can_qa_full_house: true });
    const approved = await post(`projects/${id}/qa/decision`, { actor: qa, status: 'approved', full_house_review: review });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal((await storage.readManifest(id)).status, 'completed');
    assert.equal(((await storage.readManifest(id)).qa_full_house_review as Record<string, unknown>).revision, revision);
    const delivery = await jobs.getFirstMeasureJob(approved.json().delivery_job_id);
    assert.equal(delivery?.type, 'report.delivery');
    assert.equal(delivery?.payload.pdf_sync_revision, revision);
    assert.deepEqual((await storage.readStoredPdf(id, 'main')).content, pdf);
    await users.saveInternalUser({ ...qa, permissions: { perform_manager_review: true } });
    const audit = await app.inject({ method: 'POST', url: '/v1/internal/legacy-action', payload: { action: 'manager_audit_mark', actor: qa, folder: id, audit_status: 'flagged', issue_categories: ['missing_or_incorrect_gutters'], severity: 'major' } });
    assert.equal(audit.statusCode, 200, audit.body);
    const audited = await storage.readManifest(id);
    assert.equal(((audited.manager_audit_record as Record<string, unknown>).sample as Record<string, unknown>).measurement_scope, 'full_house');
    assert.deepEqual(audited.manager_audit_issue_categories, ['missing_or_incorrect_gutters']);
    // The existing roof path needs neither qualification nor exterior checks.
    await storage.saveStoredPdf(roofId, 'main', pdf);
    assert.equal((await post(`projects/${roofId}/status`, { status: 'awaiting_review' })).statusCode, 200);
    assert.equal((await post(`projects/${roofId}/qa/claim`, { actor: roof })).statusCode, 200);
    const roofApproval = await post(`projects/${roofId}/qa/decision`, { actor: roof, status: 'approved' });
    assert.equal(roofApproval.statusCode, 200, roofApproval.body);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
});
