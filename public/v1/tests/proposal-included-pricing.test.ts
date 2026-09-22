import assert from 'node:assert/strict';
import test from 'node:test';
import { proposalScopeTotalCents } from '../proposals/scope.js';

test('included package work contributes to the same total as priced customer selections', () => {
  const included = [
    ['Tear-off', 20, 85], ['Starter', 200, 2.45], ['Ridge cap', 210, 4.25],
    ['Drip edge', 200, 3.25], ['Valley metal', 100, 8.75], ['Ridge vent', 100, 7.5],
  ].map(([name, quantity, unit_price], index) => ({ id: `included-${index}`, name, quantity, unit_price, included: true }));
  const scope = { root_items: [{ id: 'roof', quantity: 1, unit_price: 0, children: [
    ...included,
    { id: 'shingle', quantity: 20, unit_price: 398 },
    { id: 'underlayment', quantity: 20, unit_price: 42 },
    { id: 'barrier', quantity: 3, unit_price: 78 },
    { id: 'unchosen', quantity: 20, unit_price: 465, selection: { mode: 'choice', selected: false } },
    { id: 'non-chargeable', quantity: 1, unit_price: 999, included: true, price_driving: false },
  ] }] };
  assert.equal(proposalScopeTotalCents(scope), 1439150);
  assert.equal(proposalScopeTotalCents({ root_items: included }), 535750);
});

test('zero-price included items remain free and included children of unselected options are excluded', () => {
  assert.equal(proposalScopeTotalCents({ root_items: [
    { id: 'free', quantity: 1, unit_price: 0, included: true },
    { id: 'option', selection: { mode: 'choice', selected: false }, children: [
      { id: 'child', quantity: 1, unit_price: 250, included: true },
    ] },
  ] }), 0);
});
