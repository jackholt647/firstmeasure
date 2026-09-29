import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const viewer = process.env.PROJECTS_VIEWER_URL
  ? await (await fetch(process.env.PROJECTS_VIEWER_URL)).text()
  : await readFile(new URL('../../libraries/apps/projects/viewer.js', import.meta.url), 'utf8');
const browser = await chromium.launch({ channel:'chrome', headless:true });
try {
  const page = await browser.newPage({ viewport:{ width:1400, height:900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<div id="app" style="width:1350px;height:850px"></div>');
  await page.evaluate(() => {
    const projects = [
      { id:'p1', address:'Zulu Avenue', created_at:'2026-09-29T12:00:00Z', status:'ready', customer_name:'Zoe', workflow_state:'newly_sold' },
      { id:'p2', address:'Alpha Avenue', created_at:'2026-09-28T12:00:00Z', status:'ready', customer_name:'Ada', workflow_state:'newly_sold' },
      { id:'p3', address:'Maple Street', created_at:'2026-09-27T12:00:00Z', status:'ready', customer_name:'Mae', workflow_state:'newly_sold' }
    ];
    const boards = [{ id:'sales', title:'Sales', color:'#aa3344', columns:[
      { id:'new', title:'New', color:'#aa3344', cards:[{ project_id:'p1', plan_id:'plan1' },{ project_id:'p2', plan_id:'plan2' }] },
      { id:'working', title:'Working', color:'#4466aa', cards:[{ project_id:'p3', plan_id:'plan3' }] }
    ] }];
    window.__APP = { userOrgId:'org-view-controls' };
    window.PlatformAPI = { appFlags:{ value:(_scope,key) => ['project_stages_view','manual_project_stage_movement'].includes(key) }, work:{ boards:async () => ({ boards }) } };
    window.Portal = {
      currentUser:{ permissions:{ manage_projects:true } },
      appFlags:window.PlatformAPI.appFlags,
      apps:{ registerPortalApp:(app) => { window.__viewerApp = app; } },
      credits:{ refreshCredits(){} },
      navigation:{ read:() => ({}), registerSchema(){}, registerHandler(){}, replace(){}, push(){} },
      ui:{ showToast(){} },
      util:{
        $:(selector,root=document) => root.querySelector(selector),
        escapeHtml:(value) => String(value ?? '').replace(/[&<>"']/g,(character) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[character]),
        injectCSS:(id,css) => { const style=document.createElement('style'); style.id=id; style.textContent=css; document.head.append(style); },
        formatDate:(date) => String(date || ''),
        postAction:async () => ({ data:{ projects, pagination:{ total_pages:1, total_count:projects.length } } }),
        enableSafeBackdropClose(){}, currentActor:() => ({})
      }
    };
  });
  await page.addScriptTag({ content:viewer });
  await page.evaluate(() => window.__viewerApp.mount(document.querySelector('#app')));
  await page.waitForSelector('.v-stage-col');
  assert.equal(await page.locator('.v-title .sub,#vTip,#vStatus,#vSort,#vListGrouping').count(),0);
  const title=await page.locator('.v-title').boundingBox(), actions=await page.locator('.v-actions').boundingBox();
  assert.ok(actions.x > title.x+title.width,'view actions sit to the right of My Projects');
  await page.locator('#vManageView').click();
  assert.equal(await page.locator('#vManageSortKey').isVisible(),true);
  await page.locator('#vManageSortKey').selectOption('address');
  assert.deepEqual(await page.locator('.v-stage-col[data-stage="new"] .v-stage-card').evaluateAll((cards)=>cards.map((card)=>card.dataset.id)),['p1','p2']);
  await page.locator('#vManageSortDirection').click();
  assert.deepEqual(await page.locator('.v-stage-col[data-stage="new"] .v-stage-card').evaluateAll((cards)=>cards.map((card)=>card.dataset.id)),['p2','p1']);
  await page.locator('#vViewList').click();
  await page.locator('#vManageView').click();
  assert.equal(await page.locator('[data-list-column]').count(),4);
  await page.locator('[data-list-column="status"]').uncheck();
  assert.equal(await page.locator('#vListHead [data-k="status"],.v-lrow [data-col="status"]').count(),0);
  await page.locator('#vListHead [data-k="address"]').click();
  assert.deepEqual(await page.locator('.v-list-group[data-stage="new"] .v-lrow').evaluateAll((rows)=>rows.map((row)=>row.dataset.id)),['p2','p1']);
  await page.locator('#vWorkBoardTrigger').click();
  await page.locator('.v-board-option[data-board-id="all"]').click();
  assert.deepEqual(await page.locator('.v-list-group-header span:first-of-type').allTextContents(),['Sales']);
  await page.locator('#vViewTiles').click();
  await page.locator('#vManageView').click();
  await page.locator('#vManageStageFilter').selectOption('working');
  await page.waitForFunction(() => document.querySelectorAll('.v-tile').length === 1);
  assert.equal(await page.locator('.v-tile').getAttribute('data-id'),'p3');
  await page.locator('#vManageStageFilter').selectOption('all');
  await page.waitForFunction(() => document.querySelectorAll('.v-tile').length === 3);
  await page.setViewportSize({ width:390, height:780 });
  await page.locator('#app').evaluate((app) => { app.style.width='100vw'; app.style.height='780px'; });
  assert.equal(await page.locator('#vManageView').isVisible(),true);
  assert.deepEqual(errors,[]);
  console.log('PASS: right-side controls, list columns/sort, stage sort, tile stage filter, mobile');
} finally {
  await browser.close();
}
