/** Add one real, project-owned 40-photo Feed batch to the newest Pioneer Puffin test org on dev. */
import { createHash } from 'node:crypto';

const base = 'https://dev.1m8.ai';
const apply = process.argv.includes('--apply');
const verify = process.argv.includes('--verify');
const sampleDay = '2026-10-09';
const sampleKey = `today-40-photo-batch-${sampleDay}`;
const stableId = (kind, value) => `${kind}_sample_${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
const imagePaths = [
  '/portal/landing/variants/instantly-signup/media/card_residential.jpg',
  '/portal/landing/variants/instantly-signup/media/card_multifamily.jpg',
  '/portal/landing/variants/instantly-signup/media/card_commercial.jpg',
  '/portal/landing/variants/instantly-signup/media/neighborhood_header.png',
  '/portal/marketing/images/gutter_installer.png'
];
async function request(path, options = {}) {
  const response = await fetch(base + path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${JSON.stringify(body).slice(0, 500)}`);
  return { response, body };
}

const { body: sandbox } = await request('/v1/signup-sandbox/state');
const org = sandbox.test_orgs.filter(entry => String(entry.org_name || '').startsWith('Pioneer Puffin Test Co'))
  .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
if (!org || org.workflow_id !== 'swf_instant_full_org') throw new Error('Newest Pioneer Puffin org is not a full test org.');
const { response: login } = await request(`/v1/signup-sandbox/test-orgs/${encodeURIComponent(org.id)}/login`, {
  method:'POST', headers:{ 'content-type':'application/json' }, body:'{}'
});
const cookies = login.headers.getSetCookie().map(line => line.split(';', 1)[0]);
const csrfCookie = cookies.find(cookie => cookie.slice(0, cookie.indexOf('=')).endsWith('_csrf'));
if (!csrfCookie) throw new Error('Sandbox login did not return CSRF.');
const headers = { cookie:cookies.join('; '), 'content-type':'application/json',
  'x-platform-csrf':decodeURIComponent(csrfCookie.slice(csrfCookie.indexOf('=') + 1)) };
const platform = `/v1/platform/organizations/${encodeURIComponent(org.org_id)}`;
const channels = `/v1/channels/organizations/${encodeURIComponent(org.org_id)}`;
const get = async path => (await request(path, { headers })).body;
const [projectResult, userResult, mediaResult] = await Promise.all([
  get(`${platform}/projects`), get(`${platform}/users`), get(`${platform}/media`)
]);
const projects = projectResult.documents.filter(entry => entry.data?.workflow_state === 'project' && entry.data?.tags?.includes('Synthetic'))
  .sort((a, b) => String(a.id).localeCompare(String(b.id)));
if (projects.length < 8) throw new Error('Expected at least eight synthetic projects.');
const project = projects[7];
const uploader = userResult.documents.find(entry => entry.data?.name === 'Chris Bennett' && entry.data?.metadata?.source === 'development_roofing_company');
if (!uploader) throw new Error('Synthetic uploader Chris Bennett was not found.');
const existingPhotos = Array.isArray(project.data.photos) ? project.data.photos : [];
const existingSample = existingPhotos.filter(photo => photo.metadata?.sample_key === sampleKey);
const uploadedAt = existingSample[0]?.uploaded_at || new Date().toISOString();
if (uploadedAt.slice(0, 10) !== sampleDay) throw new Error(`Batch timestamp must be on ${sampleDay}; got ${uploadedAt}`);
const batchId = stableId('upload_batch', `${org.org_id}:${sampleKey}`);
const photos = Array.from({ length:40 }, (_, index) => {
  const id = stableId('photo', `${org.org_id}:${project.id}:${sampleKey}:${index}`);
  const src = imagePaths[index % imagePaths.length];
  return { id, photo_id:id, kind:'external_image', media_type:'image', src, thumb:src,
    alt:`Same-time project photo ${index + 1}`, label:`Site photo ${index + 1}`,
    uploaded_at:uploadedAt, uploaded_by_user_id:uploader.id, upload_batch_id:batchId,
    metadata:{ synthetic:true, source:'development_feed_fixture', sample_key:sampleKey,
      uploaded_at:uploadedAt, uploaded_by_user_id:uploader.id, uploaded_by_name:uploader.data.name,
      upload_batch_id:batchId, tags:['synthetic','batch upload'] } };
});
const presentMedia = new Set((mediaResult.media || []).map(entry => entry.id));
const missingMedia = photos.filter(photo => !presentMedia.has(photo.id));
const presentPhotos = new Set(existingPhotos.map(photo => photo.id));
const missingPhotos = photos.filter(photo => !presentPhotos.has(photo.id));
console.log(JSON.stringify({ mode:apply?'apply':'dry-run', org:org.org_name, org_id:org.org_id,
  project_id:project.id, project_name:project.data?.title || project.data?.name,
  uploader:uploader.data.name, batch_id:batchId, uploaded_at:uploadedAt,
  target_photos:photos.length, missing_media:missingMedia.length, missing_project_photos:missingPhotos.length }, null, 2));

