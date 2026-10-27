import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium} from 'playwright-core';

const helper = await readFile(new URL('../../libraries/apps/materials/scope-of-work.js',import.meta.url),'utf8');
const scopeModule = await import('data:text/javascript;base64,'+Buffer.from(helper).toString('base64'));

const fields=[
  {definition:'roof.squares',key:'roofSquares',label:'Roof squares',unit:'roofing_square',required:true,schemas:['roofing'],group:'area',derives:[{definition:'roof.area',key:'roofArea',label:'Roof area',unit:'ft2',factor:100}]},
  {definition:'roof.ridge_length',key:'ridgesLf',label:'Ridges',unit:'ft',required:true,schemas:['roofing'],group:'length'},
  {definition:'roof.squares_9_to_12',key:'pitch9to12Squares',label:'Squares from 9/12 to 12/12',unit:'roofing_square',required:false,schemas:['roofing'],group:'part:roof.pitch_bands',group_label:'Squares by pitch band'},
  {definition:'roof.eave_length',key:'eavesLf',label:'Eave length',unit:'ft',required:false,schemas:['roofing'],group:'length'}
];
const form=(overrides={})=>({available:true,schemas:[{id:'roofing',title:'Roofing'}],fields,manual:null,in_use:{source:'none',dataset_id:'',values:{}},report_linked:false,...overrides});

test('the editor is offered only where scopes name a schema and no report is complete; entries never return beside a report', () => {
  const mode=scopeModule.manualMeasurementMode;
  assert.equal(mode(null,false),'none');
  assert.equal(mode(form(),false),'edit');
  assert.equal(mode(form({available:false,fields:[]}),false),'none','a project whose scopes name no schema keeps today\'s empty state');
  assert.equal(mode(form({in_use:{source:'other',dataset_id:'survey',values:{}}}),false),'none','another selected dataset is left alone');
  assert.equal(mode(form(),true),'none','a completed report with nothing entered is the 3D model as before');
  assert.equal(mode(form({manual:{values:{roofSquares:30}}}),true),'compare');
  assert.equal(mode(form({manual:{values:{roofSquares:30}},in_use:{source:'report',dataset_id:'r',values:{roofSquares:24}}}),false),'compare');
});

test('loadDocuments keeps entries made by hand out of the report values and adds them as their own entry', async () => {
  const reads=[];
  globalThis.window={PlatformAPI:{baseUrl:()=> '/v1/platform',request:async path=>path.includes('calculus')?{ledger:{sets:[]}}:{documents:[]},publication:{
    list:async()=>({items:[{id:'report',name:'FirstMeasure report',type:'measurements',role:'firstmeasure:r1',revision:'a'},{id:'dataset_manual_x',name:'Entered by hand',type:'measurements',role:'manual',revision:'b'}]}),
    read:async(org,source)=>{reads.push(source.export+':'+(source.target.id||''));
      if(source.export==='manual')return {status:'ready',value:form({manual:{values:{roofSquares:30}},in_use:{source:'report',dataset_id:'report',values:{roofSquares:24}}})};
      if(source.export==='report')return {status:'ready',value:{reportId:'r1',measurements:{}}};
      return {status:'ready',value:{measurements:{roofSquares:{value:24,unit:'roofing_square'}}}};}}}};
  try {
    const result=await scopeModule.loadDocuments('org','project');
    assert.ok(!reads.includes('value:dataset_manual_x'),'the manual dataset is never read as a report measurement document');
    assert.deepEqual(result.documents.map(doc=>[doc.id,doc.source]),[['manual-measurements','manual'],['report','measurement']]);
    const manual=result.documents.find(doc=>doc.source==='manual');assert.equal(manual.reportReady,true);assert.deepEqual(manual.form.manual.values,{roofSquares:30});
    // Keep availability even without a schema, so the empty state can explain manual entry.
    window.PlatformAPI.publication.read=async(org,source)=>source.export==='manual'?{status:'ready',value:form({available:false,fields:[],schemas:[]})}:{status:'missing'};
    window.PlatformAPI.publication.list=async()=>({items:[]});
    assert.equal((await scopeModule.loadDocuments('org','project')).documents[0].form.available,false);
    // Someone without project data access keeps the view they had.
    window.PlatformAPI.publication.read=async(org,source)=>{if(source.export==='manual')throw Error('denied');return {status:'missing'};};
    const denied=await scopeModule.loadDocuments('org','project');assert.equal(denied.documents.length,0);assert.equal(denied.error,'');
  } finally {delete globalThis.window;}
});

