import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../libraries/apps/project-request/app.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `Missing ${name}`);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}

function harness({ loading = false, enabled = true, leftMode = 'workflow' } = {}) {
  let root = { children: [], replaceWith(next) { root = next; } };
  let value;
  let hydrations = 0;
  let bindings = 0;
  let selectedTab;
  const listeners = {};
  const noop = () => {};
  const context = {
    document: {
      querySelector: () => ({}),
      createElement: () => ({
        set innerHTML(html) {
          this.content = { firstElementChild: {
            classList: { contains: name => name === 'r-left' },
            children: html === 'enabled' ? [{}] : [],
          } };
        },
      }),
    },
    $: () => root,
    projectModalResolvedPresentation: () => ({ leftMode }),
    projectModalRegionHtml: () => enabled ? 'enabled' : 'disabled',
    activeBaseProject: { id: 'project-1', address: '418 Juniper Lane' },
    projectShellLoading: loading,
    activePreviewTab: 'docs',
    bindProjectModalFormControls() { bindings++; },
    hydrateFromBaseProject(project) {
      assert.ok(root.children.length, 'Form must exist before values hydrate');
      value = project.address;
      hydrations++;
    },
    projectOpenId: () => 'project-1',
    validPreviewTabs: () => ['map', 'docs', 'checklists'],
    projectDefaultPreviewTab: () => 'docs',
    setActivePreviewTab(tab, options) {
      assert.equal(options.syncRoute, false, 'Recovery must not write history');
      selectedTab = tab;
    },
    window: {
      Portal: { routeState: { get: () => ({ project: 'project-1', projectTab: 'checklists' }) } },
      addEventListener: (name, handler) => { listeners[name] = handler; },
    },
  };
  for (const name of ['syncContactsFeatureState', 'ensureProjectModalAppPanels', 'syncProjectViewerTabs',
    'applyProjectModalPresentation', 'renderProjectStageBar', 'renderWorkflowState',
    'mountProjectModalRegionApps', 'mountProjectModalApps', 'syncProjectModalAppActivation']) context[name] = noop;
  vm.createContext(context);
  vm.runInContext(functionSource('ensureProjectModalLeftRegion') + functionSource('refreshProjectModalForAppFlags'), context);
  const subscription = source.match(/  window.addEventListener\('fm:capabilities:updated',[^\n]+/);
  assert.ok(subscription, 'Project modal must respond to capability completion');
  vm.runInContext(subscription[0], context);
  return {
    context,
    update: () => listeners['fm:capabilities:updated'](),
    get value() { return value; },
    edit: text => { value = text; },
    get hydrations() { return hydrations; },
    get bindings() { return bindings; },
    get selectedTab() { return selectedTab; },
    get populated() { return !!root.children.length; },
  };
}

test('capabilities arriving after project data restore controls, values, and the requested tab', () => {
  const h = harness();
  h.update();
  assert.equal(h.value, '418 Juniper Lane');
  assert.equal(h.selectedTab, 'checklists');
  h.edit('Unsaved address');
  h.update();
  assert.equal(h.value, 'Unsaved address');
  assert.equal(h.hydrations, 1);
  assert.equal(h.bindings, 1);
});

test('capabilities arriving while the project is loading prepare controls without changing the tab', () => {
  const h = harness({ loading: true });
  h.update();
  assert.equal(h.populated, true);
  assert.equal(h.selectedTab, undefined);
  h.context.projectShellLoading = false;
  h.update();
  assert.equal(h.selectedTab, 'checklists');
});

test('disabled region apps and field shells stay excluded', () => {
  for (const options of [{ enabled: false }, { leftMode: 'none' }]) {
    const h = harness(options);
    h.update();
    assert.equal(h.populated, false);
    assert.equal(h.hydrations, 0);
  }
});

test('a late Docs mount cannot reactivate after the requested tab has recovered', async () => {
  let finishMount;
  let active;
  const context = {
    window: { FirstMateEmbeddableApps: { mount: () => new Promise(resolve => { finishMount = resolve; }) } },
    document: { querySelector: () => ({}) },
    $: () => ({}),
    cssEscape: value => value,
    projectModalAppHandles: new Map(),
    projectModalAppMounts: new Map(),
    projectWorkspaceHost: () => ({}),
    projectModalResolvedPresentation: () => ({ leftMode: 'workflow' }),
    projectModalRuntimeContext: value => value,
    activePreviewTab: 'docs',
    console,
  };
  vm.createContext(context);
  vm.runInContext(functionSource('mountProjectModalApp'), context);
  const mounted = context.mountProjectModalApp({ id: 'docs', appId: 'project.documents' });
  context.activePreviewTab = 'map';
  finishMount({ setActive: value => { active = value; } });
  await mounted;
  assert.equal(active, false);
});
