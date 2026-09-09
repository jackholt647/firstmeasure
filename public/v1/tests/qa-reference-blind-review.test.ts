import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const report = readFileSync(new URL('../../measure/internal/editor_scripts/report.js', import.meta.url), 'utf8');
const qa = readFileSync(new URL('../../measure/internal/portal_scripts/qa.js', import.meta.url), 'utf8');
const escapeHtml = (value: unknown) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

for (const submitted_at of ['', '2026-09-09T12:00:00Z']) {
  test(`QA reference rendering omits uploader identity with ${submitted_at ? 'timestamp' : 'no timestamp'}`, () => {
    const sources = { submitted_by: 'Private Technician Name', submitted_at, notes: 'Reference note', images: [{ url: '/sample.png', title: 'Reference 1' }] };
    const reportContext = vm.createContext({ normalizeQaSubmissionSourcesForReview: () => sources, escapeHtml });
    vm.runInContext(report.slice(report.indexOf('function renderQaSubmissionSourcesReviewHtml('), report.indexOf('function wireQaSubmissionSourcesReview(')), reportContext);
    const html = reportContext.renderQaSubmissionSourcesReviewHtml({});
    assert.doesNotMatch(html, /Private Technician Name|Submitted by/);
    assert.match(html, /data-qa-src-notes/);
    assert.match(html, /sample.png/);
    const hosts = [0].map(() => ({ innerHTML: '', classList: { add() {}, remove() {} }, querySelectorAll: () => [] }));
    const qaContext = vm.createContext({
      document: { getElementById: (id: string) => hosts[id === 'qaSubmissionRefs' ? 0 : 1] },
      currentManifest: {}, getSubmissionSources: () => sources,
      resolveFirstMeasureAssetUrl: (url: string) => url, fmtDate: (date: string) => date, esc: escapeHtml
    });
    const start = qa.indexOf('  function renderSubmissionSources(){');
    const end = qa.indexOf('  // ----------------- REJECTION REVIEW', start);
    vm.runInContext(qa.slice(start, end), qaContext);
    qaContext.renderSubmissionSources();
    for (const host of hosts) {
      assert.doesNotMatch(host.innerHTML, /Private Technician Name|Submitted by/);
      assert.match(host.innerHTML, /sample.png/);
    }
    assert.equal(sources.submitted_by, 'Private Technician Name', 'audit metadata stays intact');
  });
}
