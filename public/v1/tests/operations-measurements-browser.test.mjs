import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('Operations prefills the native workflow from an existing report without importing or replacing a selected dataset',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage();const requests=[];
    await page.route('https://operations.test/**',async route=>{
      const url=new URL(route.request().url());requests.push({method:route.request().method(),path:url.pathname});
      if(url.pathname.startsWith('/libraries/'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../'+url.pathname.slice(1),import.meta.url),'utf8')});
      if(url.pathname.endsWith('/measurements'))return route.fulfill({contentType:'application/json',body:JSON.stringify({measurements:{roofSquares:24.5,eavesLf:130,ridgesLf:42}})});
      return route.fulfill({contentType:'text/html',body:'<main id="host"></main>'});
    });
    await page.goto('https://operations.test/');
    await page.evaluate(async()=>{
      window.__APP={userOrgId:'org'};window.reads=[];
      window.dataset={status:'missing',code:'measurement_dataset_unselected'};
      window.PlatformAPI={publication:{measurements:async()=>dataset},projects:{get:async(org,id)=>{reads.push([org,id]);return {document:{data:{firstmeasure_project_id:'abcdef123'}}};}}};
      window.operations=await import('/libraries/guided-experiences/operations-setup.js');
    });
    await page.addScriptTag({url:'/libraries/doc-model/firstmate-doc-model.js'});
    await page.addScriptTag({url:'/libraries/doc-workflow/firstmate-doc-workflow.js'});
    await page.evaluate(()=>{
      window.params={};
      FMDocWorkflow.mount(document.getElementById('host'),{workflow:{schema_version:1,steps:[{id:'measure',title:'Measurements',items:[{kind:'measurements',writes:'params.measurements',prefill:'project.measurements',fields:[{key:'roofSquares',label:'Roof area',unit:'sq'},{key:'eavesLf',label:'Eaves',unit:'ft'}]}]}]},scope:{project:{id:'project_a'}},state:{params},onWrite:write=>{window.lastWrite=write;},services:{projectMeasurements:()=>operations.loadOperationsMeasurements({orgId:'org',projectId:'project_a'})}});
    });
    await page.waitForFunction(()=>document.querySelector('[data-fmdw-meas="roofSquares"]')?.value==='24.5');
    assert.equal(await page.locator('[data-fmdw-meas="eavesLf"]').inputValue(),'130');
    assert.deepEqual(await page.evaluate(()=>reads),[['org','project_a']]);
    assert.equal(requests.some(r=>r.method!=='GET'),false,'prefill performs no import or domain writes');
    const selected=await page.evaluate(async()=>{
      dataset={status:'ready',datasetId:'manual',revision:7,value:{measurements:{roofSquares:{value:9,unit:'roofing_square'},wallNetArea:{value:800,unit:'ft2'},missing:{value:null,unit:'ft'}},structures:[{id:'garage',name:'Garage',measurements:{roofSquares:{value:2,unit:'roofing_square'}}}]}};
      return operations.loadOperationsMeasurements({orgId:'org',projectId:'project_a'});
    });
    assert.equal(selected.values.roofSquares,9);assert.equal(selected.values.wallNetArea,800);assert.equal(selected.values.missing,undefined);
    assert.equal(selected.dataset_id,'manual');assert.equal(selected.structures[0].values.roofSquares,2);
    assert.equal(await page.evaluate(()=>reads.length),1,'selected data wins without report fallback');
    const denied=await page.evaluate(async()=>{dataset={status:'denied'};try{await operations.loadOperationsMeasurements({orgId:'org',projectId:'project_a'});return false;}catch{return true;}});
    assert.equal(denied,true);assert.equal(await page.evaluate(()=>reads.length),1);
  }finally{await browser.close();}
});
