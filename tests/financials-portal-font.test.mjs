import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// GP-53: the portal draws text in the font /fonts.css puts on elements
// (Montserrat). Inter is not loaded on the portal, so a Financials rule that
// names it falls back to the system font and its buttons look out of place.
const source = readFileSync(new URL('../public/libraries/apps/financials/app.js', import.meta.url), 'utf8');

test('Financials CSS never names Inter or system-ui as its font', () => {
  const offenders = source.match(/font(?:-family)?:[^;}"'`]*\b(?:Inter|system-ui)\b[^;}]*/g) || [];
  assert.deepEqual(offenders, []);
});

test('Financials CSS has no font shorthand ending in inherit (invalid, dropped by the browser)', () => {
  const offenders = source.match(/font:\s*[^;}]*\d(?:px|em|rem)[^;}]*\binherit\b/g) || [];
  assert.deepEqual(offenders, []);
});
