import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// GP-113: an app's sub-tabs are declared once (an app group's members, or AppChrome.registerSubtabs) and the Apps
// menu lists them under the app for a person to open or pin (left-column-pins.js reads AppChrome.subtabs).
const read = (path) => readFileSync(new URL(`../public/libraries/${path}`, import.meta.url), 'utf8');
const chromeSource = read('app-runtime/app-chrome.js');

function loadAppChrome(){
  const apps = new Map([['portal.financials', { id:'portal.financials', order:52, visible:true }]]);
  const node = () => ({ style:{}, set textContent(_){}, appendChild(){}, querySelectorAll:() => [] });
  const window = {
    FirstMateEmbeddableApps:{
      escapeHtml:(value) => String(value ?? ''),
      getApp:(id) => apps.get(id) || null,
      registerApp:(app) => apps.set(app.id, app),
      evaluateAccess:() => ({ allowed:true })
    },
    addEventListener(){},
    matchMedia:() => ({ matches:false, addEventListener(){} })
  };
  const document = { createElement:node, head:node(), addEventListener(){}, querySelectorAll:() => [] };
  vm.runInNewContext(chromeSource, { window, document, customElements:undefined, requestAnimationFrame:() => 0, ResizeObserver:undefined });
  return window.AppChrome;
}

test('an app group with a routeParam lists its members as its parent app sub-tabs', () => {
  const chrome = loadAppChrome();
  let disputes = false;
  chrome.registerGroup({ id:'financials', parent:'portal.financials', routeParam:'financialView', icon:'fa-chart-line', default:'projects',
    members:[{ id:'projects', title:'Profitability', icon:'fa-chart-line' }, { id:'receipts', title:'Receipts' },
      { id:'disputes', title:'Disputes', icon:'fa-scale-balanced', available:() => disputes },
      { id:'hidden', title:'Hidden', defaultPlacement:'standalone' }],
    mount(){} });
  assert.deepEqual(JSON.parse(JSON.stringify(chrome.subtabs('portal.financials'))), [
    { id:'projects', label:'Profitability', icon:'fa-chart-line', route:{ financialView:'projects' } },
    { id:'receipts', label:'Receipts', icon:'fa-chart-line', route:{ financialView:'receipts' } }
  ], 'a member that is unavailable or not in the group is not offered; a member without an icon takes the group icon');
  disputes = true;
  assert.deepEqual([...chrome.subtabs('portal.financials').map((item) => item.id)], ['projects', 'receipts', 'disputes'], 'read when asked, so availability is current');
  assert.equal(chrome.subtabs('portal.unknown').length, 0);
});

test('an app with its own view strip declares its sub-tabs with registerSubtabs', () => {
  const chrome = loadAppChrome();
  chrome.registerSubtabs('portal.chat.center', { param:'centerMode', icon:'fa-headset', items:() => [{ id:'personal', title:'Personal', icon:'fa-user' }, { id:'call', title:'Call center' }] });
  assert.deepEqual(JSON.parse(JSON.stringify(chrome.subtabs('portal.chat.center'))), [
    { id:'personal', label:'Personal', icon:'fa-user', route:{ centerMode:'personal' } },
    { id:'call', label:'Call center', icon:'fa-headset', route:{ centerMode:'call' } }
  ]);
  assert.throws(() => chrome.registerSubtabs('portal.x', { items:[] }), /route param/);
});

test('Financials, Communications, Payroll and the Call Center declare their sub-tabs', () => {
  assert.match(read('apps/financials/app.js'), /registerGroup\(\{id:'financials',parent:'portal\.financials',routeParam:'financialView',/);
  assert.match(read('apps/chat/app.js'), /registerGroup\(\{id:'communications',parent:'portal\.chat',routeParam:'communicationsView',/);
  assert.match(read('apps/payroll/app.js'), /registerGroup\(\{ id:'payroll', parent:'portal\.payroll', routeParam:'payrollView',/);
  const workspace = read('apps/comms/workspace.js');
  assert.match(workspace, /registerSubtabs\?\.\('portal\.chat\.center',\{param:'centerMode'/);
  assert.match(workspace, /route\.tab==='chat\.center'&&CENTER_MODES\.includes\(route\.centerMode\)/, 'a pinned Call Center view switches the open Call Center');
});

test('the left-column pins read an app\'s sub-tabs after its manifest subviews', () => {
  const pins = read('left-column-pins/left-column-pins.js');
  assert.match(pins, /root\.AppChrome\?\.subtabs\?\.\(id\)/);
  assert.match(pins, /const declared = \[\.\.\.listed, \.\.\.subtabs\.filter/);
});
