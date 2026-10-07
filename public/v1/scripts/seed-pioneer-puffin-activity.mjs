/** Populate realistic feed and project activity in the newest Pioneer Puffin full test org on dev. */
import { createHash } from 'node:crypto';

const base = 'https://dev.1m8.ai';
const apply = process.argv.includes('--apply');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const stableId = (kind, value) => `${kind}_sample_${hash(value).slice(0, 20)}`;
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
  if (!response.ok || body.ok === false) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${JSON.stringify(body).slice(0, 900)}`);
  return body;
}

const state = await request('/v1/signup-sandbox/state');
const org = state.test_orgs.filter((entry) => String(entry.org_name || '').startsWith('Pioneer Puffin Test Co'))
  .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
if (!org || org.workflow_id !== 'swf_instant_full_org') throw new Error('Newest Pioneer Puffin org is not an Instant Full Org.');
const login = await fetch(`${base}/v1/signup-sandbox/test-orgs/${encodeURIComponent(org.id)}/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
});
if (!login.ok) throw new Error(`Sandbox login failed: ${login.status}`);
const cookieMap = new Map(login.headers.getSetCookie().map((line) => {
  const cookie = line.split(';', 1)[0];
  return [cookie.slice(0, cookie.indexOf('=')), cookie];
}));
const cookies = [...cookieMap.values()];
const csrfCookie = cookies.find((cookie) => cookie.slice(0, cookie.indexOf('=')).endsWith('_csrf'));
if (!csrfCookie) throw new Error('Sandbox login did not return CSRF token.');
const headers = { cookie: cookies.join('; '), 'content-type': 'application/json',
  'x-platform-csrf': decodeURIComponent(csrfCookie.slice(csrfCookie.indexOf('=') + 1)) };
const platform = `/v1/platform/organizations/${encodeURIComponent(org.org_id)}`;
const workforce = `/v1/workforce/organizations/${encodeURIComponent(org.org_id)}`;
const work = `/v1/work/organizations/${encodeURIComponent(org.org_id)}`;
const channels = `/v1/channels/organizations/${encodeURIComponent(org.org_id)}`;
const get = (path) => request(path, { headers });
const post = (path, body) => request(path, { method: 'POST', headers, body: JSON.stringify(body) });
const patch = (path, body) => request(path, { method: 'PATCH', headers, body: JSON.stringify(body) });

const [projectResult, userResult, groupResult] = await Promise.all([
  get(`${platform}/projects`), get(`${platform}/users`), get(`${workforce}/branches/default/resource-groups`)
]);
const projects = projectResult.documents.filter((entry) => entry.data?.workflow_state === 'project' && entry.data?.tags?.includes('Synthetic'))
  .sort((a, b) => String(a.id).localeCompare(String(b.id)));
if (projects.length < 8) throw new Error('Expected at least eight synthetic projects.');
const user = (name) => {
  const entry = userResult.documents.find((item) => item.data?.name === name && item.data?.metadata?.source === 'development_roofing_company');
  if (!entry) throw new Error(`Missing synthetic user ${name}`);
  return entry;
};
const chris = user('Chris Bennett');
const jamie = user('Jamie Brooks');
const dana = user('Dana Chen');
const sam = user('Sam Rivera');
const installationCrew = groupResult.groups.find((entry) => entry.name === 'Roof Installation Crew' && entry.metadata?.source === 'development_pioneer_puffin_crews');
if (!installationCrew) throw new Error('Run seed-pioneer-puffin-crews.mjs first.');

const count = { photos_added: 0, checklists_created: 0, checklist_items_completed: 0,
  sold_projects: 0, notes_added: 0, appointments_created: 0, activity_events: 0 };
