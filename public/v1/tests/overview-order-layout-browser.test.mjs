import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { chromium } from 'playwright-core';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
const source = (await read('libraries/apps/project-request/app.js')).replace(/\r\n/g, '\n');
const from = source.indexOf('  const css = `') + '  const css = '.length;
const to = source.indexOf('\n  `;', from) + 4;
const css = runInNewContext(source.slice(from, to)).replace(/@import[^;]+;/g, '');
const pagerFunction = source.match(/  function placeMobileOrderPager\(\)\{[\s\S]*?\n  \}/)[0];
const windowCssFrom = source.indexOf("    injectCSS('project-window', `") + "    injectCSS('project-window', ".length;
const windowCssTo = source.indexOf('\n    `);', windowCssFrom) + 6;
const windowCss = runInNewContext(source.slice(windowCssFrom, windowCssTo));

test('the mobile pin confirmation and next button reserve the same height', async () => {
  const browser = await chromium.launch({channel:'chrome', headless:true});
  try {
    for (const width of [320, 360, 390, 430]) {
      const page = await browser.newPage({viewport:{width,height:844}, isMobile:true, hasTouch:true});
      await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div class="r-overlay active mobile-order mobile-order-location"><div style="width:100%;padding:12px;box-sizing:border-box"><section class="r-step is-condensed" id="rStepType"><div id="rTypePill"><span class="r-order-select"><select><option>Roof</option></select></span></div></section><section id="rStepReport"><div id="rRoofReportFields"><div id="rMobilePinStage"><div class="r-confirm active" id="rConfirm"><div class="ic">□</div><div class="tx">I have placed a pin on every structure to be included in this report</div></div><button id="rMobilePinNext" hidden>Next</button></div></div></section></div></div>`);
      await page.addStyleTag({content:css});
      await page.waitForTimeout(600);
      const before = await page.locator('#rMobilePinStage').evaluate(e=>e.getBoundingClientRect().height);
      await page.evaluate(()=>{const confirm=document.getElementById('rConfirm');confirm.querySelector('.tx').textContent='Pin confirmed';document.getElementById('rTypePill').append(confirm);document.getElementById('rTypePill').classList.add('has-confirmed-pin');document.getElementById('rMobilePinNext').hidden=false;});
      const after = await page.locator('#rMobilePinStage').evaluate(e=>e.getBoundingClientRect().height);
      assert.ok(Math.abs(before-after)<1, `width ${width}: before ${before}, after ${after}`);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('project identity and overview share compact contact controls on mobile and desktop', async () => {
  const browser = await chromium.launch({channel:'chrome', headless:true});
  try {
    for (const width of [390,1280]) {
    const page = await browser.newPage({viewport:{width,height:844}, isMobile:width<760, hasTouch:width<760});
    const card = `<div class="r-contact-card primary" data-localized-heading="Primary Contact"><div class="r-inline"><div class="r-group"><input class="r-inp" value="Name"></div><div class="r-group"><input class="r-inp" value="Phone"></div></div><div class="r-contact-actions"><button class="r-contact-primary">★</button><button class="r-contact-menu-btn">⋯</button></div></div>`;
    await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div class="r-overlay active"><div class="r-modal-header" data-window-mobile="${width<760}"></div><div class="r-overview-details">${card}</div><div class="r-project-identity-popover ${width<760?'r-project-identity-sheet':''}"><header><strong>Contact and address</strong><button>Close</button></header><div class="r-project-identity-fields">${card}</div></div></div>`);
    await page.addStyleTag({content:css+windowCss});
    await page.waitForTimeout(400);
    const measures = await page.evaluate(()=>{
      const metrics = root=>{
        const card=root.querySelector('.r-contact-card'), button=root.querySelector('.r-contact-primary');
        const b=button.getBoundingClientRect(), c=card.getBoundingClientRect(), heading=getComputedStyle(card,'::before');
        const menu=root.querySelector('.r-contact-menu-btn').getBoundingClientRect();
        return {width:b.width,height:b.height,menuWidth:menu.width,menuHeight:menu.height,top:b.top-c.top,headingHeight:heading.minHeight,headingFont:heading.fontSize,headingMargin:heading.marginBottom,buttonTop:b.top};
      };
      return {overview:metrics(document.querySelector('.r-overview-details')),popup:metrics(document.querySelector('.r-project-identity-popover')),headerBottom:document.querySelector('.r-project-identity-popover>header').getBoundingClientRect().bottom};
    });
    for (const key of ['width','height','menuWidth','menuHeight','top','headingHeight','headingFont','headingMargin']) assert.equal(measures.popup[key],measures.overview[key],`${key}: ${JSON.stringify(measures)}`);
    assert.equal(measures.overview.width,30);assert.equal(measures.overview.height,30);
    assert.equal(measures.overview.menuWidth,30);assert.equal(measures.overview.menuHeight,30);assert.equal(measures.overview.headingHeight,'34px');
    assert.ok(measures.popup.buttonTop >= measures.headerBottom, `popup header must not cover the controls: ${JSON.stringify(measures)}`);
    await page.close();
    }
  } finally { await browser.close(); }
});

