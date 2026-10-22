const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('../public/v1/node_modules/playwright-core');
// The report configuration Exteriors tab is only the house orientation dial; report toggles stay parameters in data.
const ROOT='public/measure/internal/editor_scripts/';
async function mount(page,settings={}){
 await page.route('http://orientation.test/**',route=>route.fulfill({contentType:'text/html',body:'<body style="margin:0"><div id="report-config-panel"><div id="reportPreviewContent"><div id="tab" style="width:420px;height:720px"></div></div></div></body>'}));
 await page.goto('http://orientation.test');for(const f of ['exterior_pdf.js','exterior_report_model.js','exterior_report.js'])await page.addScriptTag({path:ROOT+f}).catch(()=>{});
 await page.evaluate(settings=>{
  // A 10 x 6 m footprint whose long walls face 45 and 225 degrees (northeast / southwest).
  const rot=(x,y)=>{const a=-Math.PI/4;return {x:x*Math.cos(a)-y*Math.sin(a),y:x*Math.sin(a)+y*Math.cos(a),z:3};};
  const roof=[{points:[rot(-5,-3),rot(5,-3),rot(5,3),rot(-5,3)]}],normal=b=>({x:Math.sin(b*Math.PI/180),y:-Math.cos(b*Math.PI/180),z:0});
  window.events=[];document.addEventListener('house-orientation-change',e=>events.push(e.detail?.frontBearing));
  window.state={exteriorSettings:settings,exteriorReport:{roof,walls:[{id:'W01',normal:normal(45),gross:300,material:'Unassigned'},{id:'W02',normal:normal(225),gross:300,material:'Brick'},{id:'W03',normal:normal(135),gross:180,material:'Brick'},{id:'W04',normal:normal(315),gross:180,material:'Brick'}],openings:[],totals:{net:960,gross:960}}};
  renderExteriorReportConfig(document.getElementById('tab'),state);
 },settings);
}
const launch=()=>chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),args:['--no-sandbox']});
const dragTo=async(page,bearing,{shift=false,steps=6}={})=>{const box=await page.locator('[data-orientation-dial]').boundingBox(),cx=box.x+box.width/2,cy=box.y+box.height/2,r=Math.min(box.width,box.height)*.3,a=bearing*Math.PI/180;
 await page.mouse.move(cx,cy-r);if(shift)await page.keyboard.down('Shift');await page.mouse.down();await page.mouse.move(cx+Math.sin(a)*r,cy-Math.cos(a)*r,{steps});return async()=>{await page.mouse.up();if(shift)await page.keyboard.up('Shift');};};