const existingEvents = (await get(`${work}/events?limit=500`)).events || [];
const existingEventKeys = new Set(existingEvents.map((event) => event.idempotency_key));
const now = Date.now();
const burstTime = new Date(now - 2 * 86_400_000).toISOString();
const burstProject = projects[0];
const batches = [
  { project: burstProject, size: 20, uploader: chris, crew: installationCrew, at: burstTime, key: 'installation-burst' },
  { project: projects[1], size: 6, uploader: jamie, crew: null, at: new Date(now - 5 * 86_400_000).toISOString(), key: 'repair-progress' },
  { project: projects[2], size: 4, uploader: dana, crew: null, at: new Date(now - 9 * 86_400_000).toISOString(), key: 'gutter-progress' },
  { project: projects[12], size: 8, uploader: chris, crew: installationCrew, at: new Date(now - 90_000).toISOString(), key: 'today-installation-burst' }
];
for (const batch of batches) {
  const existing = Array.isArray(batch.project.data.photos) ? batch.project.data.photos : [];
  const known = new Set(existing.map((photo) => String(photo.id || photo.photo_id || '')));
  const batchId = stableId('upload_batch', `${org.org_id}:${batch.key}`);
  const added = Array.from({ length: batch.size }, (_, index) => {
    const id = stableId('photo', `${org.org_id}:${batch.project.id}:${batch.key}:${index}`);
    const src = imagePaths[(index + projects.indexOf(batch.project)) % imagePaths.length];
    const uploadedAt = new Date(Date.parse(batch.at) + index * 5_000).toISOString();
    return { id, photo_id: id, kind: 'external_image', media_type: 'image', src, thumb: src,
      alt: `${batch.key.replaceAll('-', ' ')} ${index + 1}`, label: `Site photo ${index + 1}`,
      uploaded_at: uploadedAt, uploaded_by_user_id: batch.uploader.id, upload_batch_id: batchId,
      metadata: { synthetic: true, source: 'development_feed_fixture', uploaded_at: uploadedAt,
        uploaded_by_user_id: batch.uploader.id, uploaded_by_name: batch.uploader.data.name,
        upload_batch_id: batchId, crew_id: batch.crew?.id || '', crew_name: batch.crew?.name || '',
        tags: ['synthetic', 'batch upload'] } };
  }).filter((photo) => !known.has(photo.id));
  count.photos_added += added.length;
  if (apply && added.length) {
    await patch(`${platform}/projects/${encodeURIComponent(batch.project.id)}`,
      { expected_revision: batch.project.revision, data: { photos: [...existing, ...added] } });
  }
}

const checklistSpecs = [
  { project: projects[0], title: 'Roof installation closeout', actor: chris, items: ['Protect landscaping and walkways', 'Inspect flashing and penetrations', 'Sweep roof and magnet sweep yard'] },
  { project: projects[3], title: 'Exterior repair quality review', actor: jamie, items: ['Photograph damaged siding', 'Seal repaired joints', 'Review finish with homeowner'] },
  { project: projects[4], title: 'Gutter installation handoff', actor: dana, items: ['Check gutter pitch', 'Test downspout drainage', 'Remove jobsite debris'] }
];
for (const spec of checklistSpecs) {
  const path = `${workforce}/crew/projects/${encodeURIComponent(spec.project.id)}/checklists`;
  const existing = (await get(path)).checklists || [];
  let checklist = existing.find((entry) => entry.metadata?.sample_key === spec.title);
  if (!checklist) {
    count.checklists_created++;
    if (!apply) continue;
    checklist = (await post(path, { title: spec.title, kind: 'todo', audience: 'crew', crew_editable: true,
      metadata: { synthetic: true, source: 'development_pioneer_puffin_activity', sample_key: spec.title },
      items: spec.items.map((title, index) => ({ title, item_type: 'todo', sort_order: index })) })).checklist;
  }
  const current = apply ? (await get(path)).checklists.find((entry) => entry.id === checklist.id) : checklist;
  for (const item of current?.items || []) {
    if (item.completed) continue;
    count.checklist_items_completed++;
    if (apply) await patch(`${path}/${encodeURIComponent(checklist.id)}/items/${encodeURIComponent(item.id)}`,
      { completed: true, note: `Completed by the ${spec.actor.data.name} sample crew.` });
  }
}

