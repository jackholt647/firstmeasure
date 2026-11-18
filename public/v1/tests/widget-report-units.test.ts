// FM-574: the project window's Measurements tray draws the 3D model from the `report` widget source, which gave the
// viewer no measurement system: a metric report's lengths and areas showed in feet. The source now carries the
// order's measurement system and pitch notation.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = await mkdtemp(path.join(os.tmpdir(), 'widget-report-units-'));
Object.assign(process.env, {NODE_ENV: 'test', PLATFORM_STORAGE_ROOT: path.join(root, 'platform'), FIRSTMEASURE_STORAGE_ROOT: path.join(root, 'reports'), FIRSTMEASURE_INDEX_DB_PATH: path.join(root, 'index.sqlite'), PLATFORM_HEARTBEAT_DISABLED: '1'});
after(async () => { await rm(root, {recursive: true, force: true}).catch(() => {}); });

test('the report widget source gives the viewer the order\'s measurement system and pitch notation', async () => {
  const s = await import('../platform/storage.js'), p = await import('../platform/publication/providers.js'), fm = await import('../firstmeasure/storage.js');
  const {saveCapabilityValues} = await import('../platform/capabilities.js'), {userPublicationContext} = await import('../platform/publication/context.js');
  const org = 'org_report_units';
  await s.createOrganization({id: org, name: 'Report units'});
  await saveCapabilityValues(org, {'platform.expanded_access': true});
  await s.saveGlobal(org, {data: {app_flags: {platform: {expanded_access: true}}}}, {replace: false});
  (await import('../platform/publication/bootstrap.js')).initializePublication();
  const auth: any = {orgId: org, userId: 'member', role: 'member', permissions: {view_reports: true, view_project_data: true}, applicationAccess: {management: {enabled: true, permissions: {'*': true}}}, capabilities: {effectiveByKey: {}}};
  const ctx = userPublicationContext(auth);
  const read = async (name: string, manifest: Record<string, unknown>) => {
    const reportId = `report_${name}`;
    await s.upsertDocument(org, 'projects', {id: `project_${name}`, data: {measurement_project: {id: reportId}}});
    await fm.createProject({id: reportId, address: '10 Craig Pl, Aberdeen', organization_ref: {id: org}});
    await fm.saveStoredXml(reportId, '<FACE id="roof"><POLYGON size="300" pitch="6"/></FACE>');
    await fm.patchManifest(reportId, {...manifest, status: 'completed'});
    const result = await p.readPublishedData(ctx, {provider: 'project-widgets', export: 'report', target: {scope: 'project', organizationId: org, projectId: `project_${name}`}});
    assert.equal(result.status, 'ready', JSON.stringify(result));
    const value = (result as {value: Record<string, unknown>}).value;
    return [value.measurementSystem, value.pitchNotation];
  };
  // Every order is stamped with its notation (a metric company's is degrees unless it chose otherwise).
  assert.deepEqual(await read('metric', {measurement_system: 'metric', pitch_notation: 'degrees'}), ['metric', 'degrees']);
  assert.deepEqual(await read('metric_rise', {measurement_system: 'metric', pitch_notation: 'rise_12'}), ['metric', 'rise_12'], 'the order\'s notation wins');
  assert.deepEqual(await read('imperial', {measurement_system: 'imperial', pitch_notation: 'rise_12'}), ['imperial', 'rise_12']);
});