const read=page=>page.evaluate(()=>({b:state.exteriorSettings.frontBearing,events:[...events],slider:Number(document.querySelector('#tab input[type=range]').value),number:Number(document.querySelector('#tab input[type=number]').value),now:Number(document.querySelector('[data-orientation-dial]').getAttribute('aria-valuenow')),readout:document.querySelector('[data-front-readout]').textContent}));
test('the Exteriors tab is only the house orientation; the report toggles stay parameters in data',async()=>{
 const browser=await launch();try{const page=await browser.newPage({viewport:{width:900,height:900}});
  await mount(page,{include:false,dimensionContext:false,notes:'Keep me'});
  const tab=page.locator('#tab');
  assert.equal(await tab.locator('input[type=checkbox]').count(),0,'no toggles');assert.equal(await tab.locator('select').count(),0,'no choose-the-front-wall control');
  assert.equal(await tab.locator('table').count(),0,'no faces list');assert.equal(await tab.locator('textarea').count(),0,'no notes box');
  assert.equal(await tab.locator('[data-house-orientation]').count(),1);assert.equal(await tab.locator('[data-orientation-dial]').count(),1);
  const kept=await page.evaluate(()=>({s:state.exteriorSettings,context:ExteriorPDF.dimensionContext(state.exteriorSettings),contextDefault:ExteriorPDF.dimensionContext({})}));
  assert.deepEqual({include:kept.s.include,dimensionContext:kept.s.dimensionContext,notes:kept.s.notes},{include:false,dimensionContext:false,notes:'Keep me'},'parameters set in data are untouched');
  assert.equal(kept.context,false,'a report override is honoured');assert.equal(kept.contextDefault,true,'default on');
  const dial=await page.locator('[data-orientation-dial]').boundingBox();assert.ok(dial.width>=330,'the dial fills the width: '+dial.width);
  // The unassigned-materials warning no longer points at a faces list.
  const buttons=await page.evaluate(()=>{renderUnassignedMaterialWarning(state);return [...document.querySelectorAll('#report-unassigned-warning button')].map(b=>b.textContent);});
  assert.deepEqual(buttons,['Assign in Walls']);
 }finally{await browser.close();}
});
test('include stays a parameter: a report that turned it off has no exterior pages, a customer full-house PDF always does',()=>{
 const src=require('fs').readFileSync(ROOT+'pdf.js','utf8');
 assert.match(src,/isCustomerFullHousePdf\(state\) \|\| state\.exteriorSettings\?\.include !== false/);
});
test('dragging the dial sets the front bearing on release, keeps the slider in sync and snaps to wall directions unless Shift is held',async()=>{
 const browser=await launch();try{const page=await browser.newPage({viewport:{width:900,height:900}});await mount(page);
  assert.match((await read(page)).readout,/not set/);
  let up=await dragTo(page,100);let s=await read(page);
  assert.equal(s.b,undefined,'nothing is saved while dragging');assert.equal(s.events.length,0,'no change event while dragging');assert.ok(Math.abs(s.slider-100)<1.5&&Math.abs(s.now-100)<1.5,'slider and dial follow the drag: '+JSON.stringify(s));
  await up();s=await read(page);
  assert.ok(Math.abs(s.b-100)<1.5,'bearing set on release: '+s.b);assert.equal(s.events.length,1);assert.equal(s.slider,s.number);assert.ok(Math.abs(s.slider-s.b)<.06);assert.match(s.readout,/the front faces east/);
  // Within 3 degrees of a wall direction the drag snaps to it; Shift sets the exact angle.
  up=await dragTo(page,137);await up();s=await read(page);assert.ok(Math.abs(s.b-135)<1e-9,'snapped to the 135 degree wall: '+s.b);
  up=await dragTo(page,137,{shift:true});await up();s=await read(page);assert.ok(Math.abs(s.b-137)<1.5&&Math.abs(s.b-135)>.5,'Shift turns snapping off: '+s.b);
  // Any angle can be typed.
  await page.locator('#tab input[type=number]').fill('212.4');await page.locator('#tab input[type=number]').press('Tab');
  s=await read(page);assert.equal(s.b,212.4);assert.equal(s.slider,212.4);
 }finally{await browser.close();}
});
test('the slider moves the dial while sliding and saves when released',async()=>{
 const browser=await launch();try{const page=await browser.newPage({viewport:{width:900,height:900}});await mount(page,{frontBearing:10});
  const r=await page.evaluate(async()=>{const slider=document.querySelector('#tab input[type=range]'),dial=document.querySelector('[data-orientation-dial]'),knob=dial.querySelector('[data-front-knob]');const before=knob.getAttribute('cx');
   slider.value='200';slider.dispatchEvent(new Event('input'));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
   const during={b:state.exteriorSettings.frontBearing,events:events.length,now:dial.getAttribute('aria-valuenow'),number:document.querySelector('#tab input[type=number]').value,moved:knob.getAttribute('cx')!==before};
   slider.dispatchEvent(new Event('change'));return {during,after:{b:state.exteriorSettings.frontBearing,events:[...events]}};});
  assert.deepEqual(r.during,{b:10,events:0,now:'200',number:'200',moved:true});assert.equal(r.after.b,200);assert.deepEqual(r.after.events,[200]);
  const snaps=await page.evaluate(()=>ExteriorReportOrientation.orientationSnaps(state.exteriorReport).map(b=>Math.round(b)));assert.deepEqual(snaps.slice(0,2).sort((a,b)=>a-b),[45,225]);
  assert.equal(await page.evaluate(()=>ExteriorReportOrientation.snapBearing(358.5,[0])),0);assert.equal(await page.evaluate(()=>ExteriorReportOrientation.snapBearing(350,[0])),350);
 }finally{await browser.close();}
});
