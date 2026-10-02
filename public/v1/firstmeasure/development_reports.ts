import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import type { PlatformAuthContext } from '../platform/auth.js';
import { env } from '../src/config/env.js';
import { queryPostgres, isFirstMeasurePostgresEnabled } from '../src/database/postgres.js';
import { forbidden, badRequest } from '../platform/errors.js';
import { canManageTestAppFlags, canManageSandboxOrgFlags } from '../platform/app_flags.js';
import { createProject, readManifest, readArtifact, listProjectFiles, saveArtifact, saveManifest, type JsonObject } from './storage.js';

// Developer grants include authenticated sandbox operators, never ordinary org admins.
export async function developmentReportsAllowed(auth: PlatformAuthContext) {
  if (!env.isDevelopment || env.dataEnvironment !== 'development') return false;
  const email = String(auth.identity.email || '').trim().toLowerCase();
  const allowed = `${process.env.FIRSTMEASURE_DEVELOPER_EMAILS || ''},${process.env.EXPERIMENTAL_ACCOUNTS_ADMIN_EMAILS || ''}`.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (allowed.includes(email)) return true;
  return canManageTestAppFlags(auth) || canManageSandboxOrgFlags(auth);
}
export async function requireDevelopmentReports(auth: PlatformAuthContext) {
  if (!await developmentReportsAllowed(auth)) throw forbidden('development_reports_disabled', 'Development reports require developer access in development.');
}
export function developmentCriteria(body: JsonObject) {
  const type = String(body.project_type || 'residential');
  const scope = String(body.measurement_scope || 'roof');
  if (!['residential', 'commercial', 'multifamily'].includes(type) || !['roof', 'full_house'].includes(scope)) throw badRequest('invalid_sample_criteria', 'Choose a property type and report scope.');
  if (scope === 'full_house' && type !== 'residential') throw badRequest('invalid_sample_criteria', 'Full-house reports are available for residential properties only.');
  return { type, scope };
}
const signature = (text: string) => createHmac('sha256', env.platformSessionSecret).update(`development-report:${text}`).digest('base64url');
function token(auth: PlatformAuthContext, id: string, type: string, scope: string) {
  const text = Buffer.from(JSON.stringify({ id, type, scope, user: auth.userId, org: auth.orgId, expires: Date.now() + 3600000 })).toString('base64url');
  return `${text}.${signature(text)}`;
}
export async function pickDevelopmentReport(auth: PlatformAuthContext, body: JsonObject) {
  await requireDevelopmentReports(auth);
  const { type, scope } = developmentCriteria(body);
  // Indexed selection is bounded; an incomplete draft is never a completed sample.
  const sql = `SELECT id FROM projects WHERE status='completed'
    AND project_type=$1 AND COALESCE(manifest_json->>'measurement_scope','roof')=$2
    AND has_report_pdf=1 AND has_summary_pdf=1 AND has_model_data=1
    AND CAST(COALESCE(manifest_json->>'internal_only','false') AS TEXT) NOT IN ('true','1')
    ORDER BY (id=$3), random() LIMIT 8`;
  let rows: Array<{id:string}>;
  if(isFirstMeasurePostgresEnabled()) rows=(await queryPostgres<{id:string}>(sql,[type,scope,String(body.exclude_id||'')])).rows;
  else {
    const index=await import('./project_index.js');await index.ensureFirstMeasureProjectIndexReady();
    rows=index.getFirstMeasureProjectIndexDb().prepare(sql.replaceAll('$1','$type').replaceAll('$2','$scope').replaceAll('$3','$exclude')).all({type,scope,exclude:String(body.exclude_id||'')}) as Array<{id:string}>;
  }
  for (const {id} of rows) {
    try {
      const m = await readManifest(id);
      const names = new Set((await listProjectFiles(id)).filter(f => f.size > 0).map(f => f.name));
      if (!['Report.pdf', 'Summary.pdf', 'model_data.xml'].every(n => names.has(n)) || m.lat == null || m.lng == null) continue;
      return {success: true, sample: {id, address: m.address, lat: m.lat, lng: m.lng, pins: m.pins, project_type: type, measurement_scope: scope, selection_token: token(auth, id, type, scope)}};
    } catch { /* Try the next stored candidate if an old index entry is stale. */ }
  }
  return {success: true, sample: null, message: `No completed ${type} ${scope === 'full_house' ? 'full-house' : 'roof'} reports with reusable files are available.`};
}
export async function copyDevelopmentReport(auth: PlatformAuthContext, body: JsonObject) {
  await requireDevelopmentReports(auth);
  const {type, scope} = developmentCriteria(body);
  const [text = '', supplied = ''] = String(body.development_selection_token || '').split('.');
  const expected = signature(text);
  if (!/^[A-Za-z0-9_-]{43}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw badRequest('invalid_sample', 'Choose a development address again.');
  let selected: any;
  try { selected = JSON.parse(Buffer.from(text, 'base64url').toString()); } catch { throw badRequest('invalid_sample', 'Choose a development address again.'); }
  if (selected.user !== auth.userId || selected.org !== auth.orgId || selected.expires < Date.now() || selected.type !== type || selected.scope !== scope) throw badRequest('sample_changed', 'Choose a matching development address again.');
  const source = await readManifest(selected.id);
  if (source.status !== 'completed' || source.address !== String(body.address || '').trim() || source.project_type !== type || String(source.measurement_scope || 'roof') !== scope || source.internal_only === true) throw badRequest('sample_changed', 'This report is no longer a matching completed sample.');
  const files = (await listProjectFiles(source.id)).filter(f => /^(Report\.pdf|Summary\.pdf|model_data\.xml|app_metadata\.json|pdf_state\.json|google\.png|azure\.png|apple\.jpg|rgb\.tif|customer-reference-\d+\.(?:jpg|jpeg|png|webp|mp4|mov|webm))$/i.test(f.name));
  if (!['Report.pdf','Summary.pdf','model_data.xml'].every(n => files.some(f => f.name === n && f.size > 0))) throw badRequest('sample_incomplete', 'This sample is missing completed report files.');
  // No queue, provider calls, billing or delivery. Original manifest identity/contacts are not cloned.
  const created = await createProject({...(scope === 'full_house' ? {id: 'exteriors_' + randomBytes(16).toString('hex')} : {}), address: source.address, project_type: type, lat: source.lat, lng: source.lng, pins: source.pins,
    organization_ref: {id: auth.orgId}, owner_ref: {id: auth.userId, email: auth.identity.email}, issuer: {email: auth.identity.email}, status: 'development_copying',
    ...(scope === 'full_house' ? {measurement_scope: scope} : {}), include_gutter_measurements: source.include_gutter_measurements}, {customerExteriors: scope === 'full_house'});
  const id = created.manifest.id;
  try {
    for (const file of files) await saveArtifact(id, file.name, (await readArtifact(source.id, file.name)).content);
    await saveManifest(id, {...await readManifest(id), status: 'completed', development_report: true, development_source_id: source.id,
      elevation_photos: source.elevation_photos || [], exterior_reference_videos: source.exterior_reference_videos || [],
      timestamps: {...created.manifest.timestamps, completed_at: new Date().toISOString()}, report_release_hold_enabled: false});
  } catch (error) {
    await saveManifest(id, {...await readManifest(id), status: 'development_copy_failed'});
    throw error;
  }
  const manifest = await readManifest(id);
  return {success: true, folder: id, project: manifest, manifest, report_mode: 'full', development_report: true};
}
