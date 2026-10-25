// The completion widget's three methods, the work order Pay out modal and the project closeout workflow, in Chrome.
// The Project tab pieces are the real functions from project.js on a page with fixture data; the widgets are the
// real platform widget runtime with the catalog; the platform API is a recording fixture.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const libraries = fileURLToPath(new URL('../../libraries/', import.meta.url));
const shots = fileURLToPath(new URL('../../../output/closeout-ui/', import.meta.url));
await mkdir(shots, {recursive:true});
const source = await readFile(new URL('../../libraries/apps/materials/project.js', import.meta.url), 'utf8');
function fn(name) {
  const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name); return source.slice(start, source.indexOf('\n  }', start) + 4);
}
const PROJECT_FUNCTIONS = ['css','laborLinePaidAt','renderPaidLineRow','renderMaterialSections','renderLaborListControls','renderListHeaderActions','laborSettings','laborCompletions','laborListFinalized','closeoutButton','materialsSettingsButton','renderRequirementRow','requirementTooltip','requirementWhy','renderRequirementsTray','requirementAmount','requirementKind','renderResourceHeader','scheduleJobButton'].map(fn).join('\n')
  + '\n' + source.match(/  const REQUIREMENT_STATUS = .*\r?\n/)[0];
const photo = (hue) => `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,62%)"/><stop offset="1" stop-color="hsl(${hue + 40},40%,32%)"/></linearGradient></defs><rect width="640" height="480" fill="url(#g)"/><path d="M0 330 L200 180 L330 270 L470 150 L640 300 L640 480 L0 480Z" fill="rgba(255,255,255,.22)"/></svg>`;
const page = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css"><style>body{margin:0;font-family:Inter,system-ui,sans-serif;background:#f7f8fb}</style></head><body><div id="root"></div></body></html>`;

