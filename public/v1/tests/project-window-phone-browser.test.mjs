// The project window on a phone (390x844 and 360x740, mobile user agent), and the data-loss
// regression found by the 2026-10-26 mobile QA sweep: opening a sample project by its link
// (`?project=sample_…`) treated the id as a FirstMeasure report id and saved a blank
// "New Project" for it. A link's id is read from the server whatever it looks like; a project
// that cannot be read is never hydrated or saved; a page that never read a project can only
// create it (create_only), never replace it.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const file = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const app = await file('libraries/apps/project-request/app.js');
// The last declaration of a name is the one in effect (app.js declares a few twice).
const fn = (source, name) => {
  const start = [...source.matchAll(new RegExp(`\\n  (async )?function ${name}\\(`, 'g'))].map(match => match.index).at(-1) ?? -1;
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }\n', start) + 4);
};
const phoneAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const chrome = () => chromium.launch({executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--enable-webgl', '--use-angle=swiftshader']});

function openContext(read){
  const events = [], saves = [], reads = [];
  const store = {
    saves,
    ensureFromMeasurement: project => { saves.push(['ensureFromMeasurement', project.id]); return {...project, id: 'project_phantom'}; },
    ensureFromMeasurementAsync: async project => { saves.push(['ensureFromMeasurementAsync', project.id]); return {...project, id: 'project_phantom'}; },
    save: project => { saves.push(['save', project.id]); return project; },
    findByMeasurement: () => null,
    findByMeasurementRemote: async () => null,
    hasPendingSave: () => false
  };
  const context = {
    console, events, reads, store,
    projectRecordPending: false, projectShellLoading: false, projectOpenGeneration: 0, projectWindowToken: 'token',
    projectWindowBridge: {update(){}, takeProjectRead: () => null},
    window: {
      Portal: {ProjectStore: store},
      PlatformAPI: {projects: {get: async (org, id) => { reads.push([org, id]); return read(id); }, rebaseline: (id, data, revision) => events.push(['baseline', id, revision])}},
      FirstMateWindowShell: {afterPaint: async () => {}}
    },
    document: {getElementById: () => null},
    $: () => null, escapeHtml: value => String(value),
    projectOrgId: () => 'org_test',
    loadBranchProjectConfig: async () => ({}), adoptOpeningHeaderState(){},
    openingProjectHeader: project => ({title: project.title, identityHtml: project.title, pillsHtml: ''}),
    activeModalMatchesProject: () => events.length > 0,
    open: (project, options) => { context.projectShellLoading = !!options.shellOnly; events.push(['shell', project.id]); },
    hydrateOpenProjectContent: project => { events.push(['hydrate', project.id, project.title]); context.projectShellLoading = false; },
    applyProposalOpenIntent: async () => {}, applyProjectOpenRouteOptions(){}, activeBaseProject: null,
    projectPrimaryContactAlias: () => ({})
  };
  vm.createContext(context);
  vm.runInContext(['projectText', 'platformProjectId', 'projectOpenId', 'projectFromPlatformDocument', 'mergeProjectForViewing', 'localIsPlatformProjectId',
    'looksLikePlatformProjectRecord', 'looksLikeMeasurementOnlyRecord', 'projectOpenFailure', 'existingProjectForMeasurementId',
    'hydratePlatformProjectForOpen', 'openProject', 'showProjectOpenFailure'].map(name => fn(app, name)).join('\n'), context);
  return context;
}

test('a sample project opened by its link loads the stored project and saves nothing', async () => {
  const id = 'sample_9ccd4530b2b5940488d0388a';
  const context = openContext(() => ({document: {id, revision: 1, data: {id, title: 'Harbor Office — leak repair (Sample)', address: '360 Example Harbor Way', workflow_state: 'project'}}}));
  // The route seed is the id alone, exactly as a feed, notification or shared link opens it.
  await context.openProject({id}, {fromRoute: true});
  assert.deepEqual(context.reads, [['org_test', id]], 'the id is read from the server, not taken for a report id');
  assert.deepEqual(context.store.saves, [], 'nothing is created or saved');
  assert.deepEqual(context.events.find(event => event[0] === 'hydrate'), ['hydrate', id, 'Harbor Office — leak repair (Sample)']);
  assert.deepEqual(context.events.find(event => event[0] === 'baseline'), ['baseline', id, 1], 'the server copy is what later saves diff against');
  assert.equal(context.projectRecordPending, false);
});

test('a project that cannot be read stays provisional: no hydration, no save, the window says why', async () => {
  for (const [label, read, code] of [
    ['missing', () => ({ok: true, document: null, missing: true}), 'project_not_found'],
    ['failed', () => { throw Object.assign(new Error('offline'), {status: 0}); }, 'project_load_failed']
  ]) {
    const context = openContext(read);
    await assert.rejects(context.openProject({id: label === 'missing' ? 'sample_gone' : 'project_offline'}, {fromRoute: true}), error => error.code === code, label);
    assert.equal(context.events.some(event => event[0] === 'hydrate'), false, label + ': no blank form is hydrated');
    assert.deepEqual(context.store.saves, [], label + ': nothing is saved');
    assert.equal(context.projectRecordPending, true, label + ': autosave stays blocked');
    assert.equal(context.projectShellLoading, true, label + ': the shell stays inert');
  }
});

test('report rows still open through the measurement resolver; a bare id does not', () => {
  const context = openContext(() => null);
  assert.equal(context.looksLikeMeasurementOnlyRecord({id: 'sample_9ccd4530b2b5940488d0388a'}), false);
  assert.equal(context.looksLikeMeasurementOnlyRecord({id: 'bd93fca3827f5e7f5bc91548f26d4880'}), false);
  assert.equal(context.looksLikeMeasurementOnlyRecord({id: 'bd93fca3827f5e7f5bc91548f26d4880', status: 'completed', report_url: '/r.pdf'}), true);
  assert.equal(context.looksLikeMeasurementOnlyRecord({measurement_project: {id: 'bd93fca3827f5e7f5bc91548f26d4880'}}), true);
});

test('a page that never read a project saves it create-only, then edits it by PATCH', async () => {
  const browser = await chrome();
  try {
    const page = await browser.newPage();
    await page.setContent('<main></main>');
    await page.evaluate(() => {
      window.calls = [];
      const baselines = new Map();
      window.__APP = {userOrgId: 'org_test'};
      window.Portal = {};
      window.PlatformAPI = {
        orgs: {get: async () => ({organization: {id: 'org_test'}})},
        contacts: {setProjectContacts: async () => ({})},
        projects: {
          baseline: id => baselines.has(id) ? structuredClone(baselines.get(id)) : null,
          rebaseline: (id, data, revision) => baselines.set(id, {data: structuredClone(data), revision}),
          advanceBaseline: (id, fields) => Object.assign(baselines.get(id)?.data || {}, fields),
          save: async (org, id, data, metadata, options) => { calls.push(['PUT', id, options?.createOnly === true, data.title]); return {document: {id, revision: 1, data}}; },
          patch: async (org, id, data) => { calls.push(['PATCH', id, Object.keys(data).filter(key => key !== 'updated_at').sort().join(',')]); return {document: {id, revision: 2, data}}; },
          get: async () => null
        }
      };
    });
    await page.addScriptTag({content: await file('portal/scripts/project_viewer.js')});
    const calls = await page.evaluate(async () => {
      const store = window.Portal.ProjectStore;
      const draft = {id: 'project_new_draft', title: '12 New Street', address: '12 New Street', workflow_state: 'draft'};
      await store.saveRemote(draft);
      await store.saveRemote({...draft, title: '12 New Street (edited)'});
      return window.calls;
    });
    assert.deepEqual(calls, [['PUT', 'project_new_draft', true, '12 New Street'], ['PATCH', 'project_new_draft', 'title']]);
  } finally { await browser.close(); }
});

// A header shaped like the project window's: identity, tabs, the trays control and close, marked
// the way the window manager marks a phone.
async function phoneHeader(page, {mobile}){
  await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial}</style><div class="fm-entity-window r-overlay window-managed"><header class="r-modal-header r-window-bar fm-shell-header" data-header-rows="2" data-window-mobile="' + mobile + '"><div class="r-window-identity fm-shell-identity"><i class="fas fa-folder-open"></i><span id="rWindowProjectTitle">2205 Mimosa Pl, Wilmington, NC 28403, USA</span></div><div class="r-tabbar fm-shell-tabs r-header-icons" id="rProjectViewerTabs"></div><div class="r-window-bar-actions"><div class="fm-window-controls"><button data-window-action="close" aria-label="Close">x</button></div></div></header></div>');
  await page.evaluate(() => { window.Portal = {}; });
  await page.addScriptTag({content: await file('portal/scripts/project_viewer.js')});
  await page.addScriptTag({content: await file('libraries/window-manager/window-shell.js')});
  await page.evaluate(() => {
    // The project window hides labels of icon tabs in a tight header (app.js, observeProjectHeaderFit).
    const style = document.createElement('style');
    style.textContent = '.r-overlay.window-managed .r-tabbar.r-header-icons .r-tab:has(i){font-size:0}.r-overlay.window-managed .r-header-icons .r-tab:has(i) .pv-tab-label{display:none}';
    document.head.append(style);
    window.FirstMateWindowShell?.ensureStyles?.();
    Portal.ProjectViewer.renderTabs(document.getElementById('rProjectViewerTabs'), [['map', 'Overview', 'fa-map-location-dot'], ['measurements', 'Reports', 'fa-ruler-combined'], ['photos', 'Photos', 'fa-images'], ['docs', 'Docs', 'fa-folder-open'], ['materials', 'Materials', 'fa-clipboard-list'], ['customer_portal', 'Portal', 'fa-link']].map(([id, label, icon], index) => ({id, label, icon, active: index === 0})), {tabClass: 'r-tab'});
  });
}

test('on a phone the header is one 48px title row over full-width tabs that each show a small label', async () => {
  const browser = await chrome();
  try {
    for (const [width, height] of [[390, 844], [360, 740]]) {
      const page = await browser.newPage({viewport: {width, height}, userAgent: phoneAgent, isMobile: true, hasTouch: true});
      await phoneHeader(page, {mobile: true});
      const shell = await page.evaluate(() => {
        const header = document.querySelector('.r-modal-header').getBoundingClientRect();
        const tabs = [...document.querySelectorAll('#rProjectViewerTabs .r-tab')].map(button => {
          const label = button.querySelector('.pv-tab-label'), box = button.getBoundingClientRect(), text = label.getBoundingClientRect();
          return {width: Math.round(box.width), height: Math.round(box.height), label: label.textContent, shown: text.width > 0, size: getComputedStyle(label).fontSize, cut: label.scrollWidth > label.clientWidth};
        });
        return {header: Math.round(header.height), tabs};
      });
      assert.ok(shell.header <= 91, `${width}: header ${shell.header}px`);
      assert.equal(shell.tabs.length, 6);
      for (const tab of shell.tabs) {
        assert.ok(tab.shown && tab.size === '10px' && !tab.cut, `${width}: ${tab.label} is labelled in full`);
        assert.ok(Math.abs(tab.width - width / 6) <= 1, `${width}: tabs share the full width`);
        assert.equal(tab.height, 42);
      }
      await page.close();
    }
    // Desktop: the same markup keeps its icon-only fit (labels hidden by the header fit).
    const desktop = await browser.newPage({viewport: {width: 1600, height: 1000}});
    await phoneHeader(desktop, {mobile: false});
    assert.equal(await desktop.locator('#rProjectViewerTabs .pv-tab-label').first().evaluate(label => getComputedStyle(label).display), 'none');
  } finally { await browser.close(); }
});

test('the title opens a compact bottom sheet on a phone without focusing a field', () => {
  const source = fn(app, 'openProjectIdentityPopover');
  assert.match(source, /const phoneSheet=isMobileProjectOrder\(\);/);
  assert.match(source, /if\(phoneSheet\)menu\.focus\(\{preventScroll:true\}\);\s*else menu\.querySelector\('input,button'\)\?\.focus/);
  assert.match(source, /if\(!phoneSheet\)positionProjectHeaderPopover\(menu,trigger,420\);/);
  assert.match(app, /\.r-project-identity-popover\.r-project-identity-sheet\{left:0!important;right:0!important;top:auto!important;bottom:0!important/);
});

test('on a touch screen a tap on the property pin asks before removing it; a mouse click removes it', async () => {
  const map = await file('libraries/apps/project-map/app.js');
  const run = async ({touch, confirmed}) => {
    const listeners = {}, removed = [], prompts = [];
    const context = {
      state: {map: {}, markers: [], syncingPins: false},
      window: {google: {maps: {}}, matchMedia: () => ({matches: touch}), Portal: {ui: {confirm: async prompt => { prompts.push(prompt); return confirmed; }}}},
      google: {maps: {Marker: class { constructor(options){ this.options = options; } addListener(type, handler){ listeners[type] = handler; } setMap(){} getPosition(){ return {lat: () => 1, lng: () => 2}; } }, Size: class {}, Point: class {}}},
      normalizedProjectType: () => 'residential', selectedType: () => 'residential', maxPinsForType: () => 0,
      buildPinIcon: () => '', callHost(){}, showToast(){}, invalidateReportExpediteOptions(){}, notifyPinsChanged(){}, setLocationConfirmed(){},
      pinsSignature: () => '', getMarkersData: () => []
    };
    vm.createContext(context);
    vm.runInContext([fn(map, 'touchPinRemoval'), fn(map, 'confirmTouchPinRemoval'), fn(map, 'addPin'), 'function removePin(marker){ state.markers = state.markers.filter(item => item !== marker); removed.push(marker); }'].join('\n'), Object.assign(context, {removed}));
    const marker = context.addPin({lat: 1, lng: 2});
    listeners.click();
    await new Promise(resolve => setImmediate(resolve));
    return {removed: removed.length, prompts, title: marker.options.title};
  };
  assert.deepEqual(await run({touch: false, confirmed: false}), {removed: 1, prompts: [], title: 'Click to remove. Drag to reposition.'});
  assert.deepEqual(await run({touch: true, confirmed: false}), {removed: 0, prompts: ['Remove this pin from the map?'], title: 'Drag to move this pin. Tap it to remove it.'});
  assert.equal((await run({touch: true, confirmed: true})).removed, 1);
});

test('the Overview map fits the property: close pins are one location, and a map with no size waits for one', () => {
  const map = (async () => file('libraries/apps/project-map/app.js'))();
  return map.then(source => {
    const focused = [], fitted = [];
    let observer;
    const div = {offsetWidth: 0, offsetHeight: 0};
    const context = {
      state: {map: {getDiv: () => div, setMapTypeId(){}, setTilt(){}, setHeading(){}, fitBounds: (bounds, padding) => fitted.push(padding), getZoom: () => 18}},
      google: {maps: {LatLngBounds: class { extend(){} }}},
      ResizeObserver: class { constructor(callback){ this.callback = callback; observer = this; } observe(){} disconnect(){ this.done = true; } },
      applyMapControlsForMode(){}, viewingExistingProject: () => true, setSafeMapZoom(){},
      focusMapOnLocation: (point, zoom) => focused.push([Number(point.lat.toFixed(7)), Number(point.lng.toFixed(7)), zoom]),
      setTimeout: () => 0, Math
    };
    vm.createContext(context);
    vm.runInContext([fn(source, 'pinsSpanMeters'), fn(source, 'whenMapHasSize'), fn(source, 'fitMapToPins')].join('\n'), context);
    // Jack's Mimosa project: two pins nine metres apart, opened while Overview is still laying out.
    const pins = [{lat: 34.2245901, lng: -77.9182369}, {lat: 34.22458954556107, lng: -77.91814235213222}];
    context.fitMapToPins(pins);
    assert.deepEqual(focused, [], 'nothing is fitted to a map with no size');
    div.offsetWidth = 366; div.offsetHeight = 380;
    observer.callback();
    assert.equal(focused.length, 1);
    assert.deepEqual(focused[0].slice(2), [18], 'the property is shown at street level');
    assert.deepEqual(fitted, [], 'close pins are not fitted as bounds');
    // Pins on separate buildings far apart still fit their bounds.
    context.fitMapToPins([{lat: 34.22, lng: -77.91}, {lat: 34.23, lng: -77.90}]);
    assert.deepEqual(fitted, [70]);
  });
});

test('on a touch screen the roof viewer speaks touch, sizes its key for fingers and names both chimney measurements', async () => {
  const browser = await chrome();
  try {
    const xml = '<ROOT><ROOF><POINT id="a" data="0,0,0"/><POINT id="b" data="30,0,0"/><POINT id="c" data="30,15,9"/><POINT id="d" data="0,15,9"/><LINE id="ab" path="b,a" type="EAVE"/><LINE id="bc" path="b,c" type="RAKE"/><LINE id="cd" path="d,c" type="RIDGE"/><LINE id="da" path="d,a" type="RAKE"/><FACE><POLYGON path="ab,bc,cd,da" pitch="7"/></FACE></ROOF></ROOT>';
    for (const [width, height, touch] of [[390, 844, true], [360, 740, true], [1600, 1000, false]]) {
      const page = await browser.newPage({viewport: {width, height}, ...(touch ? {userAgent: phoneAgent, isMobile: true, hasTouch: true} : {})});
      await page.route(url => url.host === 'roof.test', route => route.fulfill(route.request().url().endsWith('.xml') ? {contentType: 'application/xml', body: xml} : {contentType: 'text/html', body: `<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial}#viewer{height:${height - 140}px}</style><div id="viewer"></div>`}));
      await page.goto('http://roof.test/');
      await page.addScriptTag({content: await file('libraries/apps/measurements/roof-viewer.js')});
      await page.addScriptTag({url: 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'});
      await page.evaluate(() => { window.viewer = FirstMeasureRoofViewer.mount(document.querySelector('#viewer'), {xmlUrl: '/model.xml', standalone: true, layout: 'stacked'}); });
      await page.waitForFunction(() => document.querySelector('.fm-roof-canvas canvas') && document.querySelector('.fm-roof-message').hidden, {}, {timeout: 45000});
      const viewer = await page.evaluate(() => ({
        hint: document.querySelector('.fm-roof-hint').textContent,
        columns: getComputedStyle(document.querySelector('.fm-roof-key')).gridTemplateColumns.split(' ').length,
        rows: [...document.querySelectorAll('.fm-roof-key-row')].map(row => ({name: row.querySelector('button').textContent.trim(), height: Math.round(row.getBoundingClientRect().height), input: Math.round(row.querySelector('input')?.getBoundingClientRect().height || 0), cut: row.querySelector('button').scrollWidth > row.querySelector('button').clientWidth + 1}))
      }));
      const names = viewer.rows.map(row => row.name);
      assert.ok(names.includes('Chimney step') && names.includes('Chimney apron') && !names.includes('Chimney'), `${width}: ${names}`);
      if (touch) {
        assert.equal(viewer.hint, 'Drag to orbit · Pinch to zoom · Tap to inspect');
        assert.equal(viewer.columns, 2);
        for (const row of viewer.rows) assert.ok(row.height >= 36 && row.input >= 30 && !row.cut, `${width}: ${row.name} ${row.height}/${row.input}${row.cut ? ' cut' : ''}`);
      } else {
        assert.equal(viewer.hint, 'Drag to orbit · Scroll to zoom · Click to inspect', 'desktop wording is unchanged');
        assert.ok(viewer.columns >= 4);
      }
      viewer && await page.evaluate(() => window.viewer?.destroy?.());
      await page.close();
    }
  } finally { await browser.close(); }
});

test('Reports sub-tabs show labels and Refresh reads as a button on a phone only', () => {
  const measurements = (async () => file('libraries/apps/measurements/project.js'))();
  return measurements.then(source => {
    assert.match(app, /\.r-overlay:has\(\.r-modal-header\[data-window-mobile=true\]\)\.report-ordered:not\(\.mobile-order\) \.r-measure-tab \.pv-tab-label\{display:block/);
    assert.match(source, /data-import-project-measurements><i class="fas fa-rotate r-report-summary-phone-icon" aria-hidden="true"><\/i>/);
    assert.match(source, /\.r-report-summary-phone-icon\{display:none\}/);
  });
});
