// Opening a project selects the branch's default tray (Settings › CRM › default_project_tray) on desktop only. On a
// phone a tray covers the whole project, so none opens by itself; the person opens one from the header's trays menu.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../../libraries/apps/project-request/app.js',import.meta.url),'utf8');
const start=source.indexOf('loadBranchProjectConfig().then(() => {\n        if (trayInteraction');
assert.ok(start>0,'the default tray is chosen after the branch configuration loads');
const block=source.slice(start,source.indexOf('\n      });',start)+10);
const phoneCheck=source.slice(source.indexOf('  function isMobileProjectOrder(){'),source.indexOf('\n  }',source.indexOf('  function isMobileProjectOrder(){'))+4);

async function opened({width,bridge=false,topWidth=width,setting='notes'}){
  const selected=[];
  const media=w=>q=>({matches:Number(/max-width: (\d+)px/.exec(q)[1])>=w});
  const ctx={selected,branchProjectConfig:{default_project_tray:setting},projectWindowBridge:bridge,trayGeneration:1,projectTrayOpenGeneration:1,trayInteraction:0,
    overlay:{classList:{contains:()=>true}},projectTrays:{interactionVersion:()=>0,available:()=>['notes','tasks'],select:key=>selected.push(key)},
    loadBranchProjectConfig:()=>Promise.resolve(),window:{matchMedia:media(width),top:{matchMedia:media(topWidth)}}};
  vm.createContext(ctx);
  vm.runInContext(phoneCheck,ctx);
  await vm.runInContext(block,ctx);
  return selected;
}

test('desktop opens the branch default tray',async()=>{
  assert.deepEqual(await opened({width:1440}),['notes']);
  assert.deepEqual(await opened({width:1440,setting:'tasks'}),['tasks']);
  assert.deepEqual(await opened({width:1440,setting:'off'}),[]);
});

test('a phone opens no tray by itself',async()=>{
  assert.deepEqual(await opened({width:390}),[]);
  assert.deepEqual(await opened({width:390,setting:'tasks'}),[]);
});

test('inside the project window frame the outer page decides: a narrow dock on a desktop still opens it',async()=>{
  assert.deepEqual(await opened({width:420,bridge:true,topWidth:1440}),['notes']);
  assert.deepEqual(await opened({width:390,bridge:true,topWidth:390}),[]);
});