for (const [index, project] of projects.slice(5, 8).entries()) {
  const plansPath = `${work}/projects/${encodeURIComponent(project.id)}/plans`;
  const plans = (await get(plansPath)).plans || [];
  if (plans.some((plan) => plan.metadata?.sample_key === 'pioneer-puffin-sold')) continue;
  count.sold_projects++;
  if (!apply) continue;
  await post(plansPath, {
    id: stableId('plan', `${org.org_id}:${project.id}:sold`), title: 'Production', source_type: 'synthetic',
    source_key: `synthetic:sold:${project.id}`, start_immediately: true,
    metadata: { synthetic: true, source: 'development_pioneer_puffin_activity', sample_key: 'pioneer-puffin-sold', scope_template_kind: 'production' },
    root_nodes: [{ id: 'production_phase', title: 'Production', terminology_key: 'production_phase',
      completion_mode: 'manual', children: [{ id: 'production_stage', title: 'Scheduled for production',
        terminology_key: 'production_stage', completion_mode: 'manual' }] }]
  });
}

const notes = [
  ['Customer confirmed driveway access. Stage materials on the left side of the garage.', projects[0]],
  ['Existing flashing needs a closer look before installation starts.', projects[1]],
  ['Homeowner prefers the darker shingle sample. Confirm final color on the proposal.', projects[5]],
  ['Crew completed the walkthrough; gutter drainage looks good after the water test.', projects[4]],
  ['During the morning walkthrough we found two areas where the existing flashing sits unevenly against the siding. The crew photographed both locations and marked them for review before removing the old shingles. Please confirm whether the replacement flashing should match the current finish or the darker trim selected for the garage. Materials can remain staged along the left side of the driveway, but the access path to the back door needs to stay clear while the work is underway.', projects[0]],
  ['The homeowner reviewed the repair progress with the crew this afternoon. The new siding panels line up well with the existing wall, and the sealant around the window has cured evenly. Before the final walkthrough, please check the upper corner after the next rain and take another photo from the sidewalk so we can compare it with the original damage. If that corner remains dry, we can close the remaining checklist item and schedule the customer handoff.', projects[3]]
];
for (const [text, project] of notes) {
  const noteKey = stableId('note', `${org.org_id}:${project.id}:${text}`);
  if (!apply) { count.notes_added++; continue; }
  const { channel } = await post(`${channels}/channels/project/${encodeURIComponent(project.id)}`, {});
  const result = await post(`${channels}/channels/${encodeURIComponent(channel.id)}/messages`, {
    text, project_note: true, client_msg_id: noteKey,
    metadata: { synthetic: true, source: 'development_pioneer_puffin_activity' }
  });
  if (!result.deduplicated) count.notes_added++;
}

for (const [index, project] of projects.slice(8, 12).entries()) {
  const id = stableId('event', `${org.org_id}:${project.id}:sales-appointment`);
  if ((project.data.events || []).some((entry) => entry.id === id)) continue;
  count.appointments_created++;
  if (!apply) continue;
  const start = new Date(now + (index + 1) * 86_400_000 + 10 * 3_600_000);
  await post(`${platform}/projects/${encodeURIComponent(project.id)}/events`, {
    id, title: index % 2 ? 'Roof inspection and estimate' : 'Homeowner sales appointment',
    event_type_default_id: 'sales_appointment', start_at: start.toISOString(),
    end_at: new Date(start.getTime() + 90 * 60_000).toISOString(), status: 'scheduled',
    assigned_user_ids: [], customer_visible: false,
    description: 'Synthetic appointment for development feed testing.'
  });
}

