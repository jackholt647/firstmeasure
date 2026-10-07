/** Add dated, visual feed fixtures to the newest Pioneer Puffin test org on dev. */
import { createHash } from 'node:crypto';

const base = 'https://dev.1m8.ai';
const orgPrefix = 'Pioneer Puffin Test Co';
const apply = process.argv.includes('--apply');
const imagePaths = [
  '/portal/landing/variants/instantly-signup/media/card_residential.jpg',
  '/portal/landing/variants/instantly-signup/media/card_multifamily.jpg',
  '/portal/landing/variants/instantly-signup/media/card_commercial.jpg',
  '/portal/landing/variants/instantly-signup/media/neighborhood_header.png',
  '/portal/marketing/images/gutter_installer.png'
];
const labels = ['Roof overview', 'Exterior detail', 'Site progress', 'Finished work'];
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function request(path, options = {}) {
  const response = await fetch(base + path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${body.error || 'request failed'}`);
  }
  return { response, body };
}

const { body: state } = await request('/v1/signup-sandbox/state');
const org = state.test_orgs
  .filter((entry) => String(entry.org_name || '').startsWith(orgPrefix))
  .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
if (!org) throw new Error(`No test organization starts with ${orgPrefix}.`);
if (org.workflow_id !== 'swf_instant_full_org') throw new Error('The newest matching org is not an Instant Full Org.');

const { response: login } = await request(`/v1/signup-sandbox/test-orgs/${encodeURIComponent(org.id)}/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
});
const cookieMap = new Map(login.headers.getSetCookie().map((line) => {
  const cookie = line.split(';', 1)[0];
  return [cookie.slice(0, cookie.indexOf('=')), cookie];
}));
const cookies = [...cookieMap.values()];
const csrfCookie = cookies.find((cookie) => cookie.slice(0, cookie.indexOf('=')).endsWith('_csrf'));
if (!csrfCookie) throw new Error('Sandbox login did not return a CSRF cookie.');
const csrf = decodeURIComponent(csrfCookie.slice(csrfCookie.indexOf('=') + 1));
const headers = { cookie: cookies.join('; '), 'content-type': 'application/json', 'x-platform-csrf': csrf };
const orgPath = `/v1/platform/organizations/${encodeURIComponent(org.org_id)}`;
const { body: projectResult } = await request(`${orgPath}/projects`, { headers });
const projects = projectResult.documents
  .filter((entry) => entry.data?.workflow_state === 'project' && entry.data?.tags?.includes('Synthetic'))
  .sort((a, b) => String(a.id).localeCompare(String(b.id)));
if (!projects.length) throw new Error('This org has no connected synthetic projects.');

const now = Date.now();
let added = 0;
let skipped = 0;
const changedProjects = [];
for (const [index, project] of projects.entries()) {
  const existing = Array.isArray(project.data.photos) ? project.data.photos : [];
  const known = new Set(existing.map((photo) => String(photo.id || photo.photo_id || '')));
  const startImage = Number.parseInt(hash(project.id).slice(0, 8), 16) % imagePaths.length;
  const recentAge = (index % 6) * 2;
  const ages = [recentAge, recentAge, recentAge + 5, recentAge + 19];
  const photos = ages.map((age, slot) => {
    const id = `sample_feed_${hash(`${org.org_id}:${project.id}:${slot}`).slice(0, 24)}`;
    const uploadedAt = new Date(now - age * 86_400_000 - (slot * 37 + index * 11) * 60_000).toISOString();
    const src = imagePaths[(startImage + slot) % imagePaths.length];
    return {
      id, photo_id: id, kind: 'external_image', media_type: 'image',
      src, thumb: src, alt: labels[slot], label: labels[slot], uploaded_at: uploadedAt,
      metadata: { synthetic: true, source: 'development_feed_fixture', uploaded_at: uploadedAt,
        uploaded_by_name: 'Sample crew', tags: ['synthetic', 'feed test'] }
    };
  }).filter((photo) => !known.has(photo.id));
  if (!photos.length) { skipped += existing.length; continue; }
  changedProjects.push(project.id);
  added += photos.length;
  if (!apply) continue;
  await request(`${orgPath}/projects/${encodeURIComponent(project.id)}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ expected_revision: project.revision, data: { photos: [...existing, ...photos] } })
  });
}

console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', org: org.org_name, org_id: org.org_id,
  instance_id: org.id, synthetic_projects: projects.length, changed_projects: changedProjects.length,
  photos_added: added, existing_entries_skipped: skipped, date_span_days: 29 }, null, 2));
