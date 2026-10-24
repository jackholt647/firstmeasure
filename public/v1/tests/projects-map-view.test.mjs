import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const viewer = read('../../libraries/apps/projects/viewer.js');
const mapView = read('../../libraries/apps/projects/map-view.js');
const manifest = read('../../libraries/apps/firstmate-apps-manifest.js');
const portal = read('../../portal/index.php');
const slice = (from, to) => viewer.slice(viewer.indexOf(from), viewer.indexOf(to));

test('the map view follows the Project Map feature and falls back when it is off', () => {
  let mapOn = false;
  const context = vm.createContext({
    VIEW_MODES: new Set(['tiles', 'list', 'stages', 'map']),
    window: { FirstMateProjectsMap: {}, Portal: { appFlags: { value: (group, key, fallback) => (group === 'apps' && key === 'project_map' ? mapOn : (key === 'project_boards' || key === 'project_stages_view' ? true : fallback)) } } }
  });
  vm.runInContext(slice('  function projectBoardsEnabled(){', '  function fmtMoney('), context);
  assert.equal(vm.runInContext("normalizeViewMode('map')", context), 'stages');
  mapOn = true;
  assert.equal(vm.runInContext("normalizeViewMode('map')", context), 'map');
  context.window.FirstMateProjectsMap = undefined;
  assert.equal(vm.runInContext("normalizeViewMode('map')", context), 'stages');
  assert.match(viewer, /values:\['stages','list','tiles','map'\]/);
});

function modelContext({ activeWorkBoardId }){
  const projects = [
    { id: 'p1', address: '1 Main St, Austin, TX 78701', lat: 30.26, lng: -97.74 },
    { id: 'p2', address: '2 Oak Ave, Austin, TX 78702' },
    { id: 'p3', address: '3 Elm Rd, Austin, TX 78703', pins: [{ lat: 30.3, lng: -97.7 }] },
    { id: 'p4', address: 'Not on a board' }
  ];
  const sales = { id: 'sales', title: 'Sales', color: '#2563eb', columns: [{ id: 'lead', title: 'Lead', color: '#f59e0b', items: [projects[0], projects[1]] }, { id: 'won', title: 'Won', color: '#16a34a', items: [projects[2]] }] };
  const production = { id: 'production', title: 'Production', color: '#7c3aed', columns: [{ id: 'build', title: 'Build', color: '#ef4444', items: [projects[2]] }] };
  const opened = [];
  const context = vm.createContext({
    filteredProjects: projects,
    activeWorkBoardId,
    workBoardsLoaded: true,
    lastProjectsById: new Map(projects.map((project) => [project.id, project])),
    projectBoardsEnabled: () => true,
    workBoardPickerOffered: () => true,
    projectBoards: () => [sales, production],
    orderedWorkBoards: () => [sales, production],
    selectedBoardColumns: (board) => board.columns,
    renderWorkBoardSummary: () => {},
    loadWorkBoards: () => Promise.resolve([]),
    projectSharingView: () => null,
    stageColumnsForProjects: () => [],
    normalizeProjectRecord: (project) => project,
    resolveResidentFields: () => ({ name: '' }),
    displayAddressLine1: (project) => String(project.address || '').split(',')[0],
    displayAddressLine2: (project) => String(project.address || '').split(',').slice(1).join(',').trim(),
    projectThumbnailPoint: (project) => (project.lat != null ? { lat: project.lat, lng: project.lng } : project.pins?.[0] || null),
    openModal: (project) => opened.push(project.id)
  });
  vm.runInContext(slice('  function mapViewModel(){', '  function renderMapView('), context);
  return { context, opened };
}

test('a selected board puts its projects on the map coloured by stage and keeps unlocated ones', () => {
  const { context, opened } = modelContext({ activeWorkBoardId: 'sales' });
  const live = vm.runInContext('mapViewModel()', context);
  const model = { ...JSON.parse(JSON.stringify(live)), open: live.open };
  assert.equal(model.groupLabel, 'stage');
  assert.equal(model.scopeKey, 'board:sales');
  assert.deepEqual(model.items.map((item) => [item.id, item.groupId, item.color]), [['p1', 'lead', '#f59e0b'], ['p2', 'lead', '#f59e0b'], ['p3', 'won', '#16a34a']]);
  assert.deepEqual(model.items.map((item) => item.point), [{ lat: 30.26, lng: -97.74 }, null, { lat: 30.3, lng: -97.7 }]);
  assert.equal(model.items[1].address, '2 Oak Ave, Austin, TX 78702');
  assert.deepEqual(model.groups.map((group) => group.id), ['lead', 'won']);
  model.open(model.items[1].project);
  assert.deepEqual(opened, ['p2']);
});

