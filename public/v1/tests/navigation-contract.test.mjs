import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const navigationSource = await readFile(path.join(publicRoot, 'libraries/navigation/portal-navigation.js'), 'utf8');
const projectModalSource = await readFile(path.join(publicRoot, 'libraries/apps/project-request/app.js'), 'utf8');
const actionItemsSource = await readFile(path.join(publicRoot, 'libraries/platform-action-items/platform-action-items.js'), 'utf8');
const companySettingsSource = await readFile(path.join(publicRoot, 'libraries/apps/settings/company.js'), 'utf8');

function navigationHarness(initial = '/portal/?tab=scheduling') {
  const listeners = new Map();
  const entries = [{ url:new URL(initial, 'https://firstmate.test'), state:null }];
  let index = 0;
  const location = {};
  const syncLocation = () => {
    const url = entries[index].url;
    Object.assign(location, { href:url.href, pathname:url.pathname, search:url.search, hash:url.hash });
  };
  const dispatch = (event) => (listeners.get(event.type) || []).forEach((listener) => listener(event));
  syncLocation();
  const history = {
    get state(){ return entries[index].state; },
    pushState(state, _title, href){ entries.splice(index + 1); entries.push({ url:new URL(href, location.href), state }); index = entries.length - 1; syncLocation(); },
    replaceState(state, _title, href){ entries[index] = { url:new URL(href, location.href), state }; syncLocation(); },
    go(delta){
      const next = Math.max(0, Math.min(entries.length - 1, index + Number(delta || 0)));
      if (next === index) return;
      index = next;
      syncLocation();
      dispatch({ type:'popstate', state:entries[index].state });
    },
    back(){ this.go(-1); }
  };
  class CustomEvent { constructor(type, init = {}){ this.type = type; this.detail = init.detail; } }
  const window = {
    location, history, document:{ documentElement:{ classList:{ add(){}, remove(){} } } }, CustomEvent, console,
    addEventListener(type, listener){ listeners.set(type, [...(listeners.get(type) || []), listener]); },
    removeEventListener(type, listener){ listeners.set(type, (listeners.get(type) || []).filter((item) => item !== listener)); },
    dispatchEvent:dispatch
  };
  vm.runInNewContext(navigationSource, { window, document:window.document, URL, CustomEvent, console, setTimeout, clearTimeout });
  return { window, navigation:window.Portal.navigation, entries, get index(){ return index; } };
}