const activitySpecs = [
  ...checklistSpecs.map((spec) => ({ event: 'note.created', project: spec.project, title: `${spec.title} field update`, actor: spec.actor })),
  ...projects.slice(5, 8).map((project) => ({ event: 'document.signed', project, title: 'Roofing proposal accepted', actor: sam }))
];
for (const spec of activitySpecs) {
  const key = `synthetic:pioneer-puffin:${spec.event}:${spec.project.id}`;
  if (existingEventKeys.has(key)) continue;
  count.activity_events++;
  if (!apply) continue;
  const result = await post(`${work}/events/emit`, { event: spec.event, project_id: spec.project.id,
    idempotency_key: key, payload: { title: spec.title, actor_name: spec.actor.data.name, synthetic: true } });
  if (!result.event?.id) throw new Error(`Failed to emit ${spec.event} for ${spec.project.id}`);
}

console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', org: org.org_name,
  org_id: org.org_id, batch_20_project: burstProject.id, batch_20_uploader: chris.data.name,
  batch_20_crew: installationCrew.name, today_batch_project: projects[12].id, ...count }, null, 2));

if (process.argv.includes('--verify')) {
  const catalog = await get(`${channels}/feed/catalog`);
  const burst = catalog.projects.find((entry) => entry.id === burstProject.id);
  const photos = burst?.data?.photos || [];
  const batchId = stableId('upload_batch', `${org.org_id}:installation-burst`);
  const burstPhotos = photos.filter((photo) => photo.upload_batch_id === batchId || photo.metadata?.upload_batch_id === batchId);
  const todayProject = catalog.projects.find((entry) => entry.id === projects[12].id);
  const todayBatchId = stableId('upload_batch', `${org.org_id}:today-installation-burst`);
  const todayPhotos = (todayProject?.data?.photos || []).filter((photo) => photo.upload_batch_id === todayBatchId || photo.metadata?.upload_batch_id === todayBatchId);
  const authorized = await post(`${channels}/feed/authorize`, { refs: todayPhotos.map((photo) => ({ kind: 'media', id: photo.id, project_id: projects[12].id })) });
  const groupKeys = new Set((authorized.sources || []).map((source) => source.key));
  const uploaderProfile = catalog.users.find((entry) => entry.id === chris.id);
  const verifiedChecklists = await Promise.all(checklistSpecs.map(async (spec) => {
    const result = await get(`${workforce}/crew/projects/${encodeURIComponent(spec.project.id)}/checklists`);
    const checklist = result.checklists.find((entry) => entry.metadata?.sample_key === spec.title);
    return { title: spec.title, completed: checklist?.completed_items, total: checklist?.total_items };
  }));
  const sold = await Promise.all(projects.slice(5, 8).map(async (project) => {
    const [result, record] = await Promise.all([
      get(`${work}/projects/${encodeURIComponent(project.id)}/plans`),
      get(`${platform}/projects/${encodeURIComponent(project.id)}`)
    ]);
    return result.plans.some((plan) => plan.metadata?.sample_key === 'pioneer-puffin-sold' && plan.status === 'active')
      && Boolean(record.document?.data?.lifecycle?.sold_at);
  }));
  const appointmentProjects = await Promise.all(projects.slice(8, 12).map(async (project) => {
    const result = await get(`${platform}/projects/${encodeURIComponent(project.id)}`);
    return (result.document?.data?.events || []).some((entry) => entry.id === stableId('event', `${org.org_id}:${project.id}:sales-appointment`));
  }));
  const report = { feed_visible_batch_photos: burstPhotos.length, today_grouped_upload_photos: todayPhotos.length,
    today_feed_group_keys: groupKeys.size, today_uploader_has_avatar: Boolean(uploaderProfile?.avatar), feed_activity_events: catalog.events.length,
    completed_checklists: verifiedChecklists, sold_projects_with_lifecycle: sold.filter(Boolean).length,
    scheduled_appointments: appointmentProjects.filter(Boolean).length };
  console.log(JSON.stringify({ verification: report }, null, 2));
  if (burstPhotos.length !== 20 || todayPhotos.length !== 8 || groupKeys.size !== 1 || !uploaderProfile?.avatar
    || sold.filter(Boolean).length !== 3 || appointmentProjects.filter(Boolean).length !== 4
    || verifiedChecklists.some((item) => !item.total || item.completed !== item.total)) throw new Error('Synthetic activity verification failed.');
}