test('all boards colour each project by its first board', () => {
  const { context } = modelContext({ activeWorkBoardId: 'all' });
  const live = vm.runInContext('mapViewModel()', context);
  const model = { ...JSON.parse(JSON.stringify(live)), open: live.open };
  assert.equal(model.groupLabel, 'board');
  assert.deepEqual(model.items.map((item) => [item.id, item.groupId, item.color]), [['p1', 'sales', '#2563eb'], ['p2', 'sales', '#2563eb'], ['p3', 'sales', '#2563eb']]);
  assert.deepEqual(model.groups.map((group) => group.id), ['sales']);
});

test('the map module loads before the viewer, reuses the portal Google map and opens no stream', () => {
  assert.match(manifest, /versionedBundle\('projects\/map-view\.js', '[^']+'\), versionedBundle\('projects\/viewer\.js'/);
  assert.ok(portal.indexOf('apps/projects/map-view.js') > 0 && portal.indexOf('apps/projects/map-view.js') < portal.indexOf('apps/projects/viewer.js'));
  assert.match(mapView, /window\.FirstMateProjectsMap = \{/);
  assert.doesNotMatch(mapView, /EventSource|WebSocket|maps\.googleapis\.com|<script/);
  assert.match(mapView, /prefers-reduced-motion/);
});

function resultsContext({ viewMode, allProjects = [], filteredProjects = [], hideDrafts = false, totalUnfilteredCount = 0, workBoards = [] }){
  const updates = [];
  const stagesRendered = [];
  const results = { innerHTML:'' };
  const context = vm.createContext({
    viewMode, allProjects, filteredProjects, hideDrafts, totalUnfilteredCount,
    panelEl:{}, $:(selector) => (selector === '#vResults' ? results : null),
    sharedProjectRecords:() => [],
    workBoards, projectBoardsEnabled:() => true, renderStagesView:() => stagesRendered.push(true),
    mapViewModel:() => ({ items:[], groups:[], groupLabel:'stage', scopeKey:'board:sales' }),
    window:{ FirstMateProjectsMap:{ update:(container, model) => updates.push(model) } },
    globalThis:{}
  });
  vm.runInContext(slice('  function renderMapView(', '  function upsertProjectForViewer('), context);
  vm.runInContext('renderResults()', context);
  return { updates:updates.map((model) => JSON.parse(JSON.stringify(model))), results, stagesRendered:stagesRendered.length };
}

test('with no projects the map view still draws the map and its tray says there are none yet', () => {
  const { updates, results } = resultsContext({ viewMode:'map' });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].empty, 'none');
  assert.deepEqual(updates[0].items, []);
  assert.doesNotMatch(results.innerHTML, /New Project/);
});

test('filters that leave nothing keep the map and say nothing matches', () => {
  assert.equal(resultsContext({ viewMode:'map', allProjects:[{ id:'p1' }] }).updates[0].empty, 'filtered');
  assert.equal(resultsContext({ viewMode:'map', hideDrafts:true, totalUnfilteredCount:3 }).updates[0].empty, 'filtered');
});

test('stages keep their columns with no projects when the organization has a board', () => {
  const { results, stagesRendered } = resultsContext({ viewMode:'stages', workBoards:[{ id:'roofing', columns:[] }] });
  assert.equal(stagesRendered, 1);
  assert.doesNotMatch(results.innerHTML, /No projects yet\./);
});

test('other views keep their own empty states', () => {
  for (const viewMode of ['list', 'tiles', 'stages']) {
    const { updates, results } = resultsContext({ viewMode });
    assert.equal(updates.length, 0);
    assert.match(results.innerHTML, /No projects yet\./);
  }
});

test('the map tray has its own empty state with new language keys', () => {
  for (const key of ['projects_map_empty_none_title', 'projects_map_empty_none_detail', 'projects_map_empty_filtered_title', 'projects_map_empty_filtered_detail']) {
    assert.match(mapView, new RegExp(`"projects","${key}"`));
  }
  assert.match(mapView, /\.pm-empty\.is-view\{[^}]*animation:pm-row-in/);
});
