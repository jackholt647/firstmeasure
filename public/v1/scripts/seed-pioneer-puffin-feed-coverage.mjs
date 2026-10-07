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
const result = { mode: apply ? 'applied' : 'dry-run', org: org.org_name, documents: [], invoice: '', expense: '', inbound_message: '', call: '', proposal: '' };
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
const channels = `/v1/channels/organizations/${encodeURIComponent(org.org_id)}`;
const catalog = await get(`${channels}/feed/catalog`);
if ((catalog.events || []).some((event) => event.type === 'communication.received')) result.inbound_message = 'exists';
else if (!apply) result.inbound_message = 'would create';
else {
  const project = projects[8];
  const contact = project.data?.contacts?.[0] || {};
  await post(`/v1/messaging/developer/organizations/${encodeURIComponent(org.org_id)}/inbound`, {
    channel: 'email',
    from: { address: contact.email || 'feed.customer@example.test', name: contact.name || 'Synthetic customer', contact_id: contact.id || '' },
    to: { address: 'office@pioneerpuffin.example.test', name: 'Pioneer Puffin Test Co' },
    content: { subject: 'Synthetic roof inspection question', text: 'Can you confirm the roof inspection appointment and where I can find the photos?' },
    context: { project_id: project.id, contact_id: contact.id || '' },
    metadata: { synthetic: true, source: 'development_feed_fixture' }
  });
  result.inbound_message = 'created';
}
if ((catalog.events || []).some((event) => event.type === 'call.completed')) result.call = 'exists';
else if (!apply) result.call = 'would create';
else {
  const project = projects[9];
  const contact = project.data?.contacts?.[0] || {};
  const path = `/v1/comms/organizations/${encodeURIComponent(org.org_id)}/calls`;
  const { call } = await post(path, { operation_id: 'pioneer-puffin-feed-test-call-20261007', mode: 'external', direction: 'outbound',
    project_id: project.id, contact_id: contact.id || '', customer_number: contact.phone || '+12025550199',
    customer_name: contact.name || 'Synthetic customer', purpose: 'Synthetic roof inspection follow-up' });
  await post(`${path}/${encodeURIComponent(call.id)}/wrap-up`, { operation_id: 'pioneer-puffin-feed-test-call-wrap-20261007',
    revision: call.revision, disposition: 'answered', next_action: 'none',
    notes: 'Synthetic development call record for Feed testing; no live telephone connection was made.' });
  result.call = 'created';
}
const proposalProject = projects[10];
const proposalPath = `/v1/documents/organizations/${encodeURIComponent(org.org_id)}/projects/${encodeURIComponent(proposalProject.id)}/documents`;
const proposalTitle = 'Synthetic roof replacement proposal for Feed testing';
let proposal = (await get(proposalPath)).documents?.find((item) => item.title === proposalTitle);
if (!proposal && apply) {
  const created = await post(proposalPath, { document_type: 'proposal', template_id: 'tpl_proposal_default',
    title: proposalTitle, metadata: { synthetic: true, source: 'development_feed_fixture' } });
  proposal = created.document;
}
if (!proposal) result.proposal = 'would create, send, and view';
else {
  const docPath = `/v1/documents/organizations/${encodeURIComponent(org.org_id)}/documents/${encodeURIComponent(proposal.id)}`;
  if (!proposal.delivery?.sent_at && apply) {
    const sent = await post(`${docPath}/send`, { recipients: [{ name: 'Synthetic customer', email: 'feed.customer@example.test', role: 'customer' }],
      include_pdf: false, include_portal: true, consent_contact: 'feed.customer@example.test',
      message: 'Synthetic development proposal for Feed layout testing.' });
    proposal = sent.document;
    result.proposal = `sent (${sent.emailed?.[0]?.success ? 'captured email' : 'email not delivered'})`;
  } else result.proposal = proposal.delivery?.sent_at ? 'already sent' : 'draft';
  const token = proposal.delivery?.public_token;
  if (token && !proposal.delivery?.first_viewed_at && apply) {
    await post(`/v1/documents/public/${encodeURIComponent(token)}/view`, {
      session_id: 'pioneer-puffin-feed-fixture-20261007', metadata: { synthetic: true, source: 'development_feed_fixture' }
    });
    result.proposal += ', viewed';
  } else if (proposal.delivery?.first_viewed_at) result.proposal += ', already viewed';
}
console.log(JSON.stringify(result, null, 2));
if (process.argv.includes('--audit')) {
  const latestCatalog = await get(`${channels}/feed/catalog`);
  const types = Object.entries((latestCatalog.events || []).reduce((counts, event) => {
    counts[event.type] = (counts[event.type] || 0) + 1;
    return counts;
  }, {})).sort(([left], [right]) => left.localeCompare(right));
  console.log(JSON.stringify({ event_types: Object.fromEntries(types), projects: latestCatalog.projects?.length,
    media: latestCatalog.media?.length, users: latestCatalog.users?.length }, null, 2));
}
