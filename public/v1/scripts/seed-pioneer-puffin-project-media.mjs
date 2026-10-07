/** Make the Pioneer Puffin Feed fixtures visible in the actual project photo gallery. */
const base = 'https://dev.1m8.ai';
const apply = process.argv.includes('--apply');
const limit = Number(process.argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || Infinity);

async function request(path, options = {}) {
  const response = await fetch(base + path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${JSON.stringify(body).slice(0, 500)}`);
  return { response, body };
}

const { body: state } = await request('/v1/signup-sandbox/state');
const org = state.test_orgs.filter((entry) => String(entry.org_name || '').startsWith('Pioneer Puffin Test Co'))
  .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
if (!org || org.workflow_id !== 'swf_instant_full_org') throw new Error('Newest Pioneer Puffin org is not a full test org.');
const { response: login } = await request(`/v1/signup-sandbox/test-orgs/${encodeURIComponent(org.id)}/login`, {
  method:'POST', headers:{ 'content-type':'application/json' }, body:'{}'
});
const cookies = login.headers.getSetCookie().map((line) => line.split(';', 1)[0]);
const csrfCookie = cookies.find((cookie) => cookie.slice(0, cookie.indexOf('=')).endsWith('_csrf'));
if (!csrfCookie) throw new Error('Sandbox login did not return CSRF.');
const headers = { cookie:cookies.join('; '), 'content-type':'application/json',
  'x-platform-csrf':decodeURIComponent(csrfCookie.slice(csrfCookie.indexOf('=') + 1)) };
const platform = `/v1/platform/organizations/${encodeURIComponent(org.org_id)}`;
const projects = (await request(`${platform}/projects`, { headers })).body.documents || [];
const media = (await request(`${platform}/media`, { headers })).body.media || [];
const present = new Set(media.map((entry) => entry.id));
const fixtures = projects.flatMap((project) => (project.data?.photos || [])
  .filter((photo) => photo.metadata?.source === 'development_feed_fixture' && photo.id && photo.src)
  .map((photo) => ({ project, photo })))
  .filter(({ photo }) => !present.has(photo.id));
const assets = new Map();
let created = 0;
for (const { project, photo } of fixtures.slice(0, limit)) {
  if (!apply) continue;
  if (!assets.has(photo.src)) {
    const response = await fetch(base + photo.src);
    if (!response.ok) throw new Error(`Image unavailable: ${photo.src} (${response.status})`);
    assets.set(photo.src, { bytes:Buffer.from(await response.arrayBuffer()), type:response.headers.get('content-type')?.split(';')[0] || 'image/jpeg' });
  }
  const asset = assets.get(photo.src);
  await request(`${platform}/media`, { method:'POST', headers, body:JSON.stringify({
    id:photo.id, owner_type:'project', owner_id:project.id, slot:'photos', collection:'projects',
    file_name:photo.src.split('/').at(-1), content_type:asset.type, bytes_base64:asset.bytes.toString('base64'),
    metadata:{ ...photo.metadata, synthetic:true, project_id:project.id,
      uploaded_at:photo.uploaded_at, uploaded_by_user_id:photo.uploaded_by_user_id || photo.metadata?.uploaded_by_user_id,
      upload_batch_id:photo.upload_batch_id || photo.metadata?.upload_batch_id }
  }) });
  created++;
}
console.log(JSON.stringify({ org:org.org_name, fixturePhotos:fixtures.length, created, remaining:fixtures.length-created, mode:apply?'applied':'dry-run' }, null, 2));