test('the Measurements view becomes the editor without a report, saves through the published action, and shows earlier entries beside the report', async () => {
  const files={'/libraries/apps/materials/scope-of-work.js':helper,'/libraries/apps/materials/manual-measurements.js':await readFile(new URL('../../libraries/apps/materials/manual-measurements.js',import.meta.url),'utf8')};
  const server=createServer((req,res)=>{const path=new URL(req.url,'http://fixture').pathname;if(files[path]){res.setHeader('Content-Type','text/javascript');res.end(files[path]);return;}res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><style>.sw-viewport{position:relative;height:640px;overflow:hidden}.sw-panel{position:absolute;inset:0;overflow:hidden}.sw-panel[hidden]{display:none}</style></head><body><aside style="width:420px;height:700px;display:flex;flex-direction:column"></aside></body></html>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1200,height:800}});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async form=>{
      window.helper=await import('/libraries/apps/materials/scope-of-work.js');
      window.invocations=[];window.revision=0;
      window.PlatformAPI={publication:{invoke:async(org,action,target,input)=>{invocations.push({org,action,target,input});window.revision++;const values={...(window.saved||{})};for(const [k,v] of Object.entries(input.values)){if(v===null)delete values[k];else values[k]=v;if(k==='roofSquares'){if(v===null)delete values.roofArea;else values.roofArea=v*100;}}window.saved=values;return {value:{datasetId:'dataset_manual_x',revision:'sha256:x',storeRevision:window.revision,values,inUse:Object.keys(values).length?(window.reportInUse?'other':'manual'):'none',changed:Object.keys(input.values)},receipt:{status:'succeeded'}};},read:async()=>({status:'missing'})}};
      window.widgetVisible=[];window.FirstMateWidgets={mount(root,ref){root.innerHTML='<div>3D model</div>';return {setVisible(v){widgetVisible.push(v);},destroy(){}};}};
      window.confirm=()=>true;
      window.manualDoc=f=>({id:'manual-measurements',source:'manual',title:'Measurements entered by hand',form:f,reportReady:false});
      helper.mountSidebar(document.querySelector('aside'),[manualDoc(form)],'','org:project',{canOrderMeasurements:true,onOrderMeasurements:()=>{window.orderOpened=true;}});
    },form());
    await page.getByText('No measurements.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Order measurement report'}).click();
    assert.equal(await page.evaluate(()=>window.orderOpened),true);
    assert.equal(await page.evaluate(()=>invocations.length),0,'opening ordering does not write measurements');
    await page.getByRole('button',{name:'Add measurements manually'}).click();
    await page.getByRole('heading',{name:'Measurements'}).waitFor();
    assert.ok(await page.getByText('Roofing',{exact:true}).isVisible());
    assert.equal(await page.locator('[data-scope-panel="roof"]').isHidden(),true,'the dead-end report view is replaced');
    assert.equal(await page.evaluate(()=>widgetVisible.at(-1)),false);
    assert.ok(await page.getByText('0 of 2 required entered').isVisible());
    // Required ones show first; the rest are one click away.
    assert.equal(await page.getByLabel('Eave length (ft)').count(),0);
    await page.getByRole('button',{name:/More measurements \(2\)/}).click();
    assert.ok(await page.getByLabel('Eave length (ft)').isVisible());
    assert.ok(await page.getByText('Squares by pitch band').isVisible());
    // Typing saves through measurements.manual.save, in dictionary keys.
    const squares=page.getByLabel('Roof squares (sq)');
    await squares.fill('32');await squares.press('Enter');
    await page.waitForFunction(()=>invocations.length===1);
    assert.deepEqual(await page.evaluate(()=>invocations[0]),{org:'org',action:'measurements.manual.save',target:{scope:'project',organizationId:'org',projectId:'project'},input:{values:{roofSquares:32}}});
    await page.getByText('1 of 2 required entered').waitFor();
    const eaves=page.getByLabel('Eave length (ft)');await eaves.fill('1,250.5');await eaves.press('Enter');
    await page.waitForFunction(()=>invocations.length===2);
    assert.deepEqual(await page.evaluate(()=>invocations[1].input),{values:{eavesLf:1250.5},expectedRevision:1},'a later save names the revision it was made from');
    // Not a number: refused in place, nothing saved.
    await eaves.fill('lots');await eaves.press('Enter');
    assert.equal(await page.locator('.smm-field.invalid').count(),1);assert.equal(await page.evaluate(()=>invocations.length),2);
    await eaves.press('Escape');
    // Phone width: the editor fits without sideways scrolling.
    await page.setViewportSize({width:375,height:760});await page.evaluate(()=>{document.querySelector('aside').style.width='100vw';});
    assert.ok(await page.locator('.smm').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
    await page.setViewportSize({width:1200,height:800});await page.evaluate(()=>{document.querySelector('aside').style.width='420px';});

    // The report arrives. The 3D model is the view again; "Your entries" shows what was typed beside the report's numbers.
    await page.evaluate(form=>{window.reportInUse=true;helper.mountSidebar(document.querySelector('aside'),[{...manualDoc(form),reportReady:true},{id:'report',source:'measurement',value:{measurements:{roofSquares:{value:24,unit:'roofing_square'}}}}],'','org:project');},form({manual:{dataset_id:'dataset_manual_x',store_revision:2,values:{roofSquares:32,roofArea:3200,eavesLf:1250.5}},in_use:{source:'report',dataset_id:'report',values:{roofSquares:24}}}));
    await page.waitForFunction(()=>!document.querySelector('[data-scope-panel="roof"]').hidden);
    assert.equal(await page.locator('[data-scope-manual]').isHidden(),true);
    const flip=page.getByRole('button',{name:'Your entries'});await flip.waitFor();
    await flip.click();
    await page.getByRole('heading',{name:'Your entries'}).waitFor();
    const rows=await page.locator('.smm-compare tbody tr').evaluateAll(trs=>trs.map(tr=>[...tr.cells].map(td=>td.textContent.trim())));
    assert.deepEqual(rows,[['Roof squares','24 sq','32 sq'],['Eave length','—','1,250.5 ft']]);
    assert.equal(await page.locator('.smm-compare td.differs').count(),1);
    await page.getByRole('button',{name:'Clear my entries'}).click();
    await page.waitForFunction(()=>invocations.length===3);
    assert.deepEqual(await page.evaluate(()=>invocations[2].input.values),{roofSquares:null,eavesLf:null});
    await page.waitForFunction(()=>!document.querySelector('[data-scope-panel="roof"]').hidden&&document.querySelector('[data-scope-manual]').hidden);
    assert.equal(await page.getByRole('button',{name:'Your entries'}).isHidden(),true,'nothing left to compare');

    // A project whose scopes name no schema keeps today's view.
    await page.evaluate(()=>helper.mountSidebar(document.querySelector('aside'),[],'','org:other'));
    assert.equal(await page.locator('[data-scope-panel="roof"]').isHidden(),false);assert.equal(await page.locator('.smm').count(),0);
  } finally {await browser.close();server.close();}
});

