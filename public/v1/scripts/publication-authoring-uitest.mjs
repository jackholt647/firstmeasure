import { createServer } from 'node:http';
import { readFile, access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const root=path.resolve(fileURLToPath(new URL('../../',import.meta.url))), output=path.resolve(root,'../output/publication-architecture-20260923');
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');if(url.pathname==='/test'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta charset="UTF-8"><title>Publication authoring test</title></head><body><div id="panel"></div></body></html>');return;}const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));if(!file.startsWith(root+path.sep))throw Error();res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/plain');res.end(await readFile(file));}catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const candidates=process.platform==='win32'?['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']:['/usr/bin/chromium','/usr/bin/google-chrome',chromium.executablePath()];let executablePath;
for(const candidate of candidates){try{await access(candidate);executablePath=candidate;break;}catch{}}
assert.ok(executablePath,'Chromium required');
const browser=await chromium.launch({executablePath,headless:true});const page=await browser.newPage({viewport:{width:1280,height:960}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(`http://127.0.0.1:${server.address().port}/test`);
 await page.evaluate(async()=>{
  window.calls=[];window.savedProgram=null;window.instance=null;
  window.PlatformAPI={baseUrl:()=>'/v1/platform',request:async(url,options={})=>{
   const route=new URL(url,location.href).pathname;window.calls.push({route,...options});
   if(route.endsWith('/catalog'))return {providers:[{id:'datasets',version:'1',exports:{value:{description:'Project dataset',schema:{type:'object'},access:{scopes:['project']}}}}],actions:[]};
   if(route.endsWith('/modules/example'))return {module:{definition:{inputSchema:{type:'object',required:['count'],properties:{count:{type:'number',title:'Count'}}}}}};
   if(route.endsWith('/modules'))return {modules:[{id:'example',name:'Example',kind:'document'}]};
   if(route.endsWith('/instances')&&options.method==='POST'){window.instance={id:'instance',moduleId:'example',kind:'document',revision:1,canEdit:true,frozen:false,inputs:options.body.inputs,inputSchema:{type:'object',required:['count'],properties:{count:{type:'number'}}},bindings:{},exports:{},lastExecutionId:null};return {instance:structuredClone(window.instance)};}
   if(route.endsWith('/instances'))return {instances:window.instance?[window.instance]:[]};
   if(route.endsWith('/instance')&&options.method==='PATCH'){window.instance.inputs=options.body.inputs;window.instance.revision++;return {instance:structuredClone(window.instance)};}
   if(route.endsWith('/refresh')){window.instance.exports={total:window.instance.inputs.count*10};window.instance.revision++;window.instance.lastExecutionId='execution';return {instance:structuredClone(window.instance)};}
   if(route.endsWith('/freeze')){window.instance.frozen=true;window.instance.revision++;return {instance:structuredClone(window.instance)};}
   if(route.endsWith('/freshness'))return {stale:false};
   throw Error('Unmocked '+route);
  }};
  const ui=await import('/libraries/apps/documents/program-panel.js');
  await ui.mountProgramPanel(document.querySelector('#panel'),{organizationId:'test',getProgram:()=>({}),onChange:p=>{window.savedProgram=p;}});
 });
 await page.locator('[data-enabled]').check();await page.locator('[data-name]').fill('measurements');await page.locator('[data-resource]').fill('dataset-one');await page.locator('[data-add]').click();await page.locator('[data-source]').fill("const data=await api.data.read('measurements');return {outputs:{data}};");await page.locator('[data-apply]').click();
 const saved=await page.evaluate(()=>window.savedProgram);assert.equal(saved.bindings.measurements.source.target.projectId,'$project');assert.equal(saved.enabled,true);
 await page.evaluate(async()=>{document.querySelector('#panel').remove();await (await import('/libraries/apps/documents/program-panel.js')).openModuleInstances('test','project');});
 await page.locator('[data-create]').click();await page.locator('dialog').last().locator('[data-field=count]').fill('2');await page.locator('dialog').last().getByRole('button',{name:'Create',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-output]')?.textContent.includes('20'));
 await page.locator('[data-inputs] [data-field=count]').fill('3');await page.locator('[data-refresh]').click();await page.waitForFunction(()=>document.querySelector('[data-output]')?.textContent.includes('30'));
 assert.equal(await page.evaluate(()=>window.instance.inputs.count),3,'refresh retains edited inputs');
 await page.locator('[data-freeze]').click();await page.waitForFunction(()=>document.querySelector('[data-save]').disabled);assert.equal(await page.locator('[data-inputs] input').isDisabled(),true);
 await mkdir(output,{recursive:true});await page.screenshot({path:path.join(output,'module-instance.png'),fullPage:true});
 await page.getByRole('button',{name:'Close',exact:true}).click();
 await page.evaluate(async()=>{await (await import('/libraries/apps/documents/program-panel.js')).openScopePrograms({organizationId:'test',read:async()=>({version:1,definition:{id:'scope',name:'Scope',work_plan:{root_nodes:[{id:'task',title:'Task'}],automation_bindings:{onStarted:[{id:'existing',automation:'project.patch.v1',input:{values:{title:'unchanged'}}}]}}}}),save:async body=>{window.savedScope=body;return {version:2};}});});
 await page.locator('[data-source]').fill('return {outputs:{count:1}};');await page.locator('[data-apply]').click();await page.locator('[data-save]').click();await page.waitForFunction(()=>window.savedScope);
 const scope=await page.evaluate(()=>window.savedScope);assert.equal(scope.expected_version,1);assert.equal(scope.work_plan.automation_bindings.onStarted.length,2);assert.equal(scope.work_plan.automation_bindings.onStarted[0].id,'existing');assert.equal(scope.work_plan.automation_bindings.onStarted[1].automation,'scope.code.run.v1');
 await page.screenshot({path:path.join(output,'scope-program.png'),fullPage:true});assert.deepEqual(errors,[]);console.log('PASS builder bindings, instance create/save/refresh/freeze, scope version preservation, real renderer loading');
}finally{await browser.close();await new Promise(r=>server.close(r));}
