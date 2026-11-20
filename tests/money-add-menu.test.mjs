// GP-129: the phone's + menu on the project Finance tab offers taking and recording a payment as two choices, with no
// chooser between them. Take a Payment goes straight into payment setup while online payments are not set up (for
// whoever can set them up), otherwise to the charge form; Record a Payment opens the record form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const money = readFileSync(new URL('../public/libraries/apps/money/project.js', import.meta.url), 'utf8');
const fn = (name) => {
  const start = money.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const end = money.indexOf('\n  }\n', start);
  return money.slice(start, end);
};

test('the + menu lists Take a Payment and Record a Payment as separate items', () => {
  const menu = fn('addMenuModalHtml');
  const take = menu.indexOf("item('take_payment'");
  const record = menu.indexOf("item('add_payment'");
  assert.ok(take >= 0 && record > take, 'Record a Payment follows Take a Payment');
  assert.match(menu, /item\('add_payment', '[^']+', 'Record a Payment'/);
});

test('Take a Payment starts payment setup while it is pending; the other items open their own modal', () => {
  const run = fn('runAddAction');
  assert.match(run, /action === 'take_payment' && paymentsSetupPending\(\) && canSetUpPayments\(\)[\s\S]{0,120}startPaymentSetup\(\)/);
  assert.match(run, /openModal\(\{ type:action \}\)/, 'add_payment opens the record form directly');
  assert.match(money, /add_payment:addPaymentModalHtml/);
});
