import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const [viewer, projectRequest, customFields, capabilityDefs] = await Promise.all([
  readFile(path.join(publicRoot, 'libraries/apps/projects/viewer.js'), 'utf8'),
  readFile(path.join(publicRoot, 'libraries/apps/project-request/app.js'), 'utf8'),
  readFile(path.join(publicRoot, 'libraries/custom-fields/firstmate-custom-fields.js'), 'utf8'),
  readFile(path.join(publicRoot, 'v1/platform/capability_defs.ts'), 'utf8')
]);

test('the Projects stages view honors its capability and falls back to tiles', () => {
  assert.match(viewer, /value\?\.\('platform', 'project_stages_view', false\) === true/);
  assert.match(viewer, /function defaultViewMode\(\)\{ return stagesViewEnabled\(\) \? 'stages' : 'tiles'; \}/);
  assert.doesNotMatch(viewer, /function stagesViewEnabled\(\)\{\s*return true;/);
});

test('scope-provided project assignments have a dedicated UI capability', () => {
  assert.match(capabilityDefs, /key: "platform\.project_assignments"[\s\S]{0,400}default: true/);
  assert.match(customFields, /definition\.group_path === 'assignments' && !projectAssignmentsEnabled\(\)/);
  assert.match(projectRequest, /projectAssignmentsEnabled\(\) \|\| definition\.group_path !== 'assignments'/);
});

test('the report-order modal reads the shared capability source and resumes FirstMeasure drafts', () => {
  assert.match(projectRequest, /window\.Portal\?\.appFlags \|\| window\.PlatformAPI\?\.appFlags/);
  assert.match(projectRequest, /function isUnfinishedReportDraft\(project = \{\}\)/);
  assert.match(projectRequest, /workflow_intent: requestedWorkflow/);
  assert.match(projectRequest, /report_selection: reportSelection \|\| ''/);
  assert.match(projectRequest, /newProjectCreationSession = !baseProject \|\| continuingCreationSession \|\| unfinishedReportDraft/);
});

test('choosing a property type resolves a typed address when autocomplete was not selected', () => {
  assert.match(projectRequest, /if \(!addressSelected\) \{[\s\S]{0,180}forwardGeocode\(typedAddress\)/);
});

test('optional proposal loaders keep their promise contract when the proposal module is unavailable', () => {
  assert.match(projectRequest, /async function hydrateProposalsFromBackend\(\.\.\.args\)/);
  assert.match(projectRequest, /async function loadBranchPresentationStyle\(\.\.\.args\)/);
  assert.match(projectRequest, /async function loadBranchProposalTemplates\(\.\.\.args\)/);
});

test('the project modal does not stringify an unavailable proposal markup dock', () => {
  assert.match(projectRequest, /function proposalMarkupDockHtml\(\.\.\.args\)\{ return proposalInvoke\('proposalMarkupDockHtml', args\) \|\| ''; \}/);
});

test('the project modal uses a compositor-friendly translucent scrim', () => {
  const overlayRule = projectRequest.match(/\.r-overlay\{[^}]+\}/)?.[0] || '';
  const windowRule = projectRequest.match(/\.r-win\{[^}]+\}/)?.[0] || '';
  assert.match(overlayRule, /background:rgba\(11,16,24,\.78\)/);
  assert.match(overlayRule, /backdrop-filter:none/);
  assert.doesNotMatch(overlayRule, /backdrop-filter \.24s/);
  assert.doesNotMatch(windowRule, /will-change:/);
  assert.doesNotMatch(projectRequest, /\.r-overlay\.mobile-info-navigation[^}]+will-change:/);
});
