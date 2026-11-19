// The Scheduling "+ Appointment" button (desktop and phone) is drawn in the organization's
// primary color, never a hard-coded red (GP-83).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/libraries/apps/scheduling/app.js'), 'utf8');
const rules = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...source.matchAll(new RegExp(`(?:^|[\\s},])${escaped}(?=[{,:\\s\\[])[^{]*\\{([^}]*)\\}`, 'gm'))].map((m) => m[1]);
};

test('the appointment button uses the primary color', () => {
  const [body] = rules('.dash-new-appointment');
  assert.ok(body, 'no .dash-new-appointment rule');
  assert.match(body, /background:var\(--primary,#d93025\)/);
  assert.match(body, /color:var\(--on-primary,#fff\)/);
});

test('no appointment button rule hard-codes a red', () => {
  for (const selector of ['.dash-new-appointment', '.dash-mobile-appointment']) {
    for (const body of rules(selector)) {
      assert.doesNotMatch(body, /(^|[;:\s])#(d93025|b42318)\b/i, `${selector}{${body}}`);
    }
  }
});
