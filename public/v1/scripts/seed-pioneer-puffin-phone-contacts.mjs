/** Add a small, repeatable contact set to the newest Pioneer Puffin test org. */
import { createHash } from 'node:crypto';

const base = 'https://dev.1m8.ai';
const apply = process.argv.includes('--apply');
const people = [
  { name: 'Taylor Reed', phone: '+12025550131', email: 'taylor.reed@example.test' },
  { name: 'Jordan Ellis', phone: '+12025550142', email: 'jordan.ellis@example.test' }
];
const id = (kind, value) => `${kind}_sample_${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;

async function request(path, options = {}) {
  const response = await fetch(base + path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${JSON.stringify(body.error || body.message || body).slice(0, 400)}`);
  return { response, body };
}

const { body: state } = await request('/v1/signup-sandbox/state');
const org = state.test_orgs
  .filter((entry) => String(entry.org_name || '').startsWith('Pioneer Puffin Test Co'))
  .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
if (!org || org.workflow_id !== 'swf_instant_full_org') throw new Error('Newest Pioneer Puffin org is not an Instant Full Org.');
const { response: login } = await request(`/v1/signup-sandbox/test-orgs/${encodeURIComponent(org.id)}/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
});
const cookies = login.headers.getSetCookie().map((line) => line.split(';', 1)[0]);
const csrfCookie = cookies.find((cookie) => cookie.slice(0, cookie.indexOf('=')).endsWith('_csrf'));
if (!csrfCookie) throw new Error('Sandbox login did not return a CSRF cookie.');
const headers = { cookie: cookies.join('; '), 'content-type': 'application/json',
  'x-platform-csrf': decodeURIComponent(csrfCookie.slice(csrfCookie.indexOf('=') + 1)) };
const prefix = `/v1/platform/organizations/${encodeURIComponent(org.org_id)}`;
const { body: projects } = await request(`${prefix}/projects`, { headers });
const projectIds = new Set((projects.documents || []).map((doc) => doc.id));
let projectsAdded = 0;
for (const person of people) {
  const contactId = id('contact', `${org.org_id}:${person.email}`);
  const projectId = id('project', `${org.org_id}:${person.email}`);
  const contact = { id: contactId, contact_id: contactId, ...person, primary: true,
    contact_kind: 'human', notes: 'Synthetic contact for phone testing.' };
  if (!projectIds.has(projectId)) {
    projectsAdded++;
    if (apply) await request(`${prefix}/projects`, { method: 'POST', headers, body: JSON.stringify({
      id: projectId, data: { id: projectId, title: person.name, project_title: person.name,
        contacts: [contact], workflow_state: 'contact_only', project_type: 'residential',
        measurement: {}, measurement_project: {}, events: [], proposals: [] },
      metadata: { kind: 'platform_project', workflow_state: 'contact_only', synthetic: true,
        source: 'development_pioneer_puffin_phone_contacts' }
    }) });
  }
}
if (apply) {
  const { body: savedProjects } = await request(`${prefix}/projects`, { headers });
  for (const person of people) {
    const contactId = id('contact', `${org.org_id}:${person.email}`);
    const projectId = id('project', `${org.org_id}:${person.email}`);
    if (!savedProjects.documents.some((doc) => doc.id === projectId && doc.data?.contacts?.some((entry) => entry.id === contactId))) throw new Error(`Contact app record missing: ${person.name}`);
  }
}
console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', org: org.org_name, org_id: org.org_id,
  contacts: people.map(({ name, phone }) => ({ name, phone })), projects_added: projectsAdded }, null, 2));
