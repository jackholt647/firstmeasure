// The Materials order window's ordering rules, run from the real project.js functions with their surroundings stubbed:
// sending one supplier marks only its lists ordered, Mark as ordered sends nothing, an order keeps its delivery date when
// scheduling is unavailable, the email carries what the Email tab chose, purchase order lines are priced per order
// unit, and every list can be deleted.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../libraries/apps/materials/project.js', import.meta.url), 'utf8');
function fn(name) {
  const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
const cleanText = (value) => String(value ?? '').trim();

function orderContext(extra = {}) {
  const lists = { a: { id: 'a', title: 'Roof', status: 'planning' }, b: { id: 'b', title: 'Gutters', status: 'planning' }, c: { id: 'c', title: 'Siding', status: 'ordered' } };
  const calls = [];
  const ctx = {
    calls, lists, cleanText,
    state: { saving: false, orderPurchaseOrders: {} },
    materialListOrdered: (list) => list.status === 'ordered',
    materialListById: (id) => lists[id],
    selectedOrderLists: () => Object.values(lists),
    orderGroupName: (group) => group.choice.name,
    orderGroupKey: (group) => group.key,
    sendSupplierOrder: async (group) => { calls.push(['send', group.key]); if (group.fail) throw new Error('mailbox full'); return { po_number: `PO-${group.key}`, document_id: `doc_${group.key}` }; },
    recordSupplierOrder: async (group, groupLists, options) => { calls.push(['record', group.key, groupLists.map((list) => list.id), options.method, options.purchaseOrder?.po_number || '']); groupLists.forEach((list) => { list.status = 'ordered'; }); },
    showToast: (title, body, ok) => calls.push(['toast', title, ok]),
    setWorkspaceSaving() {}, materialRoot: () => null, loadActiveListDetails: async () => {}, syncScopeListCard() {}, syncMaterialsGrid() {}, syncOrderDialog: (open) => calls.push(['sync', open]),
    window: { dispatchEvent() {} }, CustomEvent: class { constructor(type) { this.type = type; } },
    ...extra
  };
  vm.createContext(ctx);
  vm.runInContext(fn('placeOrders'), ctx);
  return ctx;
}

test('sending one supplier records only that supplier\'s lists, with its purchase order', async () => {
  const ctx = orderContext();
  const abc = { key: 'abc', choice: { name: 'ABC Supply', email: 'orders@abc.test' }, lists: [ctx.lists.a] };
  const beacon = { key: 'beacon', choice: { name: 'Beacon', email: 'orders@beacon.test' }, lists: [ctx.lists.b, ctx.lists.c] };
  assert.equal(await ctx.placeOrders([abc], { send: true }), true);
  assert.deepEqual(ctx.calls.filter(([kind]) => kind === 'send' || kind === 'record'), [['send', 'abc'], ['record', 'abc', ['a'], 'email', 'PO-abc']]);
  assert.equal(ctx.lists.b.status, 'planning', 'the other supplier\'s list is untouched');
  ctx.calls.length = 0;
  await ctx.placeOrders([beacon], { send: true });
  assert.deepEqual(ctx.calls.filter(([kind]) => kind === 'record'), [['record', 'beacon', ['b'], 'email', 'PO-beacon']], 'an already ordered list is not ordered again');
});

test('one supplier failing does not hold back or mark another', async () => {
  const ctx = orderContext();
  const abc = { key: 'abc', fail: true, choice: { name: 'ABC Supply', email: 'orders@abc.test' }, lists: [ctx.lists.a] };
  const beacon = { key: 'beacon', choice: { name: 'Beacon', email: 'orders@beacon.test' }, lists: [ctx.lists.b] };
  assert.equal(await ctx.placeOrders([abc, beacon], { send: true }), false);
  assert.deepEqual(ctx.calls.filter(([kind]) => kind === 'record').map((call) => call[1]), ['beacon']);
  assert.equal(ctx.lists.a.status, 'planning');
  assert.ok(ctx.calls.some(([kind, title, ok]) => kind === 'toast' && ok === false && /did not go through/.test(title)));
});

test('Mark as ordered sends nothing and needs no supplier email', async () => {
  const ctx = orderContext();
  ctx.state.orderPurchaseOrders.abc = { po_number: 'PO-1004', document_id: 'doc_po_1' };
  const abc = { key: 'abc', choice: { name: '', email: '' }, lists: [ctx.lists.a, ctx.lists.b] };
  await ctx.placeOrders([abc], { send: false });
  assert.deepEqual(ctx.calls.filter(([kind]) => kind === 'send'), []);
  assert.deepEqual(ctx.calls.filter(([kind]) => kind === 'record'), [['record', 'abc', ['a', 'b'], 'marked', 'PO-1004']]);
  ctx.calls.length = 0;
  const unaddressed = orderContext();
  assert.equal(await unaddressed.placeOrders([{ key: 'x', choice: { name: '', email: '' }, lists: [unaddressed.lists.a] }], { send: true }), false, 'sending still needs an address');
  assert.deepEqual(unaddressed.calls.filter(([kind]) => kind === 'record'), []);
});

test('an order keeps its delivery date when it cannot be put on the schedule', async () => {
  const created = [];
  const list = { id: 'a', title: 'Roof', revision: 3, current_items: [] };
  const ctx = {
    cleanText, state: { orderProvider: 'manual', lists: [list], orders: [] },
    Intl, globalThis: {},
    materialListById: () => list, orderSupplierChoice: () => ({ target: null, email: 'orders@abc.test', delivery: true }), orderGroupTarget: () => null,
    orderSchedule: () => ({ date: '2026-10-27', time: 'Morning (8am - 12pm)' }), orderTimeClock: () => '',
    schedulingOn: () => true, persistInlineDeliverySchedule: async () => { throw new Error('The schedule could not be saved'); },
    orderEmailOptions: () => ({ attach: true, table: false }), defaultOrderSourceId: () => 'manual', materialListColor: () => '#123456',
    listItems: () => [], apiReady: () => true, updateMaterialListState() {}, todayIso: () => '2026-10-22', uid: () => 'id',
    materialsAPI: { lists: { createOrder: async (org, id, payload) => { created.push(payload); return { material_list: { ...list, status: 'ordered' } }; } } },
    orgId: () => 'org'
  };
  vm.createContext(ctx);
  vm.runInContext(fn('recordSupplierOrder'), ctx);
  await ctx.recordSupplierOrder({ key: 'abc' }, [list], { method: 'email', purchaseOrder: { po_number: 'PO-1001', document_id: 'doc_po_1' } });
  assert.equal(created.length, 1);
  assert.equal(created[0].scheduled_window.date, '2026-10-27');
  assert.equal(created[0].scheduled_window.time_label, 'Morning (8am - 12pm)');
  assert.equal(created[0].delivery_status, 'scheduled');
  assert.equal(created[0].schedule_event_id, '');
  assert.equal(created[0].metadata.order_method, 'email');
  assert.equal(created[0].metadata.po_number, 'PO-1001');
  assert.deepEqual(JSON.parse(JSON.stringify(created[0].metadata.email_parts)), { attach: true, table: false });
  // With scheduling off no schedule event is attempted, and the order still carries its date.
  let attempted = 0;
  ctx.schedulingOn = () => false;
  ctx.persistInlineDeliverySchedule = async () => { attempted += 1; return {}; };
  await ctx.recordSupplierOrder({ key: 'abc' }, [list], { method: 'marked', purchaseOrder: null });
  assert.equal(attempted, 0);
  assert.equal(created[1].scheduled_window.date, '2026-10-27');
  assert.equal(created[1].metadata.order_method, 'marked');
});

test('the email carries the order date, and the table or the attached purchase order as chosen', () => {
  const rows = [{ name: 'Shingles', detail: 'Color: Charcoal', details: [{ label: 'Color', value: 'Charcoal' }], quantity: 32, unit: 'bundle' }];
  const ctx = {
    cleanText, escapeHtml: (value) => String(value ?? ''), state: { project: { address: '68 Northfield Rd' } }, globalThis: {},
    orderDeliveryGroups: (lists) => [{ id: 'a', lists, schedule: { date: '2026-10-27' } }], orderDeliveryInstruction: () => 'I need the Roof delivery on Tuesday, October 27, 2026.',
    orderGroupTitle: () => 'Roof', orderRequestRows: () => rows, orderRequestSubject: () => 'Material delivery request - 68 Northfield Rd', orderDateLabel: () => 'Thu, Oct 22, 2026', orderRequestDetailsHtml: () => ''
  };
  vm.createContext(ctx);
  for (const name of ['orderEmailFacts', 'orderRequestText', 'orderRequestHtml', 'orderRequestPreviewHtml']) vm.runInContext(fn(name), ctx);
  const both = ctx.orderRequestText([{ id: 'a' }], { attach: true, table: true, poNumber: 'PO-1001' });
  assert.match(both, /Order date: Thu, Oct 22, 2026/);
  assert.match(both, /Purchase order: PO-1001 \(attached\)/);
  assert.match(both, /Shingles\tColor: Charcoal\t32\tbundle/);
  assert.match(both, /October 27, 2026/, 'the requested delivery date is in the email');
  const attachedOnly = ctx.orderRequestText([{ id: 'a' }], { attach: true, table: false, poNumber: 'PO-1001' });
  assert.doesNotMatch(attachedOnly, /Shingles/);
  assert.match(attachedOnly, /on the attached purchase order/);
  const tableOnly = ctx.orderRequestHtml([{ id: 'a' }], { attach: false, table: true });
  assert.match(tableOnly, /<table/);
  assert.doesNotMatch(tableOnly, /Purchase order/);
  assert.match(tableOnly, /Order date:<\/strong> Thu, Oct 22, 2026/);
  const preview = ctx.orderRequestPreviewHtml([{ id: 'a' }], { attach: true, table: false });
  assert.doesNotMatch(preview, /<table/);
  assert.match(preview, /Purchase order:<\/strong> Attached/);
});

test('purchase order lines are priced per order unit from the chosen supplier', () => {
  const item = { id: 'i1', quantity: 30, code: 'SH-30', projected_unit_price: 30 };
  const ctx = {
    cleanText, Number, Math,
    number: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    supplierQuote: () => ({ prices: new Map([['i1', 1200]]) }),
    orderableItems: () => [item],
    orderRequestRows: () => [{ name: 'Shingles', details: [{ label: 'SKU', value: 'SH-30' }, { label: 'Color', value: 'Charcoal' }], quantity: 10, unit: 'bundle' }]
  };
  vm.createContext(ctx);
  vm.runInContext(fn('purchaseOrderLines'), ctx);
  const [line] = ctx.purchaseOrderLines({ choice: { target: { key: 'abc' } }, lists: [{ id: 'list_a' }] });
  assert.equal(line.total_cents, 36000, '30 squares at $12');
  assert.equal(line.quantity, 10);
  assert.equal(line.unit_price_cents, 3600, 'per bundle');
  assert.equal(line.sku, 'SH-30');
  assert.equal(line.details, 'Color: Charcoal', 'the SKU has its own column');
  const [estimated] = ctx.purchaseOrderLines({ choice: { target: null }, lists: [{ id: 'list_a' }] });
  assert.equal(estimated.total_cents, 90000, 'with no supplier the list\'s own price is used');
});

test('every material list can be deleted, including a generated one and the last one', () => {
  const ctx = {
    cleanText, escapeHtml: (value) => String(value ?? ''), state: { pricebookOpen: false, schedulingListId: '' },
    materialListOrdered: () => false, assignmentWorkResourceRef: () => null, laborListFinalized: () => false, resourceScheduleEnabled: () => false
  };
  vm.createContext(ctx);
  vm.runInContext(fn('renderListHeaderActions'), ctx);
  const html = ctx.renderListHeaderActions({ id: 'set_1', metadata: { calculus: true } }, 'material', 'Roof');
  const remove = html.match(/<button[^>]*data-mt-delete-list="set_1"[^>]*>/)[0];
  assert.doesNotMatch(remove, /disabled/);
});
