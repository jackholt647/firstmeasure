// The staff "New appointment" dialog (appointment-booking) is drawn in the organization's
// primary color, never a hard-coded red; only error text stays red (GP-86).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'public/libraries/appointment-booking');
const css = fs.readFileSync(path.join(dir, 'booking.css'), 'utf8');
const configuration = fs.readFileSync(path.join(dir, 'configuration.js'), 'utf8');
const ERROR_TEXT = /^(#fm-booking-dialog \[data-status\]|\.fm-booking-type-foot \[data-type-status\])$/;

test('no booking rule hard-codes the default red outside a var() fallback', () => {
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (ERROR_TEXT.test(selector.trim())) continue;
    const stripped = body.replace(/var\(--[\w-]+,[^()]*(?:\([^()]*\))?[^()]*\)/g, '').replace(/rgba\(var\(--primary-rgb,217,48,37\),[\d.]+\)/g, '');
    assert.doesNotMatch(stripped, /#(d93025|b42318|fff1f0|f3b3ad|fff8f7|c5281e)|%23b42318|d9302533/i, `${selector.trim()}{${body}}`);
  }
});

test('the dialog accent, primary button and shared calendar follow --primary', () => {
  assert.match(css, /#fm-booking-dialog\.fm-booking-steps\{--fm-bk-accent:var\(--primary,#d93025\)/);
  assert.match(css, /\.fm-booking-nav\.primary\{[^}]*color:var\(--on-primary,#fff\)/);
  assert.match(css, /#fm-booking-dialog \.fm-availability\{--fmle-primary:var\(--primary,#d93025\)\}/);
});

test('an appointment type without a department color falls back to the primary color', () => {
  assert.match(configuration, /dept\.color:'var\(--primary,#d93025\)'/);
  assert.doesNotMatch(configuration, /dept\.color:'#d93025'/);
});