test('leaving mobile ordering restores the project without submitting or deleting it', () => {
  const fn = source.match(/  function cancelMobileReportOrdering\(\)\{[\s\S]*?\n  \}/)[0];
  const calls=[], project={id:'existing',address:'12 Main'};
  const context={requestedWorkflow:'report',overviewWorkflowMode:'report',reportProjectChoice:'existing',reportSelection:'roof',mobileOrderPage:'details',orderSubmissionPending:false,
    project, shouldUseMobileOrderPagination:()=>true, setActivePreviewTab:tab=>calls.push(['tab',tab]),renderWorkflowState:()=>calls.push(['render'])};
  runInNewContext(fn, context);
  assert.equal(context.cancelMobileReportOrdering(),true);
  assert.deepEqual([context.requestedWorkflow,context.overviewWorkflowMode,context.reportProjectChoice,context.reportSelection,context.mobileOrderPage],['project','','',null,'location']);
  assert.deepEqual(project,{id:'existing',address:'12 Main'});
  assert.deepEqual(calls,[['tab','map'],['render']]);
  context.orderSubmissionPending=true;
  assert.equal(context.cancelMobileReportOrdering(),false);
  assert.equal(calls.length,2,'cannot cancel an order that is being submitted');
});

test('the map button goes back during mobile ordering and otherwise keeps expand/shrink behavior', async () => {
  const mapSource=(await readFile(process.env.PROJECT_MAP_SOURCE || new URL('../../libraries/apps/project-map/app.js', import.meta.url),'utf8')).replace(/\r\n/g,'\n');
  const fn=name=>mapSource.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`))[0];
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();
    await page.setContent('<div id="panel"><div data-project-overview><button data-overview-map-toggle></button></div></div>');
    await page.addScriptTag({content:`let state={panelRoot:document.getElementById('panel'),mapExpandedManual:null,lastDefaultExpandedMap:false};let ordering=true,expanded=true,force=true,cancelled=0,selected=null;const callHost=(name)=>name==='isMobileReportOrdering'?ordering:name==='cancelMobileReportOrdering'?(cancelled++,true):undefined;const currentMapPanelRoot=()=>state.panelRoot,shouldForceExpandedMap=()=>force,shouldDefaultExpandedMap=()=>true,overviewMapExpanded=()=>expanded,scheduleMapResize=()=>{},setOverviewMapExpanded=v=>{selected=v},setActivePreviewTab=()=>{};${fn('applyOverviewMapMode')}\n${fn('bindOverview')}\nbindOverview(state.panelRoot);window.exercise={applyOverviewMapMode,set(v){ordering=v;force=false},state(){return {cancelled,selected}}};`});
    await page.evaluate(()=>exercise.applyOverviewMapMode());
    const button=page.locator('[data-overview-map-toggle]');
    assert.equal(await button.getAttribute('aria-label'),'Back to project');
    assert.equal((await button.textContent()).trim(),'Back');
    await button.click();
    assert.deepEqual(await page.evaluate(()=>exercise.state()),{cancelled:1,selected:null});
    await page.evaluate(()=>{exercise.set(false);exercise.applyOverviewMapMode();});
    assert.equal(await button.getAttribute('aria-label'),'Shrink map');
    await button.click();
    assert.deepEqual(await page.evaluate(()=>exercise.state()),{cancelled:1,selected:false});
  } finally { await browser.close(); }
});

test('mobile ordering owns its pager, fills the project window and preserves other tabs', async () => {
  const browser = await chromium.launch({channel:'chrome', headless:true});
  try {
    const page = await browser.newPage({viewport:{width:390,height:844}, isMobile:true, hasTouch:true});
    await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%}.r-right,.r-preview,.r-preview-stage{flex:1;min-height:0;position:relative}.r-tab-content{height:100%;display:flex;min-height:0}.r-tab-main{flex:1;min-height:0}.r-preview-panel{position:absolute;inset:0}.fm-project-tray-tabs{height:53px;flex:none}</style>
      <div id="rOverlay" class="r-overlay active window-managed project-layout-prototype mobile-order mobile-order-details overview-order-focused">
        <div class="r-win fm-window fm-entity-window">
          <header class="r-modal-header r-window-bar fm-shell-header" data-window-mobile="true" data-header-rows="2"><div class="r-window-identity fm-shell-identity"><button id="identity">Project</button></div><div id="rProjectViewerTabs" class="r-tabbar fm-shell-tabs"><button>Overview</button><button>Photos</button></div><div class="r-window-bar-actions"><button id="close">Close</button></div></header>
          <div class="r-right"><div class="r-preview"><div class="r-preview-stage"><div class="r-preview-panel active" data-panel="map"><div class="r-tab-content"><div class="r-overview-details"><div class="r-scroll">Order details</div></div><div class="r-tab-main">Map</div></div></div><div class="r-preview-panel" data-panel="photos"><div class="r-tab-content"><div class="r-tab-main">Photos content</div></div></div></div></div></div>
          <nav class="fm-project-tray-tabs" data-placement="footer">Notes To Do Activity Agent</nav>
          <div class="r-mobile-pager" id="rMobilePager"><button id="rMobileBack">Back</button><button id="rMobileNext">Next</button></div><div id="rOverviewDetailsStore" hidden></div>
        </div>
      </div>`);
    await page.addStyleTag({content:css});
    await page.addScriptTag({content:await read('libraries/window-manager/window-shell.js')});
    await page.evaluate(() => FirstMateWindowShell.ensureStyles());
    await page.addScriptTag({content:await read('libraries/window-manager/project-layout.js')});
    // Use the production layout's CSS without changing the fixture's pane ownership.
    const layout = (await read('libraries/window-manager/project-layout.js')).match(/s\.textContent=`([\s\S]*?)`;/)[1];
    await page.addStyleTag({content:runInNewContext('`'+layout+'`')});
    await page.addScriptTag({content:`window.placePager = ${pagerFunction};`});
    await page.evaluate(() => {window.clicks=0;document.getElementById('rMobileNext').onclick=()=>window.clicks++;placePager();});
    // Enter from the regular project: both bars collapse over time, allowing the workspace to grow.
    await page.evaluate(()=>document.getElementById('rOverlay').classList.remove('overview-order-focused'));
    await page.waitForTimeout(450);
    await page.evaluate(()=>document.getElementById('rOverlay').classList.add('overview-order-focused'));
    await page.waitForTimeout(60);
    const motion=await page.evaluate(()=>{
      const h=document.querySelector('.r-modal-header'),f=document.querySelector('.fm-project-tray-tabs');
      return {header:h.getBoundingClientRect().height,footer:f.getBoundingClientRect().height,headerAnimations:h.getAnimations().map(a=>a.transitionProperty),footerAnimations:f.getAnimations().map(a=>a.transitionProperty)};
    });
    assert.ok(motion.headerAnimations.includes('grid-template-rows'),JSON.stringify(motion));
    assert.ok(motion.footerAnimations.includes('height'),JSON.stringify(motion));
    assert.ok(motion.header>49 && motion.header<91 && motion.footer>0 && motion.footer<53,JSON.stringify(motion));
    await page.waitForTimeout(450);
    for (const state of ['details','photos','final']) {
      await page.evaluate(state=>{const o=document.getElementById('rOverlay');o.classList.remove('mobile-order-location','mobile-order-details','mobile-order-photos','mobile-order-final');o.classList.add('mobile-order-'+state);},state);
      assert.equal(await page.locator('#rProjectViewerTabs').isVisible(),false);
      assert.equal(await page.locator('.fm-project-tray-tabs').isVisible(),false);
      assert.equal(await page.locator('#identity').isVisible(),true);
      assert.equal(await page.locator('#close').isVisible(),true);
      assert.equal(await page.locator('[data-panel=map] > #rMobilePager').isVisible(),true);
      const boxes=await page.evaluate(()=>{const r=s=>document.querySelector(s).getBoundingClientRect();return {header:r('.r-modal-header').bottom,pager:r('#rMobilePager').bottom,window:r('.r-win').bottom};});
      assert.equal(Math.round(boxes.header),49);
      assert.equal(Math.round(boxes.pager),Math.round(boxes.window));
    }
    await page.locator('#rMobileNext').click();
    await page.evaluate(()=>{const p=document.getElementById('rMobilePager');document.getElementById('rOverviewDetailsStore').append(p);const old=document.querySelector('[data-panel=map]');old.remove();const n=document.createElement('div');n.className='r-preview-panel active';n.dataset.panel='map';n.innerHTML='<div class="r-tab-content"><div class="r-tab-main">Map</div></div>';document.querySelector('.r-preview-stage').prepend(n);placePager();});
    await page.locator('#rMobileNext').click();
    assert.equal(await page.evaluate(()=>window.clicks),2,'the same pager and handlers survive a panel rebuild');
    await page.evaluate(()=>{document.getElementById('rOverlay').classList.remove('overview-order-focused');document.querySelector('[data-panel=map]').classList.remove('active');document.querySelector('[data-panel=photos]').classList.add('active');});
    await page.waitForTimeout(350);
    assert.equal(await page.locator('[data-panel=photos] .r-tab-main').isVisible(),true,'other tabs retain their own content');
    assert.equal(await page.locator('#rMobilePager').evaluate(e=>getComputedStyle(e.closest('[data-panel]')).opacity),'0','the pager stays inside the inactive Overview panel');
    await page.evaluate(()=>document.getElementById('rOverlay').classList.remove('mobile-order','mobile-order-final'));
    assert.equal(await page.locator('.fm-project-tray-tabs').isVisible(),true,'tray bar returns after ordering');
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.evaluate(()=>document.getElementById('rOverlay').classList.add('mobile-order','overview-order-focused'));
    assert.equal(await page.locator('.fm-shell-header').evaluate(e=>getComputedStyle(e).transitionDuration),'0s','respect reduced motion');
    await browser.close();
  } finally { if(browser.isConnected()) await browser.close(); }
});
