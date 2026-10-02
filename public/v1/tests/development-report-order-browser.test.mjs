import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('ordinary projects launch ordering and the address shortcut follows current criteria without enabling instant copies',async()=>{
  const source=await readFile(new URL('../../libraries/apps/project-request/app.js',import.meta.url),'utf8');
  const start=source.indexOf('  let developmentReportSample ='),end=source.indexOf('\n  }',source.indexOf('  function bindDevelopmentReportControls()',start))+4;
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage();
    await page.setContent('<input id="rAddress" value="Typed address"><input id="rLat"><input id="rLng"><input id="rComps"><button id="rOrderMeasurements" hidden>Order Measurements</button><label id="rInstantDevelopmentReport" hidden><input id="rInstantDevelopmentCheck" type="checkbox">Instant development report</label><div id="rWorkflowDock"></div><div id="rReportAddons"></div>');
    await page.addScriptTag({content:`
      var selectedType='residential',requestedWorkflow='project',addressSelected=true,locationConfirmed=false,reportSelection=null;
      var scope='roof',calls=[],counter=0,empty=false;
      const $=s=>document.querySelector(s),hasPerm=()=>true,hasReportOrdered=()=>false;
      window.Portal={ExteriorOrder:{selectedScope:()=>scope,active:()=>scope==='full_house'}};
      const setCoords=()=>{},clearAllPins=()=>{},addPin=()=>{},focusMapOnProject=()=>{},updateModalTitle=()=>{},queueAutosaveNotice=()=>{},setActivePreviewTab=()=>{},onSubmit=()=>{};
      const showToast=(title,message)=>window.notice=message;
      const postAction=async(action,body)=>{calls.push({action,body});if(action==='development_report_capability')return {data:{enabled:true}};return {data:{success:true,sample:empty?null:{id:'sample-'+(++counter),address:'Sample '+counter,lat:40,lng:-90,pins:[],project_type:body.project_type,measurement_scope:body.measurement_scope,selection_token:'token'},message:'No matching report'}};};
      const renderWorkflowState=()=>syncDevelopmentReportControls();
      ${source.slice(start,end)}
      bindDevelopmentReportControls();syncDevelopmentReportControls();
    `});
    await page.getByRole('button',{name:'Order Measurements',exact:true}).click();
    assert.equal(await page.evaluate(()=>requestedWorkflow),'report');
    await page.locator('#rDevelopmentAddress').click();
    await page.waitForFunction(()=>document.querySelector('#rAddress').value==='Sample 1');
    assert.equal(await page.locator('#rInstantDevelopmentCheck').isChecked(),false);
    assert.equal(await page.locator('#rInstantDevelopmentReport').isVisible(),true);
    await page.locator('#rInstantDevelopmentCheck').check();
    assert.equal(await page.evaluate(()=>!!instantDevelopmentReport()),true);
    await page.evaluate(()=>{selectedType='commercial';scope='full_house';syncDevelopmentReportControls();});
    assert.equal(await page.locator('#rInstantDevelopmentReport').isVisible(),false);
    await page.locator('#rDevelopmentAddress').click();
    const call=await page.evaluate(()=>calls.at(-1));assert.equal(call.body.project_type,'commercial');assert.equal(call.body.measurement_scope,'full_house');assert.equal(call.body.exclude_id,'sample-1');
    assert.equal(await page.locator('#rAddress').inputValue(),'Sample 2');assert.equal(await page.locator('#rInstantDevelopmentCheck').isChecked(),false);
    await page.evaluate(()=>empty=true);await page.locator('#rDevelopmentAddress').click();
    assert.equal(await page.locator('#rAddress').inputValue(),'Sample 2');assert.equal(await page.evaluate(()=>notice),'No matching report');
  }finally{await browser.close();}
});
