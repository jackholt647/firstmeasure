import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const files = [
  '../measure/internal/portal_scripts/qa.js',
  '../measure/internal/editor_scripts/notes_overlay.js'
];

for (const file of files) {
  const source = await readFile(file, 'utf8');
  assert.doesNotMatch(source, /qaNewIssueSeverity|qaReplySeverity|normalizeThreadSeverity|severity-badge/);
}

const reportSource = await readFile('../measure/internal/editor_scripts/report.js', 'utf8');
assert.doesNotMatch(reportSource, /severity:\s*resolveImmediately/);
const qualitySource = await readFile('../measure/internal/portal_scripts/manager_review.js', 'utf8');
assert.match(qualitySource, /id="mraReviewSeverity"/);
assert.match(qualitySource, /severity:selected.length/);
assert.match(qualitySource, /id="mraRFSeverity"/);

console.log('PASS: minor/major severity belongs to QA Quality, not regular QA feedback.');
