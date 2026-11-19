// Settings embedded in a window over another app (GP-120). Scheduling's Crew settings asked for the
// retired `crews` tab; embedded Settings did not map it to People and opened My settings (the AI
// assistant card) instead. Every embedded tab an app asks for is a real Settings category, an
// embedded route is normalized like a link, and People opens on the sub-page the window names
// without writing the page's route (it belongs to the app underneath).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const company = read('public/libraries/apps/settings/company.js');
const people = read('public/libraries/apps/people/people-settings.js');
const scheduling = read('public/libraries/apps/scheduling/app.js');

const sectionIds = new Set([...company.matchAll(/\{ id:'([a-z_]+)', allowed:/g)].map((match) => match[1]));

function browserFiles(dir){
  return fs.readdirSync(dir, { withFileTypes:true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : browserFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

test('every embedded Settings tab an app opens is a Settings category', () => {
  assert.ok(sectionIds.has('people') && sectionIds.has('scheduling') && sectionIds.has('my_settings'), 'settingsSections not found');
  const asked = [];
  for (const file of [...browserFiles(path.join(root, 'public/libraries')), ...browserFiles(path.join(root, 'public/portal'))]) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/embedded:\s*true,\s*settingsTab:\s*'([a-z_]+)'/g)) asked.push({ file:path.relative(root, file), tab:match[1] });
  }
  assert.ok(asked.some((entry) => entry.tab === 'people'), 'Scheduling Crew settings no longer found');
  for (const { file, tab } of asked) assert.ok(sectionIds.has(tab), `${file} opens embedded Settings on '${tab}', which is not a Settings category`);
});

test('Scheduling Crew settings opens People on groups or outside companies', () => {
  assert.match(scheduling, /const settingsView = company \? 'subcontractors' : 'groups';/);
  assert.match(scheduling, /const settingsEntity = resourceId \? `\$\{company \? 'company' : 'group'\}:\$\{resourceId\}` : '';/);
  assert.match(scheduling, /params:\{ embedded:true, settingsTab:'people', settingsView, settingsEntity \}/);
});

test('an embedded route is normalized like a link and names its pane', () => {
  assert.match(company, /if \(embeddedSettings\) Object\.assign\(embeddedRoute, normalizeSettingsLocation\(embeddedRoute\)\);/);
  assert.match(company, /if \(embeddedSettings && tabAllowed\(embeddedRoute\.sub\)\) viewState\.activeTab = embeddedRoute\.sub;/);
  assert.match(company, /data-settings-embedded="1" data-settings-view="\$\{escapeHtml\(embeddedRoute\.settingsView\)\}" data-settings-entity="\$\{escapeHtml\(embeddedRoute\.settingsEntity\)\}"/);
  assert.match(company, /data-settings-pane="\$\{section\.id\}"\$\{embeddedPaneAttrs\(section\)\}/);
});

test('embedded People opens on the named sub-page and leaves the page route alone', () => {
  assert.match(people, /const embedded = pane\.dataset\.settingsEmbedded === '1';/);
  assert.match(people, /mount\(pane, embedded \? \{ route:false, view:pane\.dataset\.settingsView \|\| '', entity:pane\.dataset\.settingsEntity \|\| '' \} : \{\}\)/);
});

// GP-123: in a window that scrolls, the Settings card grows to its content and never scrolls itself;
// overscroll-behavior:contain on it kept the mouse wheel from reaching the window, so only dragging
// the scrollbar moved Scheduling settings.
test('the mouse wheel reaches the window an embedded Settings card sits in', () => {
  const contain = company.indexOf('.cs-main>.cs-card,.cs-wrap.forms-wide .cs-main>.cs-card{height:100%;min-height:0;max-height:none;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain');
  const embedded = company.indexOf('.cs-wrap.embedded-tab-only .cs-main>.cs-card{overscroll-behavior:auto}');
  assert.ok(contain > 0, 'Settings card scroll rule not found');
  assert.ok(embedded > contain, 'embedded Settings card must not contain the wheel (and must come after the rule that does)');
  assert.match(scheduling, /\.dash-crew-settings-modal>\.dash-modal-body\{[^}]*overflow:auto/);
});