function serve() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    try {
      if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(page); return; }
      if (url.pathname.startsWith('/media/')) { res.setHeader('Content-Type', 'image/svg+xml'); res.end(photo(Number(url.pathname.match(/(\d+)/)?.[1] || 1) * 47 % 360)); return; }
      if (url.pathname.startsWith('/libraries/')) {
        const file = path.join(libraries, decodeURIComponent(url.pathname.slice('/libraries/'.length)));
        if (!file.startsWith(libraries)) throw Error('outside');
        res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : file.endsWith('.css') ? 'text/css' : 'text/javascript');
        res.end(await readFile(file)); return;
      }
      res.statusCode = 404; res.end('');
    } catch { res.statusCode = 404; res.end(''); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Fixture data: one project with two work orders, an equipment list and a material list. */
const FIXTURE = {
  lists: [
    {id:'m1',title:'Shingles & underlayment',resource_type:'material',status:'ordered',current_items:[{id:'m1a',name:'Architectural shingles',quantity:96,unit:'bundle',projected_total:3744},{id:'m1b',name:'Synthetic underlayment',quantity:8,unit:'roll',projected_total:760}]},
    {id:'l1',title:'Summit Roofing',resource_type:'labor',revision:3,assignment:{work_resource_ref:{id:'summit',kind:'organization_connection',name:'Summit Roofing'}},current_items:[{id:'l1a',name:'Tear off',quantity:32,unit:'sq',projected_unit_price:40,projected_total:1280,section:'labor'},{id:'l1b',name:'Install shingles',quantity:32,unit:'sq',projected_unit_price:95,projected_total:3040,section:'labor'},{id:'l1c',name:'Ridge cap',quantity:120,unit:'ft',projected_unit_price:1.5,projected_total:180,section:'labor'}]},
    {id:'l2',title:'Crew A',resource_type:'labor',revision:1,assignment:{work_resource_ref:{id:'crew_a',kind:'resource_group',name:'Crew A'}},current_items:[{id:'l2a',name:'Seamless gutters',quantity:140,unit:'ft',projected_unit_price:6,projected_total:840,section:'labor'},{id:'l2b',name:'Downspouts',quantity:4,unit:'each',projected_unit_price:45,projected_total:180,section:'labor'}]},
    {id:'e1',title:'Dumpster',resource_type:'equipment',current_items:[{id:'e1a',name:'20 yard dumpster',quantity:1,unit:'day',projected_total:450,section:'equipment'}]}
  ],
  requirements: {status:'covered',counts:{open:1,warning:1,covered:5,scheduled:1,completed:2},line_warnings:[],manual_work:[],available:[],requirements:[
    {id:'material:shingles',kind:'material',label:'Architectural shingles',unit:'bundle',quantity:96,status:'covered',progress:'completed',covered_by:[{list_id:'m1',list_title:'Shingles & underlayment',mode:'paid',lines:[],scheduled:true,completed:true}],warnings:[],sources:[]},
    {id:'roofing.tear_off',kind:'work',label:'Tear off',unit:'roofing_square',quantity:32,status:'covered',progress:'completed',covered_by:[{list_id:'l1',list_title:'Summit Roofing',assignee_name:'Summit Roofing',mode:'paid',lines:[],scheduled:true,completed:true}],warnings:[],sources:[]},
    {id:'roofing.install',kind:'work',label:'Install',unit:'roofing_square',quantity:32,status:'covered',progress:'scheduled',covered_by:[{list_id:'l1',list_title:'Summit Roofing',assignee_name:'Summit Roofing',mode:'paid',lines:[],scheduled:true,completed:false}],warnings:[],sources:[]},
    {id:'roofing.ridge_cap',kind:'work',label:'Ridge cap',unit:'ft',quantity:120,status:'covered',progress:'none',covered_by:[{list_id:'l1',list_title:'Summit Roofing',assignee_name:'Summit Roofing',mode:'paid',lines:[]}],warnings:[],sources:[]},
    {id:'gutters.install',kind:'work',label:'Gutters',unit:'ft',quantity:140,status:'covered',progress:'none',covered_by:[{list_id:'l2',list_title:'Crew A',assignee_name:'Crew A',mode:'paid',lines:[]}],warnings:[],sources:[]},
    {id:'disposal.debris',kind:'function',label:'Debris disposal',unit:'yd3',quantity:24,status:'warning',progress:'none',covered_by:[{list_id:'e1',list_title:'Dumpster',mode:'provided',lines:[]}],warnings:[{code:'short',message:'What is on the work order holds 20 cubic yards of the 24 needed.'}],sources:[]},
    {id:'roofing.cleanup',kind:'work',label:'Cleanup',unit:'job',quantity:1,status:'open',progress:'none',covered_by:[],warnings:[],sources:[]}
  ]},
  photos: Array.from({length:7}, (_, i) => ({id:`ph${i + 1}`,content_type:'image/jpeg',file_name:`roof-${i + 1}.jpg`,created_at:'2026-10-1'+i,project_id:'p1',label:['Front slope','Ridge','Valley','Gutters','Back slope','Flashing','Cleanup'][i]}))
};
const STEPS = [
  {id:'change_orders',title:'Change orders',status:'warning',summary:'1 change order not signed.',rows:[{id:'co1',label:'Change order 1 – decking',detail:'Signed · $640.00',status:'ok'},{id:'co2',label:'Change order 2 – skylight',detail:'Not signed (sent) · $1,150.00',status:'warning'}],sources:['widget-objects.document-directory'],missing:['Whether each change order is paid: payments.records does not say which payment belongs to which change order.']},
  {id:'signatures',title:'Signatures',status:'ok',summary:'Every sent document is signed.',rows:[{id:'d1',label:'Roof replacement contract',detail:'Signed · $14,820.00',status:'ok'}],sources:['widget-objects.document-directory'],missing:['Which documents require a signature is not published. Documents that were sent and are not signed yet are treated as waiting for one.']},
  {id:'payments',title:'Payments received',status:'warning',summary:'1 payment due and not received ($4,446.00).',rows:[{id:'p1',label:'Deposit',detail:'Received',status:'ok'},{id:'p2',label:'Final payment',detail:'$4,446.00 outstanding, due 2026-10-10',status:'warning'}],sources:['payments.records'],missing:[]},
  {id:'requirements',title:'Scope accounted for',status:'warning',summary:'1 not accounted for, 1 to check',rows:[{id:'r1',label:'Tear off',detail:'Completed',status:'ok'},{id:'r2',label:'Debris disposal',detail:'What is on the work order holds 20 cubic yards of the 24 needed.',status:'warning'},{id:'r3',label:'Cleanup',detail:'Not accounted for',status:'warning'}],sources:['work-requirements.project'],missing:[]},
  {id:'receipts',title:'Receipts',status:'warning',summary:'1 paid expense with no receipt',rows:[{id:'m1',label:'Shingles & underlayment',detail:'No receipt uploaded',status:'warning'},{id:'e1',label:'Dumpster',detail:'1 receipt uploaded',status:'ok'}],sources:['receipts.record'],missing:['Other paid expenses (supplemental expense items and payables) are not published, so only material and equipment lists are checked for a receipt.']},
  {id:'work_orders',title:'Finalize work orders',status:'warning',summary:'2 work orders to confirm and finalize.',rows:[{id:'l1',label:'Summit Roofing',detail:'Not finalized',status:'warning'},{id:'l2',label:'Crew A',detail:'Not finalized',status:'warning'}],sources:[],missing:[]},
  {id:'expenses',title:'Final expenses',status:'warning',summary:'2 work orders not finalized, so their costs are not actual yet',rows:[{id:'expenses',label:'Expenses: actual vs planned',detail:'$4,954.00 of $10,474.00 planned',status:'info'},{id:'m1',label:'Materials: Shingles & underlayment',detail:'$4,504.00 paid of $4,504.00 planned',status:'info'},{id:'l1',label:'Labor: Summit Roofing',detail:'$4,500.00 planned · not finalized, so not actual yet',status:'warning'}],sources:['financials.records','labor-completion.project'],missing:[]}
];
const itemsFor = (listId) => FIXTURE.lists.filter((list) => list.resource_type === 'labor' && (!listId || list.id === listId)).flatMap((list) => list.current_items.map((item) => ({id:item.id,kind:'line',list_id:list.id,list_title:list.assignment.work_resource_ref.name,label:item.name,detail:`${item.quantity} ${item.unit} · $${item.projected_total.toFixed(2)}`,total_cents:Math.round(item.projected_total * 100),done:false})));

async function open(browser) {
  const tab = await browser.newPage({viewport:{width:1440,height:900}});
  const errors = []; tab.on('pageerror', (error) => errors.push(error.message));
  await tab.goto(`http://127.0.0.1:${serverPort}/`);
  await tab.evaluate(({fixture, steps, items}) => {
    window.__APP = {userOrgId:'org'}; window.calls = []; window.fixture = fixture; window.completions = []; window.closeoutRecord = null;
    window.PlatformAPI = {
      media:{fileUrl:(org, id, variant) => `/media/${id}-${variant}.svg`},
      publication:{
        read: async (org, source) => {
          if (source.provider === 'labor-completion' && source.export === 'items') return {status:'ready',value:{project_id:'p1',list_id:source.args?.list_id || '',items:items.filter((item) => !source.args?.list_id || item.list_id === source.args.list_id).map((item) => (window.paidLines?.[item.id] ? {...item, done:true, paid_at:window.paidLines[item.id]} : item))}};
          if (source.provider === 'labor-completion' && source.export === 'settings') return window.completionMethod ? {status:'ready',value:window.completionMethod} : {status:'denied',message:'No access'};
          if (source.provider === 'labor-completion') return {status:'ready',value:window.completions};
          if (source.provider === 'media') return {status:'ready',value:{items:fixture.photos,truncated:false}};
          if (source.provider === 'project-closeout') return {status:'ready',value:{project_id:'p1',steps,closeout:window.closeoutRecord,open_work_orders:window.closeoutRecord ? [] : ['l1','l2'].filter((id) => !window.finalizedIds?.includes(id))}};
          return {status:'missing',message:'No fixture'};
        },
        invoke: async (org, action, target, input) => { window.calls.push({action, target, input}); if (action === 'labor-completion.settings.save') { window.completionMethod = {method:input.method, revision:(window.completionMethod?.revision || 0) + 1}; return {value:window.completionMethod}; } if (action === 'labor.list.finalize' && input.partial) { const list = window.fixture.lists.find((entry) => entry.id === input.list_id); window.paidLines = {...(window.paidLines || {}), ...Object.fromEntries(input.confirmed_item_ids.map((id) => [id, '2026-10-14T15:00:00Z']))}; window.completions = [...window.completions, {id:`lp_${input.list_id}`, list_id:input.list_id, state:'finalized', list_paid:'part', line_ids:input.confirmed_item_ids, finalized_at:'2026-10-14T15:00:00Z', total_cents:list.current_items.filter((item) => input.confirmed_item_ids.includes(item.id)).reduce((sum, item) => sum + Math.round(item.projected_total * 100), 0)}]; return {value:{ok:true}}; } if (action === 'labor.list.cancel-remaining') { window.finalizedIds = [...(window.finalizedIds || []), input.list_id]; return {value:{ok:true}}; } if (action === 'labor.list.finalize') window.finalizedIds = [...(window.finalizedIds || []), input.list_id]; return {value:{ok:true}}; }
      }
    };
  }, {fixture:FIXTURE, steps:STEPS, items:itemsFor('')});
  await tab.addScriptTag({url:'/libraries/platform-widgets/runtime.js'});
  await tab.evaluate(() => window.FirstMateWidgets.ready);
  return {tab, errors};
}
let serverPort = 0;

test('the completion widget has three methods: one approval, Select all, or each item checked', async () => {
  const server = await serve(); serverPort = server.address().port;
  const browser = await chromium.launch({channel:'chrome', headless:true});
  try {
    const {tab, errors} = await open(browser);
    await tab.addScriptTag({url:'/libraries/platform-widgets/completion-widgets.js'});
    await tab.evaluate(async (items) => {
      document.getElementById('root').innerHTML = '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:20px;align-items:start">' + ['approve','select_all','each'].map((method) => `<section style="background:#fff;border:1px solid #eaecf0;border-radius:12px;padding:12px"><h4 style="margin:0 0 10px;font-size:11px;color:#667085;text-transform:uppercase;letter-spacing:.05em">${method}</h4><div id="w-${method}"></div></section>`).join('') + '</div>';
      window.picked = {};
      const target = {scope:'project', organizationId:'org', projectId:'p1'};
      window.handles = {};
      for (const method of ['approve','select_all','each']) window.handles[method] = window.FirstMateWidgets.mount(document.getElementById('w-' + method), {id:'work.completion', version:'1', target, config:{method}}, {surface:'project', target, data:{'work.completion':{items}}, onSelect:(value) => { window.picked[method] = value; }});
      await Promise.all(Object.values(window.handles).map((handle) => handle.ready));
    }, itemsFor('l1'));
    const picked = (method) => tab.evaluate((m) => window.picked[m], method);
    // Approve: no checkboxes, one button.
    assert.equal(await tab.locator('#w-approve input[type=checkbox]').count(), 0);
    assert.equal((await picked('approve')).complete, false);
    // Select all (the default): checkboxes and a Select all button.
    assert.equal(await tab.locator('#w-select_all input[type=checkbox]').count(), 3);
    assert.equal(await tab.locator('#w-select_all [data-fmc-all]').count(), 1);
    // Each: checkboxes, no Select all.
    assert.equal(await tab.locator('#w-each input[type=checkbox]').count(), 3);
    assert.equal(await tab.locator('#w-each [data-fmc-all]').count(), 0);
    await tab.screenshot({path:path.join(shots, 'completion-widget-modes-empty.png')});

    await tab.locator('#w-approve [data-fmc-approve]').click();
    assert.deepEqual(await picked('approve'), {method:'approve', complete:true, approved:true, confirmed_item_ids:['l1a','l1b','l1c'], confirmed_material_ids:[], confirmed_requirement_ids:[]});
    await tab.locator('#w-select_all [data-fmc-all]').click();
    assert.equal((await picked('select_all')).complete, true); assert.deepEqual((await picked('select_all')).confirmed_item_ids, ['l1a','l1b','l1c']);
    await tab.locator('#w-each input[type=checkbox]').nth(0).check(); await tab.locator('#w-each input[type=checkbox]').nth(2).check();
    assert.equal((await picked('each')).complete, false, 'each item must be checked on its own');
    assert.deepEqual((await picked('each')).confirmed_item_ids, ['l1a','l1c']);
    await tab.screenshot({path:path.join(shots, 'completion-widget-modes.png')});
    await tab.locator('#w-each input[type=checkbox]').nth(1).check();
    assert.equal((await picked('each')).complete, true);
    // Unchecking one takes the confirmation back.
    await tab.locator('#w-select_all input[type=checkbox]').nth(1).uncheck();
    assert.equal((await picked('select_all')).complete, false); assert.equal(await tab.locator('#w-select_all [data-fmc-status]').innerText(), '2 of 3 confirmed');
    // The selection a host reads matches what the widget reported.
    assert.deepEqual(await tab.evaluate(() => window.handles.each.selection().confirmed_item_ids), ['l1a','l1b','l1c']);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
});

async function projectTab(tab) {
  await tab.evaluate(async ({functions}) => {
    const s = window.fixture;
    window.state = {lists:s.lists, crews:[], resourceTypes:[{id:'material',name:'Materials',icon:'fa-boxes-stacked',color:'#2e90fa'},{id:'labor',name:'Labor',icon:'fa-helmet-safety',color:'#f79009'},{id:'equipment',name:'Equipment',icon:'fa-truck-pickup',color:'#7a5af8'}], visibleListIds:new Set(s.lists.map((list) => list.id)), collapsedListIds:new Set(), expandedRequirementIds:new Set(['roofing.tear_off']), requirementsOpen:true, project:{title:'12 Oak St'}, panelRoot:document.getElementById('root'), saving:false};
    Object.assign(window, {
      cleanText:(value) => String(value ?? '').trim(), escapeHtml:(value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
      number:(value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback, money:(value) => '$' + Number(value || 0).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}),
      orgId:() => 'org', projectId:() => 'p1', apiReady:() => true, workspaceIsEditing:() => false,
      resourceCategories:() => state.resourceTypes, workOrderMerged:() => true, equipmentOn:() => true, laborAssignmentOn:() => true, equipmentListRetired:() => false, resourceType:(list) => list?.resource_type || 'material', materialListById:(id) => state.lists.find((list) => list.id === id),
      resourceTerms:(type) => ({plural:{material:'Materials',labor:'Labor',equipment:'Equipment'}[type], singular:{material:'Material',labor:'Labor item',equipment:'Equipment item'}[type]}),
      listItems:(list) => list?.current_items || [], assignmentWorkResourceRef:(list) => list?.assignment?.work_resource_ref || null, workResourcesForScopeList:() => [], workResourceById:() => null,
      filteredItems:() => state.lists.flatMap((list) => list.current_items.map((item) => ({...item, section:item.section || 'material', __material_list_id:list.id}))),
      materialSectionDefinitions:() => [{key:'material',resource_type:'material'},{key:'labor',resource_type:'labor'},{key:'equipment',resource_type:'equipment'}], lineSectionKey:(item) => item.section,
      renderMaterialSection:(section, rows) => `<section class="mt-section" style="padding:2px 4px">${rows.map((row) => typeof laborLinePaidAt === 'function' && laborLinePaidAt(row.__material_list_id, row.id) ? `<table class="mt-table mt-paid-table" style="width:100%;border-collapse:collapse"><tbody>${renderPaidLineRow(row, laborLinePaidAt(row.__material_list_id, row.id))}</tbody></table>` : `<div style="display:grid;grid-template-columns:minmax(0,1fr) 58px 72px;gap:6px;align-items:center;padding:5px 6px;border-bottom:1px solid #f0f2f5;font-size:12px"><input value="${row.name}" style="border:0;background:transparent;font:inherit;min-width:0"><input value="${row.quantity} ${row.unit}" style="border:0;background:transparent;font:inherit;text-align:right"><strong style="text-align:right;font-variant-numeric:tabular-nums">$${Number(row.projected_total).toFixed(2)}</strong></div>`).join('')}</section>`,
      renderAssignBlock:() => '', renderListActionControls:() => '', resourceScheduleEnabled:() => false, workOrderActions:() => [], minimizeIdleWorkOrder:() => false, schedulingOn:() => true, materialListOrdered:(list) => list?.status === 'ordered', listProjected:(list) => list.current_items.reduce((sum, item) => sum + item.projected_total, 0), categoryProjected:(type, lists) => lists.reduce((sum, list) => sum + list.current_items.reduce((total, item) => total + item.projected_total, 0), 0), projectProjected:() => 10474, projectedDelivery:() => ({available:false}),
      requirementSet:() => ({data:window.fixture.requirements}), loadRequirements:() => Promise.resolve(null), requirementsOpen:() => true, syncMaterialsGrid:() => window.draw(), syncResourceHeader:() => window.draw(),
      headerDone:() => ({}), jobSchedule:() => ({done:false}), showToast:(title, body) => { window.toasts = [...(window.toasts || []), title]; }
    });
    (0, eval)(functions);
    const style = document.createElement('style'); style.textContent = css() + '.r-tab-content{display:flex;height:820px;width:1400px;margin:10px}.r-tab-main{flex:1;min-width:0}.mt-app{height:100%}';
    document.head.append(style);
    window.draw = () => { document.getElementById('root').innerHTML = `<div class="r-overlay materials-workspace"><div class="r-tab-content"><div class="r-tab-main"><div class="mt-app">${renderResourceHeader()}<div class="mt-material-grid" data-mt-material-grid>${renderMaterialSections()}</div></div></div></div></div>`; };
    window.draw();
    const module = await import('/libraries/apps/materials/closeout.js');
    window.closeout = module;
    window.host = () => ({orgId:'org', projectId:'p1', projectTitle:'12 Oak St', portal:document.body, lists:() => state.lists, listItems:(list) => list.current_items, completions:() => window.completions, toast:(title) => { window.toasts = [...(window.toasts || []), title]; }, refresh:async () => { state.laborCompletions = null; window.draw(); }});
    document.getElementById('root').addEventListener('click', (event) => { const more = event.target.closest('[data-mt-labor-more]'), close = event.target.closest('[data-mt-closeout]'); if (more) module.openListMenu(window.host(), more.dataset.mtLaborMore, more); if (close) module.openCloseout(window.host()); });
  }, {functions:PROJECT_FUNCTIONS});
}

test('Pay out: the More menu opens the completion widget beside the photos, and confirming finalizes and locks the list', async () => {
  const server = await serve(); serverPort = server.address().port;
  const browser = await chromium.launch({channel:'chrome', headless:true});
  try {
    const {tab, errors} = await open(browser);
    await projectTab(tab);
    // Every work order has a More button at the top of its list, not a gear; the Project tab has a Closeout button.
    assert.equal(await tab.locator('[data-mt-pane-list="l1"] .mt-list-head [data-mt-labor-more]').count(), 1);
    assert.equal(await tab.locator('[data-mt-pane-list="l2"] .mt-list-head [data-mt-labor-more]').count(), 1);
    assert.equal(await tab.locator('[data-mt-pane-list="m1"] [data-mt-labor-more]').count(), 0);
    assert.equal(await tab.locator('.mt-workspace-header [data-mt-closeout]').count(), 1);
    // The tray: completed rows are green with a check, scheduled ones show a calendar.
    assert.equal(await tab.locator('[data-mt-req-row="roofing.tear_off"]').getAttribute('class'), 'mt-req-row is-covered is-completed is-expanded');
    assert.equal(await tab.locator('[data-mt-req-row="roofing.install"] .mt-req-dot').evaluate((node) => node.classList.contains('fa-calendar-check')), true);
    assert.equal(await tab.locator('[data-mt-req-row="roofing.ridge_cap"] .mt-req-dot').evaluate((node) => node.classList.contains('fa-circle-check')), true);
    assert.equal(await tab.locator('[data-mt-req-row="roofing.tear_off"]').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(236, 253, 243)');
    await tab.screenshot({path:path.join(shots, 'project-tab-work-orders.png')});

    await tab.locator('[data-mt-pane-list="l1"] [data-mt-labor-more]').click();
    await tab.getByRole('menuitem', {name:'Pay out'}).waitFor();
    await tab.screenshot({path:path.join(shots, 'work-order-more-menu.png'), clip:{x:700, y:0, width:740, height:360}});
    await tab.getByRole('menuitem', {name:'Pay out'}).click();
    const dialog = tab.locator('dialog.fmco-dialog');
    await dialog.locator('[data-fmc-row]').first().waitFor();
    await dialog.locator('.fmp-tile').first().waitFor();
    const confirm = dialog.locator('[data-fmco-confirm]');
    assert.equal(await confirm.isDisabled(), true, 'nothing is confirmed yet');
    assert.equal(await dialog.locator('[data-fmc-all]').count(), 1, 'Pay out uses the default method: checkboxes with Select all');
    await tab.screenshot({path:path.join(shots, 'pay-out-modal.png')});
    await dialog.locator('[data-fmc-all]').click();
    // Open two photos: each opened photo is recorded as reviewed.
    await dialog.locator('.fmp-tile').nth(0).click(); await tab.locator('.fmp-view').waitFor();
    await tab.screenshot({path:path.join(shots, 'pay-out-photo-view.png')});
    await tab.keyboard.press('Escape'); assert.equal(await tab.locator('.fmp-view').count(), 0); assert.equal(await dialog.count(), 1, 'Escape closes the photo, not the modal');
    await dialog.locator('.fmp-tile').nth(2).click(); await tab.locator('.fmp-view [data-fmp-close]').click();
    await dialog.locator('[data-fmco-note]').fill('Walked the roof with the owner');
    assert.equal(await confirm.isDisabled(), false);
    await tab.screenshot({path:path.join(shots, 'pay-out-modal-confirmed.png')});
    await confirm.click();
    await dialog.waitFor({state:'detached'});
    const calls = await tab.evaluate(() => window.calls);
    assert.equal(calls.length, 1); assert.equal(calls[0].action, 'labor.list.finalize');
    assert.deepEqual(calls[0].target, {scope:'project', organizationId:'org', projectId:'p1'});
    assert.deepEqual(calls[0].input, {list_id:'l1', method:'select_all', confirmed_item_ids:['l1a','l1b','l1c'], evidence_media_ids:['ph1','ph3'], note:'Walked the roof with the owner'});

    // Finalized: the list is locked and says so; its More menu shows when and offers Reopen.
    await tab.evaluate(() => { window.completions = [{id:'lf_1', list_id:'l1', state:'finalized', finalized_at:'2026-10-14T15:00:00Z', total_cents:450000}]; state.laborCompletions = null; window.draw(); });
    await tab.locator('[data-mt-pane-list="l1"].is-finalized').waitFor();
    assert.equal(await tab.locator('[data-mt-pane-list="l1"] .mt-paid-pill').innerText(), 'Summit Roofing · To be paid');
    assert.equal(await tab.locator('[data-mt-pane-list="l1"] [data-mt-labor-generate]').count(), 0, 'a locked list cannot be generated again');
    assert.equal(await tab.locator('[data-mt-pane-list="l1"] [data-mt-delete-list]').isDisabled(), true);
    assert.equal(await tab.locator('[data-mt-pane-list="l1"] .mt-section input').first().evaluate((node) => getComputedStyle(node.closest('.mt-section')).pointerEvents), 'none');
    await tab.screenshot({path:path.join(shots, 'work-order-finalized.png')});
    await tab.locator('[data-mt-pane-list="l1"] [data-mt-labor-more]').click();
    assert.match(await tab.getByRole('menuitem').first().innerText(), /Paid out Oct 14, 2026 · \$4,500\.00/);
    await tab.getByRole('menuitem', {name:'Reopen…'}).click();
    const ask = tab.locator('dialog.fmco-dialog');
    await ask.locator('[data-fmco-ok]').click();
    assert.match(await ask.locator('[data-fmco-error]').innerText(), /Say why/);
    await ask.locator('[data-fmco-reason]').fill('Two lines were for the garage');
    await tab.screenshot({path:path.join(shots, 'work-order-reopen.png')});
    await ask.locator('[data-fmco-ok]').click();
    await tab.waitForFunction(() => window.calls.length === 2);
    assert.deepEqual((await tab.evaluate(() => window.calls))[1], {action:'labor.list.reopen', target:{scope:'project', organizationId:'org', projectId:'p1'}, input:{list_id:'l1', reason:'Two lines were for the garage'}});
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
});

test('Closeout: each check warns and never blocks; work orders are finalized in their step, then the final expenses close out the project', async () => {
  const server = await serve(); serverPort = server.address().port;
  const browser = await chromium.launch({channel:'chrome', headless:true});
  try {
    const {tab, errors} = await open(browser);
    await projectTab(tab);
    await tab.locator('[data-mt-closeout]').click();
    const dialog = tab.locator('dialog.fmco-dialog');
    await dialog.locator('.fmco-rail').waitFor();
    assert.deepEqual(await dialog.locator('.fmco-rail button .fmco-name').allInnerTexts(), ['Change orders','Signatures','Payments received','Scope accounted for','Receipts','Finalize work orders','Final expenses']);
    assert.match(await dialog.locator('.fmco-banner').innerText(), /1 change order not signed/);
    assert.match(await dialog.locator('.fmco-note').last().innerText(), /not a requirement/);
    await tab.screenshot({path:path.join(shots, 'closeout-step-a-change-orders.png')});
    for (let step = 1; step < 5; step += 1) {
      await dialog.locator('[data-fmco-next]').click();
      if (step === 4) await tab.screenshot({path:path.join(shots, 'closeout-step-e-receipts.png')});
    }
    // The final expenses cannot close the project while a work order is open; it says so and points back.
    await dialog.locator('.fmco-rail [data-fmco-step="6"]').click();
    assert.match(await dialog.locator('h3').innerText(), /Final expenses/);
    assert.equal(await dialog.locator('[data-fmco-close-out]').isDisabled(), true);
    assert.match(await dialog.locator('.fmco-banner').last().innerText(), /Finalize the work orders first: Summit Roofing, Crew A/);
    await dialog.locator('[data-fmco-goto-work]').click();
    // Step F: the completion widget for each work order, with the photos; each confirmed one is finalized on its own.
    assert.match(await dialog.locator('h3').innerText(), /Finalize work orders/);
    await dialog.locator('[data-fmco-order="l2"] [data-fmc-row]').first().waitFor();
    const finalize = dialog.locator('[data-fmco-finalize]');
    assert.equal(await finalize.isDisabled(), true);
    await tab.screenshot({path:path.join(shots, 'closeout-step-f-finalize.png')});
    await dialog.locator('[data-fmco-order="l1"] [data-fmc-all]').click();
    assert.equal(await finalize.innerText(), 'Finalize 1 work order');
    await finalize.click();
    await dialog.locator('[data-fmco-order="l1"]').waitFor({state:'detached'});
    assert.deepEqual(await tab.evaluate(() => window.calls.map((call) => [call.action, call.input.list_id, call.input.confirmed_item_ids])), [['labor.list.finalize','l1',['l1a','l1b','l1c']]]);
    await dialog.locator('[data-fmco-order="l2"] [data-fmc-all]').click();
    await finalize.click();
    // With every work order finalized, the dialog moves on to the final expenses, which close out the project.
    await dialog.locator('[data-fmco-close-out]:not([disabled])').waitFor();
    assert.match(await dialog.locator('h3').innerText(), /Final expenses/);
    assert.match(await dialog.locator('.fmco-note').last().innerText(), /Every work order is finalized/);
    await dialog.locator('[data-fmco-note]').fill('Final walkthrough done');
    await tab.screenshot({path:path.join(shots, 'closeout-step-g-expenses.png')});
    await dialog.locator('[data-fmco-close-out]').click();
    await dialog.waitFor({state:'detached'});
    const calls = await tab.evaluate(() => window.calls);
    assert.deepEqual(calls.map((call) => call.action), ['labor.list.finalize','labor.list.finalize','project-closeout.close']);
    assert.deepEqual(calls[2].input, {finalize:[], note:'Final walkthrough done'});

    // Closed out: the record says when, and only Reopen is offered.
    await tab.evaluate(() => { window.closeoutRecord = {project_id:'p1', state:'closed', closed_at:'2026-10-14T16:00:00Z', closed_by_user_id:'owner', note:'', lists:[{list_id:'l1',commitment_id:'c1',title:'Summit Roofing',total_cents:450000},{list_id:'l2',commitment_id:'c2',title:'Crew A',total_cents:102000}], checks:[], history:[]}; });
    await tab.locator('[data-mt-closeout]').click();
    await dialog.locator('[data-fmco-reopen-closeout]').waitFor();
    assert.match(await dialog.locator('.fmco-banner').innerText(), /Closed out Oct 14, 2026\. 2 work orders finalized to be paid, \$5,520\.00 in all/);
    await tab.screenshot({path:path.join(shots, 'closeout-closed.png')});
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
});

test('Pay out part of a work order now and the rest later, with the organization\'s confirmation method', async () => {
  const server = await serve(); serverPort = server.address().port;
  const browser = await chromium.launch({channel:'chrome', headless:true});
  try {
    const {tab, errors} = await open(browser);
    await tab.evaluate(() => { window.completionMethod = {method:'select_all', revision:2}; window.Portal = {util:{hasPerm:(key) => key === 'manage_company_settings'}}; });
    await projectTab(tab);
    await tab.locator('[data-mt-pane-list="l1"] [data-mt-labor-more]').click();
    await tab.getByRole('menuitem', {name:'Pay out'}).click();
    const dialog = tab.locator('dialog.fmco-dialog');
    await dialog.locator('[data-fmc-row]').first().waitFor();
    const confirm = dialog.locator('[data-fmco-confirm]');
    // The method is the organization's, and someone with company settings access can change it here.
    assert.equal(await dialog.locator('[data-fmco-method]').inputValue(), 'select_all');
    assert.match(await dialog.locator('.fmc-head').innerText(), /What you leave unchecked can be paid out later/);
    // The tear-off is done: paying out just that line is offered.
    await dialog.locator('[data-fmc-item="l1a"]').check();
    assert.equal(await confirm.isDisabled(), false, 'some lines can be paid out on their own');
    assert.equal((await confirm.innerText()).trim(), 'Pay out 1 line now');
    await tab.screenshot({path:path.join(shots, 'pay-out-partial.png')});
    await confirm.click();
    await dialog.waitFor({state:'detached'});
    let calls = await tab.evaluate(() => window.calls);
    assert.deepEqual(calls.at(-1), {action:'labor.list.finalize', target:{scope:'project', organizationId:'org', projectId:'p1'}, input:{list_id:'l1', method:'select_all', confirmed_item_ids:['l1a'], partial:true}});

    // Paid out in part: the list stays open for its other lines; its More menu says how much was paid and offers the rest.
    await tab.evaluate(() => { window.paidLines = {l1a:'2026-10-14T15:00:00Z'}; window.completions = [{id:'lp_1', list_id:'l1', state:'finalized', list_paid:'part', scope:'lines', line_ids:['l1a'], finalized_at:'2026-10-14T15:00:00Z', total_cents:128000}]; state.laborCompletions = null; window.draw(); });
    assert.equal(await tab.locator('[data-mt-pane-list="l1"].is-finalized').count(), 0, 'a work order paid out in part is not locked as a whole');
    await tab.locator('[data-mt-pane-list="l1"] [data-mt-labor-more]').click();
    assert.match(await tab.getByRole('menuitem').first().innerText(), /1 line paid out · \$1,280\.00/);
    await tab.screenshot({path:path.join(shots, 'work-order-partly-paid-menu.png'), clip:{x:700, y:0, width:740, height:360}});
    await tab.getByRole('menuitem', {name:'Pay out the rest'}).click();
    await dialog.locator('[data-fmc-row="l1a"]').waitFor();
    assert.match(await dialog.locator('[data-fmc-row="l1a"]').innerText(), /Paid out Oct 14/);
    assert.equal(await dialog.locator('[data-fmc-row="l1a"] input').count(), 0, 'a paid line is shown, not confirmed again');
    await dialog.locator('[data-fmc-all]').click();
    assert.equal((await confirm.innerText()).trim(), 'Mark completed · to be paid', 'every open line confirmed pays out the rest');
    await tab.screenshot({path:path.join(shots, 'pay-out-rest.png')});

    // Changing the method is the organization's setting, saved against its revision; the widget follows it.
    await dialog.locator('[data-fmco-method]').selectOption('each');
    await tab.waitForFunction(() => window.calls.some((call) => call.action === 'labor-completion.settings.save'));
    calls = await tab.evaluate(() => window.calls);
    assert.deepEqual(calls.find((call) => call.action === 'labor-completion.settings.save'), {action:'labor-completion.settings.save', target:{scope:'organization', organizationId:'org'}, input:{method:'each', expected_revision:2}});
    await dialog.locator('.fmc[data-method="each"]').waitFor();
    assert.equal(await dialog.locator('[data-fmc-all]').count(), 0, 'each line is now checked on its own');
    await dialog.locator('[data-fmc-item="l1b"]').check(); await dialog.locator('[data-fmc-item="l1c"]').check();
    await tab.screenshot({path:path.join(shots, 'pay-out-method-each.png')});
    await confirm.click();
    await dialog.waitFor({state:'detached'});
    assert.deepEqual((await tab.evaluate(() => window.calls)).at(-1).input, {list_id:'l1', method:'each', confirmed_item_ids:['l1b','l1c']});

    // Closeout confirms the remaining work orders by the organization's method too.
    await tab.evaluate(() => { window.completionMethod = {method:'approve', revision:3}; window.Portal = {util:{hasPerm:() => false}}; });
    await tab.locator('[data-mt-closeout]').click();
    await dialog.locator('.fmco-rail [data-fmco-step="5"]').click();
    await dialog.locator('[data-fmco-order="l2"] [data-fmc-approve]').waitFor();
    assert.equal(await dialog.locator('[data-fmco-order="l2"] input[type=checkbox]').count(), 0);
    await tab.screenshot({path:path.join(shots, 'closeout-step-f-approve-method.png')});
    await dialog.locator('.mt-modal-close[data-fmco-close]').click(); await dialog.waitFor({state:'detached'});
    // Without company settings access, Pay out uses the method and does not offer to change it.
    await tab.locator('[data-mt-pane-list="l2"] [data-mt-labor-more]').click();
    await tab.getByRole('menuitem', {name:'Pay out'}).click();
    await dialog.locator('[data-fmc-approve]').waitFor();
    assert.equal(await dialog.locator('[data-fmco-method]').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
});

test('Closeout pays out part of a work order, finishes it only by paying or cancelling the rest, and paid lines are read-only', async () => {
  const server = await serve(); serverPort = server.address().port;
  const browser = await chromium.launch({channel:'chrome', headless:true});
  try {
    const {tab, errors} = await open(browser);
    await projectTab(tab);
    // A paid-out line in the Project tab: greyed, a lock that says when, and no inputs or remove.
    assert.match(source.slice(source.indexOf('  function renderLineRow(item){'), source.indexOf('  function renderLineRow(item){') + 400), /if \(paidAt\) return renderPaidLineRow\(item, paidAt\);/, 'every line row goes through the paid-out check first');
    await tab.evaluate(() => { window.completions = [{id:'lp_l2', list_id:'l2', state:'finalized', list_paid:'part', line_ids:['l2a'], finalized_at:'2026-10-14T15:00:00Z', total_cents:84000}]; state.laborCompletions = null; window.draw(); });
    const paid = tab.locator('[data-mt-pane-list="l2"] [data-mt-paid-line="l2a"]');
    await paid.waitFor();
    assert.equal(await paid.locator('input, button, [data-mt-remove], [data-mt-list-trigger]').count(), 0, 'nothing on a paid line can be edited, removed or dragged');
    assert.equal(await paid.locator('.mt-paid-lock').getAttribute('data-fm-tooltip'), 'Paid out Oct 14, 2026');
    assert.equal(await tab.locator('[data-mt-pane-list="l2"].is-finalized').count(), 0, 'its other lines stay open');
    assert.ok(await tab.locator('[data-mt-pane-list="l2"] input').count() > 0);
    await tab.locator('[data-mt-pane-list="l2"]').screenshot({path:path.join(shots, 'work-order-paid-line-read-only.png')});
    await tab.evaluate(() => { window.completions = []; window.paidLines = {}; state.laborCompletions = null; window.draw(); });

    // Closeout step F: the same widget, with part of a work order paid out now.
    await tab.locator('[data-mt-closeout]').click();
    const dialog = tab.locator('dialog.fmco-dialog');
    await dialog.locator('.fmco-rail [data-fmco-step="5"]').click();
    await dialog.locator('[data-fmco-order="l1"] [data-fmc-item="l1a"]').check();
    const finalize = dialog.locator('[data-fmco-finalize]');
    assert.equal(await finalize.innerText(), 'Pay out 1 work order');
    await finalize.click();
    await dialog.locator('[data-fmco-rest="l1"]').waitFor();
    assert.deepEqual((await tab.evaluate(() => window.calls)).at(-1).input, {list_id:'l1', method:'select_all', confirmed_item_ids:['l1a'], partial:true});
    assert.match(await dialog.locator('[data-fmco-rest="l1"]').innerText(), /1 line paid out · \$1,280\.00/);
    assert.match(await dialog.locator('[data-fmco-order="l1"] [data-fmc-row="l1a"]').innerText(), /Paid out Oct 14/);
    await tab.screenshot({path:path.join(shots, 'closeout-step-f-partly-paid.png')});
    // The step finishes only once the rest is paid out or cancelled; closing still waits for it.
    await dialog.locator('.fmco-rail [data-fmco-step="6"]').click();
    assert.equal(await dialog.locator('[data-fmco-close-out]').isDisabled(), true);
    await dialog.locator('[data-fmco-goto-work]').click();
    await dialog.locator('[data-fmco-cancel-rest="l1"]').click();
    const ask = tab.locator('dialog.fmco-dialog').last();
    await ask.locator('[data-fmco-reason]').fill('Owner chose to keep the old ridge');
    await tab.screenshot({path:path.join(shots, 'closeout-cancel-rest.png')});
    await ask.locator('[data-fmco-ok]').click();
    await tab.waitForFunction(() => window.calls.some((call) => call.action === 'labor.list.cancel-remaining'));
    assert.deepEqual((await tab.evaluate(() => window.calls)).find((call) => call.action === 'labor.list.cancel-remaining').input, {list_id:'l1', reason:'Owner chose to keep the old ridge'});
    await dialog.locator('[data-fmco-order="l1"]').waitFor({state:'detached'});
    await dialog.locator('[data-fmco-order="l2"] [data-fmc-all]').click();
    await finalize.click();
    await dialog.locator('[data-fmco-close-out]:not([disabled])').waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
});

test('Settings › Configuration › Projects is where the organization chooses how work orders are confirmed', async () => {
  const server = await serve(); serverPort = server.address().port;
  const browser = await chromium.launch({channel:'chrome', headless:true});
  try {
    const {tab, errors} = await open(browser);
    const crm = await readFile(new URL('../../libraries/apps/settings/crm.js', import.meta.url), 'utf8');
    const start = crm.indexOf('    function mountCompletionMethod(container){');
    assert.ok(start > 0); assert.ok(crm.includes("mountCompletionMethod(host.querySelector('.crm-settings'));"), 'the Projects settings page mounts it');
    const body = crm.slice(start, crm.indexOf('\n    }', crm.indexOf('section.addEventListener', start)) + 6);
    const css = crm.match(/\.crm-settings-block\{[^}]*\}|\.crm-option-grid\{[^}]*\}|\.crm-option\{[^}]*\}|\.crm-option strong\{[^}]*\}|\.crm-option span\{[^}]*\}|\.crm-option\.active\{[^}]*\}/g).join('');
    const mounted = async (allowed) => tab.evaluate(({body, css, allowed}) => {
      document.getElementById('root').innerHTML = `<style>${css}</style><div class="crm-settings" style="max-width:820px;margin:20px;font-family:Inter,system-ui,sans-serif"></div>`;
      window.completionMethod = {method:'select_all', revision:4};
      window.PlatformAPI.appFlags = {has:() => true};
      window.Portal = {util:{hasPerm:(key) => allowed && key === 'manage_company_settings'}};
      const root = window, orgId = 'org';
      (0, eval)(`window.__mountCompletionMethod = (function(root, orgId){ ${body}; return mountCompletionMethod; })`);
      window.__mountCompletionMethod(root, orgId)(document.querySelector('.crm-settings'));
    }, {body, css, allowed});
    await mounted(false);
    assert.equal(await tab.locator('[data-completion-method]').count(), 0, 'shown only with company settings access');
    await mounted(true);
    await tab.locator('[data-completion-method="select_all"].active').waitFor();
    assert.deepEqual(await tab.locator('[data-completion-method] strong').allInnerTexts(), ['One approval', 'Select all', 'Each line']);
    await tab.locator('[data-completion-method="each"]').click();
    await tab.locator('[data-completion-method="each"].active').waitFor();
    assert.deepEqual((await tab.evaluate(() => window.calls)).at(-1), {action:'labor-completion.settings.save', target:{scope:'organization', organizationId:'org'}, input:{method:'each', expected_revision:4}});
    assert.equal(await tab.locator('[data-completion-status]').innerText(), 'Saved');
    await tab.locator('section[data-completion-method]').screenshot({path:path.join(shots, 'settings-completion-method.png')});
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
});