test('a typed value survives a stale refresh, expanding, collapsing and a reload, and the area follows the squares', async () => {
  const files={'/libraries/apps/materials/scope-of-work.js':helper,'/libraries/apps/materials/manual-measurements.js':await readFile(new URL('../../libraries/apps/materials/manual-measurements.js',import.meta.url),'utf8')};
  const server=createServer((req,res)=>{const path=new URL(req.url,'http://fixture').pathname;if(files[path]){res.setHeader('Content-Type','text/javascript');res.end(files[path]);return;}res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><style>.sw-viewport{position:relative;height:640px;overflow:hidden}.sw-panel{position:absolute;inset:0;overflow:hidden}.sw-panel[hidden]{display:none}</style></head><body><aside style="width:420px;height:700px;display:flex;flex-direction:column"></aside></body></html>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1200,height:800}});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async form=>{
      window.helper=await import('/libraries/apps/materials/scope-of-work.js');
      window.base=form;window.saved={};window.revision=0;window.invocations=[];
      // The server: saves land after a short delay, as on a real network.
      window.PlatformAPI={publication:{invoke:async(org,action,target,input)=>{invocations.push(input);await new Promise(r=>setTimeout(r,150));for(const [k,v] of Object.entries(input.values)){if(v===null)delete saved[k];else saved[k]=v;if(k==='roofSquares'){if(v===null)delete saved.roofArea;else saved.roofArea=v*100;}}revision++;return {value:{datasetId:'d',revision:'r',storeRevision:revision,values:{...saved},inUse:'manual',changed:Object.keys(input.values)}};},read:async()=>({status:'missing'})}};
      window.FirstMateWidgets={mount(root){return {setVisible(){},destroy(){}};}};
      window.serverForm=()=>({...base,manual:revision?{dataset_id:'d',store_revision:revision,values:{...saved}}:null,in_use:{source:revision?'manual':'none',dataset_id:revision?'d':'',values:{...saved}}});
      window.mountWith=(form,key='org:project')=>helper.mountSidebar(document.querySelector('aside'),[{id:'manual-measurements',source:'manual',form,reportReady:false}],'',key);
      window.staleForm=serverForm();
      mountWith(staleForm);
    },form());
    const squares=()=>page.getByLabel('Roof squares (sq)');
    await page.getByRole('button',{name:'Add measurements manually'}).click();
    await squares().waitFor();
    // Jack's steps: type 20 squares and move on.
    await squares().fill('20');await squares().press('Tab');
    await page.waitForFunction(()=>invocations.length===1&&revision===1);
    await page.getByText('Saved.',{exact:false}).waitFor();
    assert.equal(await page.locator('[data-smm-row="roofSquares"] [data-smm-derived]').innerText(),'= 2,000 sq ft','the area follows the squares');
    // A background read that started before the save lands after it. It must not take the value back.
    await page.evaluate(()=>{document.activeElement?.blur();mountWith({...staleForm,schemas:[...staleForm.schemas]});});
    await page.evaluate(()=>{const d=JSON.parse(JSON.stringify(staleForm));d.report_linked=false;d.fields=[...d.fields];mountWith(d);});
    assert.equal(await squares().inputValue(),'20');
    assert.ok(await page.getByText('1 of 2 required entered').isVisible());
    // Expand and collapse redraw the list.
    await page.getByRole('button',{name:/More measurements/}).click();assert.equal(await squares().inputValue(),'20');
    await page.getByRole('button',{name:'Show fewer'}).click();assert.equal(await squares().inputValue(),'20');
    // A value typed and not yet sent survives an expand that happens before it is saved.
    const ridges=page.getByLabel('Ridges (ft)');await ridges.fill('42');
    await page.getByRole('button',{name:/More measurements/}).click();
    assert.equal(await page.getByLabel('Ridges (ft)').inputValue(),'42');assert.equal(await squares().inputValue(),'20');
    await page.waitForFunction(()=>invocations.length===2&&revision===2);
    assert.deepEqual(await page.evaluate(()=>invocations[1]),{values:{ridgesLf:42},expectedRevision:1});
    assert.ok(await page.getByText('2 of 2 required entered').isVisible());
    // Reload: a fresh mount from what the server now holds.
    await page.evaluate(()=>{helper.disposeSidebar(document.querySelector('aside'));mountWith(serverForm(),'org:project');});
    await squares().waitFor();
    assert.equal(await squares().inputValue(),'20');assert.equal(await page.getByLabel('Ridges (ft)').inputValue(),'42');
    assert.equal(await page.locator('[data-smm-row="roofSquares"] [data-smm-derived]').innerText(),'= 2,000 sq ft');
    assert.equal(await page.getByLabel('Roof area (sq ft)').count(),0,'roof area is never asked for beside roof squares');
  } finally {await browser.close();server.close();}
});
