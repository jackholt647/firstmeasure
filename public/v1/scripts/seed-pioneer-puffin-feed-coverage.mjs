/** Add genuine, openable Feed examples to the newest Pioneer Puffin dev org. */
const base = 'https://dev.1m8.ai';
const apply = process.argv.includes('--apply');
async function request(path, options = {}) {
  const response = await fetch(base + path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${JSON.stringify(body).slice(0, 700)}`);
  return body;
}
const state = await request('/v1/signup-sandbox/state');
const org = state.test_orgs.filter((item) => String(item.org_name || '').startsWith('Pioneer Puffin Test Co'))
  .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
if (!org || org.workflow_id !== 'swf_instant_full_org') throw new Error('Newest Pioneer Puffin full org not found');
const login = await fetch(`${base}/v1/signup-sandbox/test-orgs/${encodeURIComponent(org.id)}/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
});
if (!login.ok) throw new Error(`Sandbox login: ${login.status}`);
const cookies = login.headers.getSetCookie().map((line) => line.split(';', 1)[0]);
const csrf = cookies.find((cookie) => cookie.slice(0, cookie.indexOf('=')).endsWith('_csrf'));
if (!csrf) throw new Error('CSRF cookie missing');
const headers = { cookie: cookies.join('; '), 'x-platform-csrf': decodeURIComponent(csrf.slice(csrf.indexOf('=') + 1)) };
const platform = `/v1/platform/organizations/${encodeURIComponent(org.org_id)}`;
const payments = `/v1/payments/organizations/${encodeURIComponent(org.org_id)}`;
const get = (path) => request(path, { headers });
const post = (path, body) => request(path, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const projects = (await get(`${platform}/projects`)).documents
  .filter((item) => item.data?.workflow_state === 'project' && item.data?.tags?.includes('Synthetic'))
  .sort((a, b) => String(a.id).localeCompare(String(b.id)));
if (projects.length < 13) throw new Error(`Expected synthetic projects; found ${projects.length}`);
const examples = [
  { offset: 0, type: 'receipt', title: 'Sample material receipt', content: 'SYNTHETIC TEST RECEIPT\nShingles and underlayment\nTotal: $486.25\n' },
  { offset: 1, type: 'invoice', title: 'Sample customer invoice document', content: 'SYNTHETIC TEST INVOICE DOCUMENT\nRoof repair labor and materials\nTotal: $1,240.00\n' },
  { offset: 2, type: 'roof_report', title: 'Sample roof inspection report', content: 'SYNTHETIC TEST ROOF REPORT\nInspection: flashing, valleys, and ridge.\nRecommendation: replace damaged flashing before shingle installation.\n' },
  { offset: 3, type: 'contract', title: 'Sample roofing contract', content: 'SYNTHETIC TEST CONTRACT\nScope: replace the existing roof covering and inspect deck condition.\nStatus: draft; no signatures have been collected.\n' },
  { offset: 4, type: 'document', title: 'Sample site access instructions', content: 'SYNTHETIC TEST DOCUMENT\nKeep the rear walkway open during the installation.\n' }
];
const result = { mode: apply ? 'applied' : 'dry-run', org: org.org_name, documents: [], invoice: '', expense: '' };
for (const example of examples) {
  const project = projects[example.offset];
  const path = `${platform}/projects/${encodeURIComponent(project.id)}/documents`;
  const existing = (await get(path)).documents || [];
  if (existing.some((doc) => doc.title === example.title)) { result.documents.push(`${example.type}: exists`); continue; }
  if (!apply) { result.documents.push(`${example.type}: would create`); continue; }
  const payload = {
    file_name: `${example.type}-synthetic-test.txt`, content_type: 'text/plain',
    base64: Buffer.from(example.content).toString('base64'),
    metadata: { title: example.title, document_type: example.type, source: 'development_feed_fixture', synthetic: true }
  };
  await post(path, payload);
  result.documents.push(`${example.type}: created`);
}
const invoiceProject = projects[6];
const invoicePath = `${payments}/projects/${encodeURIComponent(invoiceProject.id)}/invoices`;
const invoices = (await get(invoicePath)).invoices || [];
if (invoices.some((item) => String(item.notes || '').includes('Pioneer Puffin Feed test'))) result.invoice = 'exists';
else if (!apply) result.invoice = 'would create';
else {
  await post(invoicePath, { line_items: [{ type: 'manual', description: 'Synthetic roof repair test item', amount_cents: 124000 }],
    notes: 'Pioneer Puffin Feed test. Synthetic invoice; do not send to a customer.' });
  result.invoice = 'created';
}
const expenseProject = projects[7];
const expensePath = `${payments}/projects/${encodeURIComponent(expenseProject.id)}/expenses`;
const expenseSummary = await get(`${payments}/projects/${encodeURIComponent(expenseProject.id)}/expense-summary`);
if (JSON.stringify(expenseSummary).includes('pioneer-puffin-feed-expense')) result.expense = 'exists';
else if (!apply) result.expense = 'would create';
else {
  await post(expensePath, { title: 'Synthetic underlayment material expense', resource_type: 'material', projected_cents: 48625,
    notes: 'Pioneer Puffin Feed test. No payment was made.', metadata: { synthetic: true, sample_key: 'pioneer-puffin-feed-expense' } });
  result.expense = 'created';
}
console.log(JSON.stringify(result, null, 2));
