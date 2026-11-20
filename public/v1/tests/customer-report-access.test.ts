import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// FM-625: a technician's submission writes Report.pdf, Summary.pdf and the model before QA approves anything. A
// report in QA or sent back (requeue) showed as ready in the customer portal and its PDF opened. A customer gets the
// report's files only once it is delivered (completed, not held) or while changes they asked for are made.
test('customers read a report only once it is delivered', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fm625-customer-report-'));
  Object.assign(process.env, {
    FIRSTMATE_ENV: 'test', FIRSTMEASURE_DATABASE_MODE: 'sqlite', DATABASE_URL: '',
    FIRSTMEASURE_JOB_WORKERS: '0', EMAIL_OUTBOUND_DISABLED: '1', PLATFORM_HEARTBEAT_DISABLED: '1',
    FIRSTMEASURE_STORAGE_ROOT: path.join(root, 'reports'), FIRSTMEASURE_INDEX_DB_PATH: path.join(root, 'index.sqlite'),
    INTERNAL_STORAGE_ROOT: path.join(root, 'internal'), PLATFORM_STORAGE_ROOT: path.join(root, 'platform')
  });
  const storage = await import('../firstmeasure/storage.js');
  const { customerMayReadReport } = await import('../firstmeasure/api.js');
  const { buildApp } = await import('../src/app.js');
  const { staffInjector, customerFixture, ensureServiceSecretForTests } = await import('./helpers/security-fixture.js');
  await ensureServiceSecretForTests();
  const app = await buildApp();
  try {
    const customer = await customerFixture();
    const staff = staffInjector(app, {}, { email: 'qa@example.test', role: 'qa' });
    await staff.sessionFor('qa@example.test');
    const id = 'f'.repeat(32), base = `/v1/firstmeasure/projects/${id}`;
    await storage.createProject({ id, address: '5401 S Kings Hwy, Myrtle Beach, SC 29575, USA', status: 'queued' });
    await storage.patchManifest(id, { organization_id: customer.orgId, status: 'awaiting_review' });
    await storage.saveArtifact(id, 'Report.pdf', Buffer.from('%PDF-1.4 unapproved report'));
    await storage.saveArtifact(id, 'Summary.pdf', Buffer.from('%PDF-1.4 unapproved summary'));
    await storage.saveArtifact(id, 'model_data.xml', Buffer.from('<model/>'));
    await storage.saveArtifact(id, 'customer-reference-0.jpg', Buffer.from('customer photo'));

    const asCustomer = (url: string) => app.inject({ method: 'GET', url, headers: customer.headers });
    const reportFiles = ['Report.pdf', 'Summary.pdf', 'model_data.xml', 'report.pdf'];
    const expectWithheld = async (label: string) => {
      for (const name of reportFiles) {
        const response = await asCustomer(`${base}/artifacts/${name}`);
        assert.equal(response.statusCode, 404, `${label}: ${name}`);
        assert.equal(response.json().error, 'report_not_ready', `${label}: ${name}`);
      }
      assert.equal((await asCustomer(`${base}/pdf`)).statusCode, 404, `${label}: stored PDF`);
      assert.equal((await asCustomer(`${base}/pdfs/report`)).statusCode, 404, `${label}: report PDF`);
      const detail = (await asCustomer(base)).json().project;
      const listed = detail.files.map((file: { name: string }) => file.name.toLowerCase());
      assert.deepEqual(listed.filter((name: string) => /\.(pdf|xml)$|pdf_state|app_metadata/.test(name)), [], `${label}: detail lists no report files`);
      assert.equal(detail.pdf_state, null, `${label}: no editor state`);
      const card = (await asCustomer(`${base}?view=portal-card`)).json().project;
      assert.deepEqual(card.artifact_flags, { has_report_pdf: false, has_summary_pdf: false, has_model_data: false }, `${label}: portal card`);
      // The customer's own files and staff access are unchanged.
      assert.equal((await asCustomer(`${base}/artifacts/customer-reference-0.jpg`)).statusCode, 200, `${label}: own photo`);
      assert.equal((await staff({ method: 'GET', url: `${base}/artifacts/Report.pdf` })).statusCode, 200, `${label}: staff`);
    };
    const expectReadable = async (label: string) => {
      assert.equal((await asCustomer(`${base}/artifacts/Report.pdf`)).body, '%PDF-1.4 unapproved report', `${label}: Report.pdf`);
      assert.equal((await asCustomer(`${base}/artifacts/model_data.xml`)).statusCode, 200, `${label}: model`);
      const detail = (await asCustomer(base)).json().project;
      assert.ok(detail.files.some((file: { name: string }) => file.name === 'Report.pdf'), `${label}: detail lists the report`);
    };

    await expectWithheld('in QA');
    await storage.patchManifest(id, { status: 'requeue' });
    await expectWithheld('sent back for rework');

    await storage.patchManifest(id, { status: 'completed' });
    await expectReadable('delivered');

    // Held for its release window, a completed report still looks in review (FM-383).
    const later = new Date(Date.now() + 3600_000).toISOString();
    await storage.patchManifest(id, { delivery_hold_status: 'holding', delivery_hold_scheduled_release_at: later });
    await expectWithheld('held for release');
    await storage.patchManifest(id, { delivery_hold_status: 'released' });
    await expectReadable('released');

    // Changes the customer asked of a delivered report keep it readable meanwhile.
    await storage.patchManifest(id, { status: 'rework_requested' });
    await expectReadable('customer rework');

    assert.equal(customerMayReadReport({ status: 'awaiting_review', customer_rework_in_qa: true }), true, 'customer rework in QA');
    for (const status of ['queued', 'in_progress', 'awaiting_review', 'awaiting_manager_review', 'requeue', 'rejected', 'cancelled']) {
      assert.equal(customerMayReadReport({ status }), false, status);
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
});