if (apply && (missingMedia.length || missingPhotos.length)) {
  const assets = new Map();
  for (const src of imagePaths) {
    const response = await fetch(base + src);
    if (!response.ok) throw new Error(`Image unavailable: ${src} (${response.status})`);
    assets.set(src, { bytes:Buffer.from(await response.arrayBuffer()), type:response.headers.get('content-type')?.split(';')[0] || 'image/jpeg' });
  }
  for (const photo of missingMedia) {
    const asset = assets.get(photo.src);
    await request(`${platform}/media`, { method:'POST', headers, body:JSON.stringify({
      id:photo.id, owner_type:'project', owner_id:project.id, slot:'photos', collection:'projects',
      file_name:`${photo.id}-${photo.src.split('/').at(-1)}`, content_type:asset.type,
      bytes_base64:asset.bytes.toString('base64'),
      metadata:{ ...photo.metadata, project_id:project.id }
    }) });
  }
  if (missingPhotos.length) {
    const latest = (await get(`${platform}/projects/${encodeURIComponent(project.id)}`)).document;
    const current = Array.isArray(latest.data?.photos) ? latest.data.photos : [];
    const known = new Set(current.map(photo => photo.id));
    await request(`${platform}/projects/${encodeURIComponent(project.id)}`, {
      method:'PATCH', headers, body:JSON.stringify({ expected_revision:latest.revision,
        data:{ photos:[...current, ...photos.filter(photo => !known.has(photo.id))] } })
    });
  }
}
if (verify || apply) {
  const [record, media, catalog] = await Promise.all([
    get(`${platform}/projects/${encodeURIComponent(project.id)}`),
    get(`${platform}/media`), get(`${channels}/feed/catalog`)
  ]);
  const stored = (record.document?.data?.photos || []).filter(photo => photo.metadata?.sample_key === sampleKey);
  const mediaIds = new Set((media.media || []).map(entry => entry.id));
  const refs = photos.map(photo => ({ kind:'media', id:photo.id, project_id:project.id }));
  const authorized = (await request(`${channels}/feed/authorize`, { method:'POST', headers, body:JSON.stringify({ refs }) })).body;
  const sourceKeys = new Set((authorized.sources || []).map(source => source.key));
  const inCatalog = (catalog.projects || []).find(entry => entry.id === project.id)?.data?.photos || [];
  const report = { project_photos:stored.length, actual_media:photos.filter(photo => mediaIds.has(photo.id)).length,
    catalog_photos:inCatalog.filter(photo => photo.metadata?.sample_key === sampleKey).length,
    feed_sources:(authorized.sources || []).length, feed_group_keys:sourceKeys.size,
    one_timestamp:new Set(stored.map(photo => photo.uploaded_at)).size === 1,
    one_uploader:new Set(stored.map(photo => photo.uploaded_by_user_id)).size === 1 };
  console.log(JSON.stringify({ verification:report }, null, 2));
  if (apply && (report.project_photos !== 40 || report.actual_media !== 40 || report.catalog_photos !== 40
    || report.feed_sources !== 40 || report.feed_group_keys !== 1 || !report.one_timestamp || !report.one_uploader))
    throw new Error('40-photo Feed batch verification failed.');
}
