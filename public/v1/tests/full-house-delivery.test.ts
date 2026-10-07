import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { isCustomerFullHouse, assertFullHouseReview, FULL_HOUSE_REVIEW_FIELDS } from '../firstmeasure/full_house_workflow.js';

test('delivery attaches the saved full report, records receipt, and refuses an unreviewed revision', async () => {
  const source = await readFile(new URL('../firstmeasure/api.ts', import.meta.url), 'utf8');
  const section = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const code = section('async function sendProjectEmail(', 'function projectEmailFailureMessage(')
    + section('function buildReportEmailTextBody(', 'function projectTypeLabelForCustomer(');
  const pdf = Buffer.from('%PDF full house with gutters');
  const review = { ...Object.fromEntries(FULL_HOUSE_REVIEW_FIELDS.map(key => [key, true])), revision: 'reviewed' };
  const manifest: Record<string, any> = { id: 'exteriors_' + 'b'.repeat(32), measurement_scope: 'full_house', status: 'completed',
    address: 'Synthetic house', issuer: { email: 'customer@example.test' }, qa_full_house_review: review };
  const messages: any[] = [];
  const context = vm.createContext({
    isCustomerFullHouse, assertFullHouseReview, asRecord: (value: unknown) => value || {},
    conflict: (code: string, message: string) => Object.assign(new Error(message), { code }),
    readManifest: async () => manifest, buildLegacyManifest: (value: unknown) => value,
    resolveProjectPdfSyncReference: async () => ({ revision: 'reviewed' }),
    getCompletedCustomerReworkForDelivery: () => null,
    getProjectEmailSummary: () => ({ report_email: manifest.email_state?.report_email || {} }),
    normalizeReportReleaseExpediteOption: () => 'exteriors_standard', reportReleaseHoldEnabled: async () => false,
    isPriorityOneReportProject: () => false, REPORT_EXPEDITE_UNDER_1_KEY: 'under_1', REPORT_EXPEDITE_1_3_KEY: 'one_three',
    sanitizeEmailFileLabel: String, readStoredPdf: async (_id: string, slot: string) => slot === 'main' ? { content: pdf } : null,
    readStoredXml: async () => null, projectIncludesWeatherReport: () => false,
    bonusOfferEmailTeaserForProject: async () => false, APP_ORDER_REPORT_URL: 'https://example.test/order', escapeHtml: String,
    sendPostmarkEmail: async (message: unknown) => { messages.push(message); return { ok: true, postmark: { MessageID: 'captured-receipt' } }; },
    buildReportReleasePatch: () => ({}), patchManifest: async (_id: string, patch: object) => Object.assign(manifest, patch)
  });
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  await vm.runInContext('sendProjectEmail("fixture", false)', context);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].subject, 'Full House Report - Synthetic house');
  assert.match(messages[0].textBody, /Your full-house report is ready/);
  assert.match(messages[0].htmlBody, /Your full-house report is ready/);
  assert.deepEqual(Buffer.from(messages[0].attachments[0].Content, 'base64'), pdf);
  assert.equal(manifest.delivery.email_state.report_email.message_id, 'captured-receipt');
  assert.equal(manifest.delivery.email_state.report_email.sent_ok, true);
  await vm.runInContext('sendProjectEmail("fixture", false)', context);
  assert.equal(messages.length, 1, 'an accepted delivery is not sent again');
  manifest.qa_full_house_review.revision = 'older';
  await assert.rejects(vm.runInContext('sendProjectEmail("fixture", true)', context), { code: 'full_house_qa_required' });
  assert.equal(messages.length, 1, 'force resend cannot bypass full-house QA');
  manifest.id = 'roof'; manifest.measurement_scope = 'roof'; manifest.email_state = {};
  await vm.runInContext('sendProjectEmail("roof", false)', context);
  assert.equal(messages[1].subject, 'Roof Report - Synthetic house');
  assert.match(messages[1].textBody, /Your roof report is ready!/);
});