test('Feedback mounts the shared settings workspace and restores its own nested routes', async () => {
  const harness = navigationHarness('/portal/?tab=feedback&feedbackView=workflow');
  const { window, navigation } = harness;
  const manifests = new Map();
  const apps = new Map();
  window.FirstMateEmbeddableApps = {
    registerManifest: (app) => manifests.set(app.id, app),
    registerApp: (app) => apps.set(app.id, app)
  };
  const manifestSource = await readFile(path.join(publicRoot, 'libraries/apps/firstmate-apps-manifest.js'), 'utf8');
  vm.runInNewContext(manifestSource, { window, document:{ currentScript:{ src:'https://firstmate.test/libraries/apps/firstmate-apps-manifest.js' } }, URL });
  const manifest = manifests.get('portal.feedback');
  assert.equal(manifest.title, 'Feedback');
  assert.equal(manifest.placement, 'more');
  assert.equal(manifest.access.capability, 'apps.feedback');
  assert.equal(manifest.portalTabId, 'feedback');
  assert.ok(manifest.bundles.some((url) => url.includes('/settings/feedback.js')));
  navigation.registerSchema('feedbackView', { ...manifest.route.params.feedbackView, scopes:[{ tab:'feedback' }] });

  const host = { style:{}, remove(){ this.removed = true; } };
  let options;
  let visibleView;
  let mounts = 0;
  let destroyed = false;
  window.FirstMateFeedbackSettings = {
    mount(element, config){ assert.equal(element, host); options = config; visibleView = config.initialView; mounts++; },
    setView(element, next){ assert.equal(element, host); visibleView = next; },
    destroy(element){ assert.equal(element, host); destroyed = true; }
  };
  const appSource = await readFile(path.join(publicRoot, 'libraries/apps/feedback/app.js'), 'utf8');
  vm.runInNewContext(appSource, { window, document:{ createElement:() => host } });
  const controller = apps.get('portal.feedback').mount({ root:{ appendChild(){} }, orgId:'org-test', branchId:'branch-test' });
  assert.equal(options.orgId, 'org-test');
  assert.equal(options.branchId, 'branch-test');
  assert.equal(visibleView, 'workflow');
  options.onViewChange('delivery');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(navigation.read().feedbackView, 'delivery');
  assert.equal(harness.entries.length, 2);
  window.history.back();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(visibleView, 'workflow');
  window.history.go(1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(visibleView, 'delivery');
  assert.equal(harness.entries.length, 2);
  navigation.push({ tab:'feedback', feedbackView:null });
  await navigation.applyCurrent();
  assert.equal(visibleView, 'responses');
  navigation.push({ tab:'company_settings', sub:'feedback', settingsView:'workflow' });
  assert.equal(navigation.read().feedbackView, undefined);
  assert.equal(mounts, 1);
  controller.destroy();
  assert.equal(destroyed, true);
  assert.equal(host.removed, true);
});

test('legacy Calls URLs restore the central call lists without a duplicate history entry', () => {
  const harness = navigationHarness('/portal/?tab=calls&communicationsView=inbox&callQueue=new_leads&callIndex=2&customerCall=call-1');
  const nav = harness.navigation;
  nav.registerSchema('callQueue', { history:'push', scopes:[{tab:'chat'}] });
  assert.equal(nav.read().tab, 'chat');
  assert.equal(nav.read().communicationsView, 'lists');
  nav.reconcile();
  assert.equal(harness.entries.length, 1);
  assert.equal(new URL(harness.window.location.href).searchParams.get('tab'), 'chat');
  assert.equal(nav.read().callQueue, 'new_leads');
  assert.equal(nav.read().callIndex, '2');
  assert.equal(nav.read().customerCall, 'call-1');
  nav.push({ tab:'viewer' });
  nav.push({ tab:'calls', communicationsView:'inbox' });
  assert.equal(nav.read().tab, 'chat');
  assert.equal(nav.read().communicationsView, 'lists');
});

test('declared page routes push while filters replace the current entry', () => {
  const harness = navigationHarness();
  const nav = harness.navigation;
  nav.registerSchema('project', { history:'push' });
  nav.registerSchema('query', { history:'replace' });
  nav.write({ project:'project-1' });
  assert.equal(harness.entries.length, 2);
  nav.write({ query:'roof' });
  assert.equal(harness.entries.length, 2);
  assert.equal(nav.read().query, 'roof');
  assert.deepEqual(Array.from(harness.window.history.state.fmNavigation.ownedKeys), ['query']);
});

test('scope Events preserves its parent route and replaces filters without extra Back steps', async () => {
  const harness = navigationHarness('/portal/?tab=company_settings&sub=project_scopes&settingsView=editor&settingsEntity=scope:roof&scopeTemplateView=details');
  const nav = harness.navigation;
  nav.registerSchema('scopeTemplateView', { values:['details','boards','scheduling','developer','automations','commissions','events'], history:'push' });
  nav.registerSchema('scopeEventFilter', { values:['all','connected','unused','actions'], history:'replace' });
  nav.push({ scopeTemplateView:'events' }, { ownedKeys:['scopeTemplateView'] });
  nav.replace({ scopeEventFilter:'unused' }, { ownedKeys:['scopeEventFilter'] });
  assert.equal(harness.entries.length, 2);
  assert.equal(nav.read().settingsEntity, 'scope:roof');
  assert.equal(nav.read().scopeTemplateView, 'events');
  harness.window.history.back();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(nav.read().scopeTemplateView, 'details');
  assert.equal(nav.read().scopeEventFilter, undefined);
});

test('Back reapplies the previous route through the single dispatcher', async () => {
  const harness = navigationHarness();
  const nav = harness.navigation;
  const applied = [];
  nav.registerHandler('test-project', { priority:10, apply:(route) => applied.push(route.project || '') });
  nav.push({ project:'one' }, { ownedKeys:['project'] });
  nav.push({ project:'two' }, { ownedKeys:['project'] });
  harness.window.history.back();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(nav.read().project, 'one');
  assert.equal(applied.at(-1), 'one');
});

test('routed modal close uses Back only for an entry that owns its key', async () => {
  const harness = navigationHarness();
  const nav = harness.navigation;
  nav.push({ contact:'contact-1' }, { ownedKeys:['contact'] });
  assert.equal(nav.backOrClose(['contact'], { contact:null }).backed, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(nav.read().contact, undefined);
  nav.replace({ contact:'direct-link' }, { ownedKeys:[] });
  assert.equal(nav.backOrClose(['contact'], { contact:null }).backed, false);
  assert.equal(nav.read().contact, undefined);
});

test('modal close exits the complete nested modal history segment', async () => {
  const harness = navigationHarness();
  const nav = harness.navigation;
  nav.push({ project:'project-1', projectTab:'overview' }, { ownedKeys:['project', 'projectTab'] });
  nav.push({ projectTab:'photos' }, { ownedKeys:['project', 'projectTab'] });
  nav.push({ photo:'photo-1' }, { ownedKeys:['project', 'photo'] });
  assert.equal(harness.entries.length, 4);
  const result = nav.backOrClose(['project'], { project:null, projectTab:null, photo:null });
  assert.equal(result.backed, true);
  assert.equal(result.steps, 3);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(nav.read().project, undefined);
  assert.equal(harness.index, 0);
});

test('portal tab changes prune parameters owned by the tab being left', () => {
  const harness = navigationHarness('/portal/?tab=company_settings&sub=sms&workflow=10dlc&workflow_step=brand');
  const nav = harness.navigation;
  nav.registerApp({
    id:'portal.company_settings', portalTabId:'company_settings',
    route:{ parent:'portal', params:{ tab:{ history:'push' }, sub:{ history:'push' }, workflow:{ history:'push' }, workflow_step:{ history:'push' } } }
  });
  nav.registerApp({
    id:'portal.scheduling', portalTabId:'scheduling',
    route:{ parent:'portal', params:{ tab:{ history:'push' }, scheduleView:{ history:'push' }, date:{ history:'replace' } } }
  });

  nav.push({ tab:'scheduling', scheduleView:'week', date:'2026-08-03' });

  assert.deepEqual({ ...nav.read() }, { tab:'scheduling', scheduleView:'week', date:'2026-08-03' });
  assert.equal(harness.window.location.search.includes('workflow'), false);
  assert.equal(harness.window.location.search.includes('sub='), false);
});

test('refresh reconciliation removes stale settings state without redirecting to Settings', () => {
  const harness = navigationHarness('/portal/?tab=scheduling&sub=sms&workflow=10dlc&workflow_step=brand');
  const nav = harness.navigation;
  nav.registerApp({
    id:'portal.company_settings', portalTabId:'company_settings',
    route:{ parent:'portal', params:{ tab:{ history:'push' }, sub:{ history:'push' }, workflow:{ history:'push' }, workflow_step:{ history:'push' } } }
  });
  nav.registerApp({
    id:'portal.scheduling', portalTabId:'scheduling',
    route:{ parent:'portal', params:{ tab:{ history:'push' }, scheduleView:{ history:'push' } } }
  });

  nav.reconcile({ source:'test-boot' });

  assert.deepEqual({ ...nav.read() }, { tab:'scheduling' });
  assert.equal(harness.entries.length, 1, 'boot cleanup must replace, not add history');
});

test('portal boot replaces an unavailable routed tab only after access is ready', async () => {
  const core = await readFile(path.join(publicRoot, 'portal/scripts/core.js'), 'utf8');
  assert.match(core, /routesReady: false/);
  assert.match(core, /await Promise\.all\(\[appFlagsReady, capabilitiesReady, terminologyReady\]\);\s*TabRegistry\.routesReady = true;\s*renderTabs\(\);/);
  assert.match(core, /!routeTab && currentRoute\.tab && TabRegistry\.routesReady/);
  assert.match(core, /history:'replace', source:'unavailable-tab-fallback'/);
});

test('an empty portal route defaults to the first visible app, not an entitlement home hint', async () => {
  const core = await readFile(path.join(publicRoot, 'portal/scripts/core.js'), 'utf8');
  const defaultSelector = core.match(/function defaultPortalTab\(list = \[\]\)\{[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(defaultSelector, /return list\[0\]\?\.id \|\| null;/);
  assert.doesNotMatch(defaultSelector, /find\([^\n]*defaultHome|company_settings|TabRegistry\.tabs\.has\('dashboard'\)/);
  assert.match(core, /if \(!currentRoute\.tab && !TabRegistry\.routesReady\) \{\s*TabRegistry\.activeId = null;[\s\S]*?return;\s*\}/);
  assert.match(core, /if \(!routeTab && !currentRoute\.tab && TabRegistry\.routesReady\) \{\s*TabRegistry\.activeId = defaultPortalTab\(list\);/);
});

test('shared packages scope nested routes to the app that actually owns them', async () => {
  const manifest = await readFile(path.join(publicRoot, 'libraries/apps/firstmate-apps-manifest.js'), 'utf8');
  assert.match(manifest, /salesScheduleView:\{[^}]*apps:\['portal\.sales_schedule'\]/);
  assert.match(manifest, /crewScheduleView:\{[^}]*apps:\['portal\.crew_schedule'\]/);
  assert.match(manifest, /feedDensity:\{[^}]*apps:\['portal\.photos_feed'\]/);
  assert.match(manifest, /if \(allowedApps\.length && !allowedApps\.includes\(app\.id\)\) return;/);
  assert.match(manifest, /const \{ apps: _apps, \.\.\.schema \} = definition \|\| \{\};/);
  assert.match(manifest, /!definition\.history\) return;\s*params\[key\] = \{ \.\.\.definition \};/);
});

test('project subtab changes prune sibling project parameters', () => {
  const harness = navigationHarness('/portal/?tab=viewer&project=p1&projectTab=schedule&projectScheduleView=month&projectScheduleTarget=production');
  const nav = harness.navigation;
  nav.registerApp({
    id:'project.schedule',
    route:{ parent:'project', params:{ project:{ history:'push' }, projectTab:{ default:'schedule', history:'push' }, projectScheduleView:{ history:'push' }, projectScheduleTarget:{ history:'push' } } }
  });
  nav.registerApp({
    id:'project.money',
    route:{ parent:'project', params:{ project:{ history:'push' }, projectTab:{ default:'money', history:'push' }, moneyView:{ history:'push' } } }
  });

  nav.push({ projectTab:'money', moneyView:'invoices' });

  assert.deepEqual({ ...nav.read() }, { tab:'viewer', project:'p1', projectTab:'money', moneyView:'invoices' });
});

test('project route restoration cannot replace a requested tab with an async fallback', () => {
  assert.match(projectModalSource, /syncRoute:options\.fromRoute !== true/);
  assert.match(projectModalSource, /renderWorkflowState\(\{ preserveRouteTab:options\.fromRoute === true \}\)/);
  assert.match(projectModalSource, /if \(!options\.fromRoute\) \{\s*syncActiveProjectRoute\(/);
});

test('project workflow to-dos open their actionable project tabs', async () => {
  const opened = [];
  const window = {
    PlatformAPI:{},
    Portal:{
      routeState:{ resolveProject:async (projectId) => ({ id:projectId, platform_project_id:projectId }) },
      modules:{ request:{ openProject:async (project, options) => { opened.push({ project, options }); return project; } } }
    }
  };
  vm.runInNewContext(actionItemsSource, { window, document:{}, CustomEvent:class CustomEvent {} });

  assert.equal(window.PlatformActionItems.projectTabForItem({ template_node_id:'order_materials' }), 'materials');

  await window.PlatformActionItems.open({
    kind:'workflow_task',
    project_id:'project-1',
    template_node_id:'finalize_material_lists',
    frontend_action:{ kind:'open_project' }
  });
  await window.PlatformActionItems.open({
    kind:'schedule_sold_project',
    project_id:'project-1',
    frontend_action:{ kind:'open_project_scheduling', tab:'scheduling' }
  });

  assert.equal(opened[0].options.tab, 'materials');
  assert.equal(opened[1].options.tab, 'schedule');
  assert.equal(opened[0].options.history, 'push');
});

async function javascriptFiles(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes:true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...await javascriptFiles(file));
    else if (entry.isFile() && entry.name.endsWith('.js')) output.push(file);
  }
  return output;
}

test('feature apps do not bypass Portal.navigation', async () => {
  const appRoot = path.join(publicRoot, 'libraries/apps');
  const violations = [];
  for (const file of await javascriptFiles(appRoot)) {
    const source = await readFile(file, 'utf8');
    if (/(?:window\.)?history\s*\.\s*(?:pushState|replaceState)\s*\(/.test(source)) violations.push(path.relative(publicRoot, file));
  }
  assert.deepEqual(violations, [], `Use Portal.navigation instead of direct history writes: ${violations.join(', ')}`);
});

test('payment partner settings use a routed authenticated iframe modal', () => {
  assert.match(companySettingsSource, /requestedPath = String\(options\.targetPath \|\| '\/settings'\)/);
  assert.match(companySettingsSource, /targetUrl = new URL\(targetPath, login\.origin\)\.href;/);
  assert.match(companySettingsSource, /data-mp-portal-frame/);
  assert.doesNotMatch(companySettingsSource, /hostedMoneyHeader|data-money-portal-refresh/);
  assert.match(companySettingsSource, /frame\.addEventListener\('load',[\s\S]*?frame\.src = targetUrl;/);
  assert.match(companySettingsSource, /workflow: 'money_portal', workflow_step: 'settings'/);
  assert.match(companySettingsSource, /openForwardPortal\(\{ fromRoute: true \}\)/);
  assert.match(companySettingsSource, /backOrClose\?\.\(\['workflow', 'workflow_step'\][\s\S]*?source: 'money-portal-close'/);
});

test('Payments Manage at Forward opens the provider portal directly', () => {
  assert.match(companySettingsSource, /const openForwardPortalExternal = async \(\) =>/);
  assert.match(companySettingsSource, /window\.open\('about:blank', '_blank'\)/);
  assert.match(companySettingsSource, /portalWindow\.location\.replace\(loginUrl\)/);
  assert.match(companySettingsSource, /\[data-mp-manage-bank\][\s\S]{0,260}await openForwardPortalExternal\(\)/);
  assert.match(companySettingsSource, /\[data-mp-portal-track\][\s\S]{0,260}await openForwardPortal\(\)/);
});

test('capability-gated apps fail closed until organization capabilities load', async () => {
  const runtime = await readFile(path.join(publicRoot, 'libraries/app-runtime/firstmate-embeddable-apps.js'), 'utf8');
  assert.match(runtime, /if \(!state\?\.definitions_by_key\) return !explicit;/);
  assert.doesNotMatch(runtime, /if \(!state\?\.definitions_by_key\) return true;/);
});

test('project invoice tab is declared and restored through the Money route schema', async () => {
  const manifest = await readFile(path.join(publicRoot, 'libraries/apps/firstmate-apps-manifest.js'), 'utf8');
  const moneyApp = await readFile(path.join(publicRoot, 'libraries/apps/money/project.js'), 'utf8');
  assert.match(manifest, /moneyView:\{ default:'overview', values:\[[^\]]*'invoices'/);
  assert.match(moneyApp, /state\.activeView === 'invoices'/);
  assert.match(moneyApp, /name="render_paid_in_full"/);
  assert.match(moneyApp, /role="switch"/);
  assert.match(moneyApp, /data-paid=/);
  assert.match(moneyApp, /Generate & Download/);
  assert.match(moneyApp, /Generate an Email/);
  assert.match(moneyApp, /data-money-invoice-email-modal-form/);
  assert.match(moneyApp, /data-money-invoice-email-existing/);
  assert.match(moneyApp, /data-money-invoice-add-manual/);
  assert.match(moneyApp, /data-money-invoice-add-payment/);
  assert.match(moneyApp, /name="tax_enabled"/);
  assert.match(moneyApp, /line_items:lineItems/);
  assert.match(moneyApp, /mn-invoice-generate-column/);
  assert.match(moneyApp, /mn-invoice-history-column/);
  assert.match(moneyApp, /mn-invoice-history-top/);
  assert.doesNotMatch(moneyApp, /function kpiBand\(|kpiBand\(summary\)/);
  assert.match(moneyApp, /mn-layout mn-overview-layout/);
  assert.match(moneyApp, /ledgerSection\(\)/);
  assert.match(moneyApp, /ledgerFilters: \{ payments:true, expenses:true, activity:false \}/);
  assert.match(moneyApp, /ledgerSort: \{ key:'date', direction:'desc' \}/);
  assert.match(moneyApp, /data-money-ledger-filter/);
  assert.match(moneyApp, /data-money-ledger-sort/);
  assert.match(moneyApp, /aria-sort=/);
  assert.match(moneyApp, /state\.ledgerSort = \{ key, direction \}/);
  assert.match(moneyApp, /\['money_in', 'In', 'end'\][\s\S]*\['money_out', 'Out', 'end'\]/);
  assert.match(moneyApp, /mn-overview-layout\{grid-template-columns:minmax\(0,1\.45fr\) minmax\(260px,\.55fr\)\}/);
  assert.match(moneyApp, /mn-ledger-table\{width:100%;min-width:0;table-layout:fixed\}/);
  assert.match(moneyApp, /mn-ledger-table th:nth-child\(2\),\.mn-ledger-table td:nth-child\(2\)\{width:32%;max-width:300px;overflow:hidden\}/);
  assert.match(moneyApp, /data-money-ledger-detail/);
  assert.match(moneyApp, /data-money-delete-expense/);
  assert.match(moneyApp, /term\('transaction'\)[\s\S]*term\('receipt'\)[\s\S]*term\('money_in'\)[\s\S]*term\('money_out'\)[\s\S]*term\('balance'\)/);
  assert.match(moneyApp, /id:'payments', icon:'fa-money-check-dollar'/);
  assert.doesNotMatch(moneyApp, /viewTab\('activity'/);
  assert.match(moneyApp, /id:'expenses', icon:'fa-list-check', label:term\('expense_lists'\)/);
  assert.match(moneyApp, /add_collected_payment:'Add Collected Payment'/);
  assert.match(moneyApp, /<h3>\$\{escapeHtml\(term\('add_collected_payment'\)\)\}<\/h3>/);
  assert.match(moneyApp, /PlatformScheduling\.loadBranchConfig/);
  assert.match(moneyApp, /cleanText\(event\.type, event\.event_type\)/);
  assert.doesNotMatch(moneyApp, /paymentHistorySection\(5\)|activitySection\(5\)/);
  assert.match(moneyApp, /Project Financials/);
  assert.match(moneyApp, /leftMetric\(term\('revenue'\)[\s\S]*leftMetric\(term\('collected'\)[\s\S]*leftMetric\(term\('remaining'\)[\s\S]*leftMetric\(term\('cost_forecast'\)[\s\S]*leftMetric\(term\('forecast_profit'\)[\s\S]*leftMetric\(term\('profit_to_date'\)/);
  assert.match(moneyApp, /tabindex="0"[\s\S]*data-mn-tip/);
  assert.match(moneyApp, /\.mn-left-metric:hover::after,.mn-left-metric:focus-visible::after/);
  assert.doesNotMatch(moneyApp, /function profitabilitySection\(|<h3>Profitability<\/h3>/);
  assert.match(moneyApp, /\.mn-left-footer\{position:sticky;bottom:0/);
  assert.equal((moneyApp.match(/Payment Schedule/g) || []).length, 1);
  assert.match(moneyApp, /mn-left-schedule-head/);
  assert.doesNotMatch(moneyApp, /mn-progress|<h3>Payment Schedule<\/h3>/);
  assert.doesNotMatch(moneyApp, /state\.notice \? `<div class="mn-alert"/);
  assert.doesNotMatch(moneyApp, /Uses the selected proposal's theme/);
  assert.match(moneyApp, /const recipient = customerEmail\(\) \|\| cleanText\(invoice\?\.customer\?\.email\)/);
  assert.match(moneyApp, /value="\$\{escapeHtml\(recipient\)\}"/);
  assert.match(moneyApp, /Portal\?\.navigation\?\.push\?\.\(\{ moneyView:next/);
  const settingsApp = await readFile(path.join(publicRoot, 'libraries/apps/settings/company.js'), 'utf8');
  assert.match(settingsApp, /id:'money'[^\n]+tabId:'csTabMoney'/);
  assert.match(settingsApp, /id:'payments', label:'Payments'/);
  assert.match(settingsApp, /branchModules\.save\(orgId, branchId, 'payment_settings'/);
});

test('project Money uses dedicated mobile Ledger and Payments routes while preserving desktop Overview', async () => {
  const manifest = await readFile(path.join(publicRoot, 'libraries/apps/firstmate-apps-manifest.js'), 'utf8');
  const moneyApp = await readFile(path.join(publicRoot, 'libraries/apps/money/project.js'), 'utf8');
  assert.match(manifest, /moneyView:\{ default:'overview', values:\[[^\]]*'ledger'/);
  assert.match(manifest, /moneyView:\{ default:'overview', values:\[[^\]]*'payments'/);
  assert.match(moneyApp, /id:'ledger', icon:'fa-book-open'/);
  assert.match(moneyApp, /function mobileLedgerView\(/);
  assert.match(moneyApp, /function mobilePaymentsView\(/);
  assert.match(moneyApp, /function normalizeMoneyView\(/);
  assert.doesNotMatch(moneyApp, /PaymentsAPI\.ledger/);
  assert.match(moneyApp, /const nextView = normalizeMoneyView\(route\.moneyView\)/);
});

test('Crew quick invites assign field access roles instead of management Viewer access', async () => {
  const settingsApp = await readFile(path.join(publicRoot, 'libraries/apps/settings/company.js'), 'utf8');
  assert.match(settingsApp, /const workforceFieldAccessRoleIdForMemberRole = \(memberRole = ''\) => \{/);
  assert.match(settingsApp, /const systemRoleId = foreman \? 'crew_foreman' : 'crew_member'/);
  assert.match(settingsApp, /const accessRoleId = workforceFieldAccessRoleIdForMemberRole\(roleValue\(\)\);[\s\S]*?const accessRoleIds = \[accessRoleId\];[\s\S]*?const applicationAccess = workforceApplicationAccessForRoleIds\(accessRoleIds\);/);
  assert.doesNotMatch(settingsApp, /const accessRoleIds = workforceDefaultAccessRoleIds\(\);[\s\S]*?applicationAccess\.field = \{/);
});

test('Crew consolidates assigned projects into the shared routed Schedule calendar', async () => {
  const manifest = await readFile(path.join(publicRoot, 'libraries/apps/firstmate-apps-manifest.js'), 'utf8');
  const crewApp = await readFile(path.join(publicRoot, 'libraries/apps/crew/app.js'), 'utf8');
  const scheduleView = await readFile(path.join(publicRoot, 'libraries/platform-schedule-view/platform-schedule-view.js'), 'utf8');
  const crewScheduleBlock = crewApp.slice(crewApp.indexOf('function mountCrewSchedule'), crewApp.indexOf('const crewAccess'));
  assert.doesNotMatch(manifest, /id: 'portal\.crew_projects'/);
  assert.doesNotMatch(crewApp, /registerPortal\(\{ id:'portal\.crew_projects'/);
  assert.match(manifest, /crew: \{ crewScheduleView:\{ default:'week', values:\['list','day','4day','week','month'\], history:'push', apps:\['portal\.crew_schedule'\] \}, crewScheduleDate:\{ history:'replace', apps:\['portal\.crew_schedule'\] \} \}/);
  assert.match(crewApp, /const crewScheduleViews = \['list','day','4day','week','month'\]/);
  assert.match(crewApp, /PlatformScheduleView\.renderProjectRangeScheduler\(mount, \{/);
  assert.match(crewApp, /touchSwipeNavigation:true/);
  assert.match(crewApp, /writeRoute\('push', \{ crewScheduleView:view/);
  assert.match(crewApp, /writeRoute\('replace', \{ crewScheduleDate:localDateKey\(anchor\) \}/);
  assert.doesNotMatch(crewScheduleBlock, /data-schedule-search|data-schedule-refresh|crewScheduleSearch|Assigned schedule|Read only|crew-head|crew-schedule-tools/);
  assert.doesNotMatch(crewApp, /appointment_schedule/);
  assert.match(scheduleView, /const renderList = \(\) => \{/);
  assert.match(scheduleView, /const touchSwipeNavigation = mode !== 'list'/);
});

test('payroll settings stay inside the routed Payroll workspace', async () => {
  const manifest = await readFile(path.join(publicRoot, 'libraries/apps/firstmate-apps-manifest.js'), 'utf8');
  const payrollApp = await readFile(path.join(publicRoot, 'libraries/apps/payroll/app.js'), 'utf8');
  const payrollSettings = await readFile(path.join(publicRoot, 'libraries/apps/settings/payroll.js'), 'utf8');
  assert.match(manifest, /payrollView:\{ default:'upcoming', values:\['upcoming','timesheets','contractors','exports','history','settings'\]/);
  assert.match(payrollApp, /navigate\(\{ tab:'payroll', payrollView:'settings', settingsView:null, settingsEntity:null \}/);
  assert.match(payrollApp, /function closeSettings\(\)\{[\s\S]*state\.view = 'upcoming';[\s\S]*navigation\?\.replace\?\.\(\{ tab:'payroll', payrollView:'upcoming', settingsView:null, settingsEntity:null \}/);
  assert.match(payrollApp, /function closeSettings\(\)\{[\s\S]*render\(\);[\s\S]*applyCurrent\?\./);
  assert.doesNotMatch(payrollApp, /backOrClose\(\['payrollView'\]/);
  assert.doesNotMatch(payrollApp, /tab:'company_settings', sub:'payroll', payrollView:null/);
  assert.match(payrollSettings, /routeTab === 'company_settings'[\s\S]*payrollView:'settings'/);
  assert.match(payrollSettings, /data-payroll-settings-back/);
  assert.match(payrollSettings, /class="pycfg-workspace"/);
  assert.match(payrollSettings, /data-select-schedule/);
  assert.match(payrollSettings, /data-add-assignment/);
  assert.match(payrollSettings, /class="pycfg-advanced"/);
  assert.match(payrollSettings, /data-assignment-search/);
  assert.match(payrollSettings, /data-assignment-type/);
  assert.match(payrollSettings, /data-select-subject/);
  assert.doesNotMatch(payrollSettings, /<select class="pycfg-select" data-new-policy-subject/);
  assert.doesNotMatch(payrollSettings, /data-pycfg-view/);
  assert.doesNotMatch(payrollSettings, /renderSummary\(/);
});

test('receipt browsers share a routed global tab and project Money subtab', async () => {
  const manifest = await readFile(path.join(publicRoot, 'libraries/apps/firstmate-apps-manifest.js'), 'utf8');
  const portalIndex = await readFile(path.join(publicRoot, 'portal/index.php'), 'utf8');
  const moneyApp = await readFile(path.join(publicRoot, 'libraries/apps/money/project.js'), 'utf8');
  const receiptsApp = await readFile(path.join(publicRoot, 'libraries/apps/receipts/app.js'), 'utf8');
  const receiptsScriptIndex = portalIndex.indexOf('../libraries/apps/receipts/app.js');
  const moneyScriptIndex = portalIndex.indexOf('../libraries/apps/money/project.js');
  assert.ok(receiptsScriptIndex >= 0, 'portal must load the receipt browser bundle');
  assert.ok(receiptsScriptIndex < moneyScriptIndex, 'portal must load the receipt browser before the Money app');
  assert.match(manifest, /id: 'portal\.receipts'/);
  assert.match(manifest, /portalTabId: 'receipts'/);
  assert.match(manifest, /moneyView:\{ default:'overview', values:\[[^\]]*'receipts'/);
  assert.match(manifest, /receipts: \{ receipt:\{ history:'push' \} \}/);
  assert.match(moneyApp, /id:'receipts', icon:'fa-file-invoice'/);
  assert.match(moneyApp, /data-money-receipts-browser/);
  assert.doesNotMatch(moneyApp, /function receiptsSection\(/);
  assert.match(receiptsApp, /Portal\.PhotoFeed\.mountProjectGallery/);
  assert.match(receiptsApp, /\.rb-browser-global\{box-sizing:border-box;padding:12px\}/);
  assert.match(receiptsApp, /root\.classList\.toggle\('rb-browser-global', scope === 'global'\)/);
  assert.match(receiptsApp, /Portal\.navigation\?\.backOrClose\?\.\(\['receipt'\]/);
  assert.match(receiptsApp, /onChange:\(nextReceipt\) => routePatch\(nextReceipt\.id, 'replace'\)/);
});

test('project Docs adapts document features into the shared media gallery', async () => {
  const docsApp = await readFile(path.join(publicRoot, 'libraries/apps/docs/project.js'), 'utf8');
  const mediaViewer = await readFile(path.join(publicRoot, 'libraries/markup/firstmate-markup.js'), 'utf8');
  const photoFeed = await readFile(path.join(publicRoot, 'libraries/apps/photos/feed.js'), 'utf8');
  const projectPhotos = await readFile(path.join(publicRoot, 'libraries/apps/photos/project.js'), 'utf8');
  const receiptsApp = await readFile(path.join(publicRoot, 'libraries/apps/receipts/app.js'), 'utf8');
  assert.match(docsApp, /Portal\.PhotoFeed\.mountProjectGallery\(gallery,/);
  assert.match(docsApp, /renderThumbnail:documentThumbnailHtml/);
  assert.match(docsApp, /renderTileMeta:documentTileMeta/);
  assert.match(docsApp, /FirstMateMarkup\?\.openMediaViewer/);
  assert.match(docsApp, /itemNoun: 'document'/);
  assert.doesNotMatch(docsApp, /function renderViewer\(/);
  assert.match(mediaViewer, /function openMediaViewer\(/);
  assert.match(mediaViewer, /data-media-frame/);
  assert.match(mediaViewer, /kind === 'pdf' \|\| kind === 'document'/);
  assert.match(mediaViewer, /data-photo-comments/);
  assert.match(docsApp, /fm-doc-requirements/);
  assert.match(docsApp, /extraDensityModes:\[\{ id:'list'/);
  assert.match(photoFeed, /options\.extraDensityModes/);
  assert.doesNotMatch(docsApp, /id:'refresh'/);
  assert.match(docsApp, /PaymentsAPI\.invoices\.list\(oid, pid\)/);
  assert.match(docsApp, /visibleDocumentCategories: new Set\(\['receipt', 'invoice', 'proposal_report', 'other'\]\)/);
  assert.match(docsApp, /data-doc-category-toggle/);
  assert.match(docsApp, /icon:'fa-sliders'/);
  assert.match(docsApp, /fm-doc-filter-option/);
  assert.match(docsApp, /fm-doc-filter-check/);
  assert.match(docsApp, /data-doc-category-action="\$\{allCategoriesShown \? 'none' : 'all'\}"/);
  assert.doesNotMatch(docsApp, /fm-doc-filter-tag/);
  assert.doesNotMatch(docsApp, /type="checkbox"[^>]*doc-category/);
  assert.match(photoFeed, /options\.includeReceipts === true \|\| !isReceiptMedia\(photo\)/);
  assert.match(projectPhotos, /filter\(\(photo\) => !isReceiptPhoto\(photo\)\)/);
  assert.match(receiptsApp, /includeReceipts:true/);
});

test('project Photos owns and closes its focused viewer when the tab deactivates', async () => {
  const projectPhotos = await readFile(path.join(publicRoot, 'libraries/apps/photos/project.js'), 'utf8');
  assert.match(projectPhotos, /activeViewer: null/);
  assert.match(projectPhotos, /if \(!state\.active\) \{[\s\S]*state\.mediaHydrationToken \+= 1;[\s\S]*clearTimeout\(state\.mediaHydrationRetryTimer\);[\s\S]*closeActiveViewer\(\);/);
  assert.match(projectPhotos, /onViewerOpen: \(viewer\) => \{\s*setActiveViewer\(viewer\);/);
  assert.match(projectPhotos, /function closeActiveViewer\(\)\{[\s\S]*viewer\?\.close\?\.\(\);/);
});

test('project Photos reconciles cold project routes with owned media inventory', async () => {
  const projectPhotos = await readFile(path.join(publicRoot, 'libraries/apps/photos/project.js'), 'utf8');
  assert.match(projectPhotos, /renderPhotoGallery\(\);\s*hydrateOwnedProjectMedia\(\);/);
  assert.match(projectPhotos, /window\.PlatformAPI\?\.media\?\.list/);
  assert.match(projectPhotos, /filter\(\(item\) => ownedMediaProjectId\(item\) === projectId(?: && isVisualMediaRecord\(item\))?\)/);
  assert.match(projectPhotos, /\[\.\.\.projectPhotosList\(\), \.\.\.owned\]\.forEach/);
  assert.match(projectPhotos, /project\.photos = photos\.map\(serializablePhoto\)/);
  assert.match(projectPhotos, /activeProjectId\(\) !== projectId/);
  assert.match(projectPhotos, /if \(state\.mediaHydrationPromise\) return state\.mediaHydrationPromise/);
  assert.match(projectPhotos, /const token = state\.mediaHydrationToken;/);
});

test('routed projects recover media stored only in the organization media inventory', async () => {
  const portalCore = await readFile(path.join(publicRoot, 'portal/scripts/core.js'), 'utf8');
  assert.match(portalCore, /function routeProjectMediaOwnerId\(/);
  assert.match(portalCore, /window\.PlatformAPI\.media\.list\(orgId\)/);
  assert.match(portalCore, /filter\(\(item\) => routeProjectMediaOwnerId\(item\) === id\)/);
  assert.doesNotMatch(portalCore, /if \(existing\.length \|\| !id/);
  assert.match(portalCore, /\[\.\.\.existing, \.\.\.owned\]\.forEach/);
  assert.match(portalCore, /const hydrated = await hydrateRouteProjectMedia\(found, id, orgId\)/);
  assert.match(portalCore, /photos\s*\n\s*\};/);
});

test('Photo Feed merges real media with generated project thumbnails', async () => {
  const photoFeed = await readFile(path.join(publicRoot, 'libraries/apps/photos/feed.js'), 'utf8');
  assert.match(photoFeed, /const mergedPhotos = \[\];/);
  assert.match(photoFeed, /\.\.\.\(Array\.isArray\(right\.photos\) \? right\.photos : \[\]\)/);
  assert.match(photoFeed, /\.\.\.\(Array\.isArray\(left\.photos\) \? left\.photos : \[\]\)/);
  assert.match(photoFeed, /merged\.photos = mergedPhotos/);
  assert.doesNotMatch(photoFeed, /\['contacts', 'photos', 'proposals', 'events'\]\.forEach\(keepArray\)/);
});

test('Feed combines media, curated activity, and opt-in documents with replace-only preferences', async () => {
  const photoFeed = await readFile(path.join(publicRoot, 'libraries/apps/photos/feed.js'), 'utf8');
  const manifest = await readFile(path.join(publicRoot, 'libraries/apps/firstmate-apps-manifest.js'), 'utf8');
  const platformApi = await readFile(path.join(publicRoot, 'libraries/platform-api/platform-api.js'), 'utf8');
  assert.match(photoFeed, /DEFAULT_MEDIA_FILTERS = \['photo', 'video'\]/);
  assert.match(photoFeed, /visibleDocuments: new Set\(\)/);
  assert.match(photoFeed, /visibleActivity: new Set\(DEFAULT_ACTIVITY_FILTERS\)/);
  assert.match(photoFeed, /function assetEventMatch\(/);
  assert.match(photoFeed, /asset\.pairedEvent = match\.event/);
  assert.match(photoFeed, /data-feed-shown/);
  assert.match(photoFeed, /\{ id: 'list', label: 'List', icon: 'list' \}/);
  assert.match(photoFeed, /navigation\?\.replace\?\.\(\{\s*feedDensity:state\.density,\s*feedShown:serializeFeedShown\(\)/);
  assert.match(manifest, /feedDensity:\{ default:'comfortable', values:\['loose','comfortable','compact','list'\], history:'replace', apps:\['portal\.photos_feed'\] \}/);
  assert.match(manifest, /feedShown:\{ history:'replace', apps:\['portal\.photos_feed'\] \}/);
  assert.match(platformApi, /activity\(orgId, options = \{\}\)\{/);
  assert.match(platformApi, /\/organizations\/\$\{enc\(orgId\)\}\/activity/);
});

test('Photo Feed hands a focused photo project to the Photos tab without clearing its route', async () => {
  const photoFeed = await readFile(path.join(publicRoot, 'libraries/apps/photos/feed.js'), 'utf8');
  const projectRequest = await readFile(path.join(publicRoot, 'libraries/apps/project-request/app.js'), 'utf8');
  assert.match(photoFeed, /openingProjectFromFeedViewer: false/);
  assert.match(photoFeed, /await openProject\(project, \{ fromFeedViewer:true \}\)/);
  assert.match(photoFeed, /routePatch: options\.fromFeedViewer \? \{ photo:null, photoScope:null \} : null/);
  assert.match(photoFeed, /!state\.closingFeedViewerFromRoute && !state\.openingProjectFromFeedViewer/);
  assert.match(projectRequest, /const routePatch = options\.routePatch && typeof options\.routePatch === 'object' \? options\.routePatch : \{\};/);
  assert.match(projectRequest, /\.\.\.routePatch,[\s\S]*photoScope: 'project'/);
});

test('markup text auto-fit remains stable across viewer resizes', async () => {
  const markup = await readFile(path.join(publicRoot, 'libraries/markup/firstmate-markup.js'), 'utf8');
  assert.match(markup, /const wrapGuardPx = Math\.max\(3, fontSize \* 0\.14\)/);
  assert.match(markup, /item\.naturalWidthPx = desiredWidthPx/);
  assert.match(markup, /Number\(item\.naturalWidthPx\) \/ rectWidth/);
  assert.match(markup, /function refreshTextBoxLayout|refreshTextBoxLayout\(\)\{/);
  assert.match(markup, /this\.markup\.refreshTextBoxLayout\?\.\(\)/);
  assert.match(markup, /item\.autoFit = false;\s*delete item\.naturalWidthPx/);
  assert.doesNotMatch(markup, /height: `\$\{Math\.max\(1, imgRect\.height\)\}px`\s*\}\);\s*this\.markup\.renderLayer\?\.\(\)/);
});

test('photo thumbnails prefer regenerated markup renditions while preserving originals', async () => {
  const markup = await readFile(path.join(publicRoot, 'libraries/markup/firstmate-markup.js'), 'utf8');
  const platformApi = await readFile(path.join(publicRoot, 'libraries/platform-api/platform-api.js'), 'utf8');
  const photoFeed = await readFile(path.join(publicRoot, 'libraries/apps/photos/feed.js'), 'utf8');
  const customerPortal = await readFile(path.join(publicRoot, 'customer_portal/customer_portal.js'), 'utf8');
  assert.match(platformApi, /markupThumbnailUrl\(orgId, mediaId, size = 320, revision = ''\)/);
  assert.match(platformApi, /`thumb_\$\{parseInt\(size, 10\) \|\| 320\}_markup`/);
  assert.match(photoFeed, /media\.markupThumbnailUrl\(orgId\(\), item\.photo\.media_id, 320/);
  assert.match(photoFeed, /fm:media-markup-saved/);
  assert.match(markup, /scheduleMarkupSave\(photo, items\)/);
  assert.match(markup, /new CustomEvent\('fm:media-markup-saved'/);
  assert.match(customerPortal, /mediaHtml[\s\S]*item\.thumb \|\| item\.src[\s\S]*loading="lazy"/);
  assert.match(customerPortal, /markedImageHtml\(item, item\.src, item\.label \|\| 'Shared media'\)/);
});

test('focused photos show immediate and persistent customer portal sharing feedback', async () => {
  const markup = await readFile(path.join(publicRoot, 'libraries/markup/firstmate-markup.js'), 'utf8');
  const photoFeed = await readFile(path.join(publicRoot, 'libraries/apps/photos/feed.js'), 'utf8');
  const projectPhotos = await readFile(path.join(publicRoot, 'libraries/apps/photos/project.js'), 'utf8');
  assert.match(markup, /data-photo-indicators/);
  assert.match(markup, /refreshIndicators\(options = \{\}\)/);
  assert.match(markup, /action\.pendingLabel/);
  assert.match(photoFeed, /indicators: Array\.isArray\(options\.viewerIndicators\) \? options\.viewerIndicators : \[\]/);
  assert.match(projectPhotos, /label: 'Shared with customer'/);
  assert.match(projectPhotos, /detail: 'Visible in Customer Portal'/);
  assert.match(projectPhotos, /pendingLabel: 'Sharing…'/);
  assert.match(projectPhotos, /viewerIndicators: portalViewerIndicators\(\)/);
  assert.match(projectPhotos, /refreshIndicators\?\.\(\{ pulseId: shared \? 'customer_portal_shared' : '' \}\)/);
});

test('commission workspaces are nested and routed through Money and Scope Templates', async () => {
  const manifest = await readFile(path.join(publicRoot, 'libraries/apps/firstmate-apps-manifest.js'), 'utf8');
  const moneyApp = await readFile(path.join(publicRoot, 'libraries/apps/money/project.js'), 'utf8');
  const commissionsApp = await readFile(path.join(publicRoot, 'libraries/apps/payroll/project.js'), 'utf8');
  const settingsApp = await readFile(path.join(publicRoot, 'libraries/apps/settings/company.js'), 'utf8');
  const terminology = await readFile(path.join(publicRoot, 'libraries/platform-terminology/platform-terminology.js'), 'utf8');
  assert.match(manifest, /moneyView:\{ default:'overview', values:\[[^\]]*'commissions'/);
  assert.match(manifest, /scopeTemplateView:\{ default:'details', values:\[[^\]]*'automations'[^\]]*'events'[^\]]*'commissions'[^\]]*\], history:'push' \}/);
  assert.doesNotMatch(manifest, /id:'project\.commissions'/);
  assert.match(moneyApp, /state\.activeView === 'commissions'/);
  assert.match(moneyApp, /FirstMateProjectCommissions/);
  assert.match(commissionsApp, /data-pc-new-title/);
  assert.match(commissionsApp, /roleKeyForTitle/);
  assert.match(commissionsApp, /setPayeeRole\(orgId, projectId, roleKey, \{ label:roleLabel, payees:\[\]/);
  assert.doesNotMatch(commissionsApp, /Upcoming payments become payable only when their listed event happens/);
  assert.match(commissionsApp, /await refreshEntries\(\)/);
  assert.match(commissionsApp, /pc-card-summary/);
  assert.match(commissionsApp, /word\('commission_payments', 'Commission Payments'\)/);
  assert.match(moneyApp, /moneyTerms:\{ \.\.\.state\.moneyTerms \}/);
  assert.match(terminology, /section\('money', 'Money', 'Project Money navigation/);
  assert.match(settingsApp, /PlatformTerminology\?\.CATALOG/);
  assert.match(commissionsApp, /Choose recipient…/);
  assert.doesNotMatch(commissionsApp, /Choose employee or subcontractor/);
  assert.match(commissionsApp, /sales_appointment_assignee/);
  assert.match(commissionsApp, /sales_appointment_scheduler/);
  assert.doesNotMatch(commissionsApp, /rolesWithDefaults|data-pc-new-key|data-pc-new-label/);
  assert.match(settingsApp, /scopeTemplateView:editorSection/);
  assert.match(settingsApp, /\['commissions','Commissions','fa-percent'\]/);
  assert.match(settingsApp, /editorSection === 'details' \? `<div id="scope-editor-panel-details"/);
  assert.match(settingsApp, /: `<div id="scope-editor-panel-commissions"/);
  assert.doesNotMatch(settingsApp, /data-scope-details \$\{editorSection === 'details' \? '' : 'hidden'\}/);
  assert.match(settingsApp, /Recipient roles & automatic assignment/);
  assert.match(settingsApp, /Person assigned to the sales appointment/);
  assert.match(settingsApp, /Person who scheduled the sales appointment/);
  assert.match(settingsApp, /Payout schedule/);
  assert.doesNotMatch(settingsApp, /payee_role:'estimators'|payee_role:String\(value\('payee_role'\) \|\| 'estimators'/);
});

test('project checklist subtabs are routed and cleared with the project workspace', async () => {
  const manifest = await readFile(path.join(publicRoot, 'libraries/apps/firstmate-apps-manifest.js'), 'utf8');
  const checklistApp = await readFile(path.join(publicRoot, 'libraries/apps/checklists/app.js'), 'utf8');
  const projectRequest = await readFile(path.join(publicRoot, 'libraries/apps/project-request/app.js'), 'utf8');
  assert.match(manifest, /checklists: \{ checklistView:\{ history:'push' \} \}/);
  assert.match(checklistApp, /registerHandler\?\.\(`project-checklists-view:/);
  assert.match(checklistApp, /navigation\?\.push\?\.\(\s*\{ checklistView:/);
  assert.match(checklistApp, /data-fmcl-view="all"/);
  assert.match(checklistApp, /fmcl-card\.detail \.fmcl-items/);
  assert.match(projectRequest, /checklistView: null/);
});

test('My Contacts owns routed inline import and settings workspaces', async () => {
  const manifest = await readFile(path.join(publicRoot, 'libraries/apps/firstmate-apps-manifest.js'), 'utf8');
  const contactsApp = await readFile(path.join(publicRoot, 'libraries/apps/contacts/app.js'), 'utf8');
  const contactsSettings = await readFile(path.join(publicRoot, 'libraries/apps/settings/contacts.js'), 'utf8');
  const portalIndex = await readFile(path.join(publicRoot, 'portal/index.php'), 'utf8');
  assert.match(manifest, /contactsWorkspace:\{ values:\['import','settings'\], history:'push' \}/);
  assert.match(manifest, /contactsSettingsView:\{ values:\['import','history'\], history:'push' \}/);
  assert.match(contactsApp, /data-ct-open-import/);
  assert.doesNotMatch(contactsApp, /data-ct-open-settings/);
  assert.match(contactsApp, /backOrClose\(\s*\['contactsWorkspace'\]/);
  assert.match(contactsApp, /registerHandler\?\.\('contacts-workspace'/);
  assert.match(contactsSettings, /routeScope === 'contacts'/);
  assert.match(portalIndex, /apps\/settings\/contacts\.js/);
});

test('feed-scoped media routes never strand the user behind project chrome', async () => {
  const photoFeed = await readFile(path.join(publicRoot, 'libraries/apps/photos/feed.js'), 'utf8');
  const portalIndex = await readFile(path.join(publicRoot, 'portal/index.php'), 'utf8');
  const core = await readFile(path.join(publicRoot, 'portal/scripts/core.js'), 'utf8');

  // The global feed viewer must not leave `project` in the URL: on reload it
  // paints project chrome the feed never dismisses.
  assert.match(photoFeed, /if \(scope === 'project'\) \{[\s\S]*?patch\.project = projectId;[\s\S]*?\} else \{[\s\S]*?patch\.project = null;/);

  // The first-paint project shell must not render for a global-scope viewer.
  assert.match(portalIndex, /photoScope[\s\S]*?=== 'feed'\)\s*\{\s*\$initialProjectRoute = '';/);

  // And it must always be escapable, whatever happens after first paint.
  assert.match(portalIndex, /Safety net for the first-paint project shell/);
  assert.match(portalIndex, /getElementById\('fmProjectRoutePrecover'\)/);
  assert.match(portalIndex, /event\.key === 'Escape'/);
  assert.match(portalIndex, /if \(event\.target === cover\) dismiss\(\)/);
  assert.match(portalIndex, /Date\.now\(\) - started > 15000/);

  // An unregistered tab is a portal tab, not a project tab, for feed routes.
  assert.match(core, /const globalScopeRoute = String\(currentRoute\.photoScope \|\| ''\)\.toLowerCase\(\) === 'feed'/);
  assert.match(core, /!currentRoute\.projectTab && !globalScopeRoute/);
});

test('media items can be renamed from the viewer action menu', async () => {
  const markup = await readFile(path.join(publicRoot, 'libraries/markup/firstmate-markup.js'), 'utf8');
  const platformApi = await readFile(path.join(publicRoot, 'libraries/platform-api/platform-api.js'), 'utf8');
  const photoFeed = await readFile(path.join(publicRoot, 'libraries/apps/photos/feed.js'), 'utf8');
  const projectPhotos = await readFile(path.join(publicRoot, 'libraries/apps/photos/project.js'), 'utf8');
  assert.match(platformApi, /rename\(orgId, mediaId, name\)/);
  assert.match(markup, /data-photo-rename/);
  assert.match(markup, /async renameCurrent\(\)/);
  assert.match(markup, /PlatformAPI\.media\.rename\(orgId\(\), mediaId, name\)/);
  assert.match(markup, /new CustomEvent\('fm:media-renamed'/);
  // Items without a stored media record cannot be renamed.
  assert.match(markup, /renameButton\.hidden = !cleanText\(photo\.media_id\)/);
  assert.match(markup, /\.fm-photo-actions-menu button\[hidden\]\{display:none!important\}/);
  // Both galleries reflect the new name without a reload.
  assert.match(photoFeed, /fm:media-renamed/);
  assert.match(projectPhotos, /fm:media-renamed/);
});

test('Web Editor owns the routed Domains and Hosting workspace', async () => {
  const manifest = await readFile(path.join(publicRoot, 'libraries/apps/firstmate-apps-manifest.js'), 'utf8');
  const webEditor = await readFile(path.join(publicRoot, 'libraries/apps/web-editor/app.js'), 'utf8');
  assert.match(manifest, /domainSettings:\{ values:\['domains'\], history:'push' \}/);
  assert.match(webEditor, /function gotoDomains\(\)/);
  assert.match(webEditor, /domainSettings: 'domains'/);
  assert.match(webEditor, /FirstMateDomainsSettings\.mount\(\{/);
  assert.match(webEditor, /data-we-back[\s\S]*gotoSites/);
  assert.doesNotMatch(webEditor, /web-editor-register-domain/);
});

test('field approval bundles load before project-tab discovery on sales and crew surfaces', async () => {
  const manifest = await readFile(path.join(publicRoot, 'libraries/apps/firstmate-apps-manifest.js'), 'utf8');
  const signaturesApp = await readFile(path.join(publicRoot, 'libraries/apps/signatures/project.js'), 'utf8');
  const portalIndex = await readFile(path.join(publicRoot, 'portal/index.php'), 'utf8');
  assert.match(manifest, /const fieldApprovalBundles = \[[\s\S]*?signatures\/project\.js/);
  assert.match(manifest, /const crewBundles = \[[\s\S]*?\.\.\.fieldApprovalBundles/);
  assert.match(manifest, /const salesBundles = \[[\s\S]*?\.\.\.fieldApprovalBundles/);
  assert.match(manifest, /id: 'project\.crew_signatures'[\s\S]*?devices: \['mobile', 'desktop'\]/);
  assert.match(manifest, /id: 'project\.crew_signatures'[\s\S]*?visible: true/);
  assert.match(signaturesApp, /devices:\['mobile','desktop'\]/);
  assert.match(signaturesApp, /id:'project\.crew_signatures'[\s\S]*?visible:true/);
  assert.match(signaturesApp, /showWorkflowTitle: false/);
  assert.match(signaturesApp, /\.fm-field-signatures\.is-workflow\{width:100%;max-width:100%;min-width:0;padding:0;overflow:hidden;display:flex;flex-direction:column\}/);
  assert.match(signaturesApp, /\.fm-field-workflow\{flex:1;width:100%;max-width:100%;min-width:0;min-height:0;overflow:hidden;display:flex\}/);
  assert.match(manifest, /fieldApprovalBundles/);
  assert.match(portalIndex, /doc-workflow\/firstmate-doc-workflow\.js[\s\S]*?apps\/signatures\/project\.js/);
});
