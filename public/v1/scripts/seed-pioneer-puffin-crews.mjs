/** Add photo-backed sample crews and portraits to the newest Pioneer Puffin full test org on dev. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = 'https://dev.1m8.ai';
const apply = process.argv.includes('--apply');
const orgPrefix = 'Pioneer Puffin Test Co';
const photoDir = new URL('./assets/pioneer-puffin-profiles/', import.meta.url);
const people = [
  ['Alex Martinez', 'alex-martinez.webp'],
  ['Sam Rivera', 'sam-rivera.webp'],
  ['Morgan Lee', 'morgan-lee.webp'],
  ['Chris Bennett', 'chris-bennett.webp'],
  ['Jamie Brooks', 'jamie-brooks.webp'],
  ['Dana Chen', 'dana-chen.webp']
];
const crews = [
  { key: 'roof-installation', name: 'Roof Installation Crew', lead: 'Chris Bennett', members: ['Chris Bennett', 'Jamie Brooks'], file: 'roof-installation.webp' },
  { key: 'exterior-repairs', name: 'Exterior Repairs Crew', lead: 'Jamie Brooks', members: ['Jamie Brooks', 'Dana Chen'], file: 'exterior-repairs.webp' },
  { key: 'gutter-siding', name: 'Gutter & Siding Crew', lead: 'Dana Chen', members: ['Dana Chen', 'Chris Bennett'], file: 'gutter-siding.webp' }
];
const stableId = (kind, key) => `${kind}_sample_${createHash('sha256').update(key).digest('hex').slice(0, 20)}`;

async function request(path, options = {}) {
  const response = await fetch(base + path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${JSON.stringify(body.error || body.message || body).slice(0, 400)}`);
  }
  return { response, body };
}

const { body: state } = await request('/v1/signup-sandbox/state');
const org = state.test_orgs
  .filter((entry) => String(entry.org_name || '').startsWith(orgPrefix))
  .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
if (!org || org.workflow_id !== 'swf_instant_full_org') throw new Error('The newest Pioneer Puffin test org is not an Instant Full Org.');

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
const groupPath = `/v1/workforce/organizations/${encodeURIComponent(org.org_id)}/branches/default/resource-groups`;

const [{ body: usersResult }, { body: mediaResult }, { body: groupResult }] = await Promise.all([
  request(`${orgPath}/users`, { headers }),
  request(`${orgPath}/media`, { headers }),
  request(groupPath, { headers })
]);
const users = usersResult.documents || [];
const sampleUsers = new Map(people.map(([name]) => [name, users.find((entry) => entry.data?.name === name && entry.data?.metadata?.source === 'development_roofing_company')]));
for (const [name, user] of sampleUsers) if (!user) throw new Error(`Synthetic user missing: ${name}`);
const mediaById = new Map((mediaResult.media || []).map((entry) => [entry.id, entry]));
const groupById = new Map((groupResult.groups || []).map((entry) => [entry.id, entry]));

async function ensurePhoto(kind, ownerId, file) {
  const id = stableId('media', `${org.org_id}:${kind}:${ownerId}`);
  if (!mediaById.has(id) && apply) {
    const bytes = await readFile(new URL(file, photoDir));
    const { body } = await request(`${orgPath}/media`, {
      method: 'POST', headers,
      body: JSON.stringify({ id, owner_type: kind, owner_id: ownerId, slot: 'profile',
        collection: kind === 'user' ? 'users' : 'workforce', file_name: file,
        content_type: 'image/webp', bytes_base64: bytes.toString('base64'),
        metadata: { synthetic: true, source: 'development_pioneer_puffin_profiles' } })
    });
    mediaById.set(id, body.media);
  }
  return `/v1/platform/organizations/${encodeURIComponent(org.org_id)}/media/${encodeURIComponent(id)}/file`;
}

let userPhotosAdded = 0;
for (const [name, file] of people) {
  const user = sampleUsers.get(name);
  const photo = await ensurePhoto('user', user.id, file);
  if (user.data.avatar_url === photo && user.data.profile_photo_url === photo) continue;
  userPhotosAdded++;
  if (!apply) continue;
  await request(`${orgPath}/users/${encodeURIComponent(user.id)}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ expected_revision: user.revision, data: {
      avatar_url: photo, profile_photo: photo, profile_photo_url: photo,
      profile: { ...(user.data.profile || {}), profile_photo: photo, avatar_media_id: stableId('media', `${org.org_id}:user:${user.id}`) }
    } })
  });
}

let crewsAdded = 0;
let crewsUpdated = 0;
for (const crew of crews) {
  const id = stableId('resource_group', `${org.org_id}:${crew.key}`);
  const photo = await ensurePhoto('resource_group', id, crew.file);
  const members = crew.members.map((name) => ({ user_id: sampleUsers.get(name).id, role: name === crew.lead ? 'lead' : 'member', is_lead: name === crew.lead, status: 'active' }));
  const fields = { name: crew.name, kind_id: 'crew', status: 'active', members,
    attributes: { photo_url: photo, avatar_url: photo, profile_photo_url: photo },
    metadata: { synthetic: true, source: 'development_pioneer_puffin_crews', photo_media_id: stableId('media', `${org.org_id}:resource_group:${id}`) } };
  const existing = groupById.get(id);
  if (!existing) {
    crewsAdded++;
    if (apply) await request(groupPath, { method: 'POST', headers, body: JSON.stringify({ id, ...fields }) });
    continue;
  }
  const sameMembers = JSON.stringify(existing.members?.map((entry) => [entry.user_id, entry.role, entry.is_lead])) ===
    JSON.stringify(members.map((entry) => [entry.user_id, entry.role, entry.is_lead]));
  if (existing.name === crew.name && existing.attributes?.photo_url === photo && sameMembers) continue;
  crewsUpdated++;
  if (apply) await request(`${groupPath}/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers, body: JSON.stringify({ expected_revision: existing.revision, ...fields })
  });
}

console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', org: org.org_name,
  org_id: org.org_id, instance_id: org.id, synthetic_users: sampleUsers.size,
  user_photos_added: userPhotosAdded, crews_added: crewsAdded, crews_updated: crewsUpdated,
  crew_photos: crews.length }, null, 2));

if (process.argv.includes('--verify')) {
  const [{ body: freshUsers }, { body: freshGroups }, { body: freshMedia }] = await Promise.all([
    request(`${orgPath}/users`, { headers }), request(groupPath, { headers }), request(`${orgPath}/media`, { headers })
  ]);
  const photoUsers = freshUsers.documents.filter((entry) => people.some(([name]) => name === entry.data?.name)
    && entry.data?.profile_photo_url && entry.data?.avatar_url === entry.data?.profile_photo_url);
  const photoGroups = freshGroups.groups.filter((entry) => crews.some((crew) => crew.name === entry.name)
    && entry.attributes?.photo_url && entry.members?.length === 2);
  const photoMedia = freshMedia.media.filter((entry) => entry.metadata?.source === 'development_pioneer_puffin_profiles');
  const firstPhoto = photoUsers[0]?.data?.profile_photo_url;
  const imageResponse = firstPhoto ? await fetch(base + firstPhoto, { headers }) : null;
  if (imageResponse) await imageResponse.arrayBuffer();
  console.log(JSON.stringify({ verification: { users_with_photos: photoUsers.length, crews_with_photos_and_members: photoGroups.length,
    stored_profile_images: photoMedia.length, sample_image_http_status: imageResponse?.status || 0 } }, null, 2));
  if (photoUsers.length !== people.length || photoGroups.length !== crews.length || photoMedia.length !== people.length + crews.length
    || !imageResponse?.ok || !imageResponse.headers.get('content-type')?.startsWith('image/')) throw new Error('Crew/profile verification failed.');
}
