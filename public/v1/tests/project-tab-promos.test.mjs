import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile, readdir} from 'node:fs/promises';
// Project tab promos (docs/project-tab-promos.md): the render engine in libraries/apps/tab-promos/project.js, fed the
// tab_promo entries of the config library snapshot as GET /v1/config-library/read/tab_promo serves them.
const src=await readFile(new URL('../../libraries/apps/tab-promos/project.js',import.meta.url),'utf8');
const dir=new URL('../config-library/snapshot/tab_promo/',import.meta.url);
const entries=await Promise.all((await readdir(dir)).filter(name=>name.endsWith('.json')).map(async name=>{const file=JSON.parse(await readFile(new URL(name,dir),'utf8'));return {id:file.id,revision:file.revision,title:file.title,data:file.data};}));
async function setup(values={}){
  const apps=[],requested=[];
  const window={Portal:{capabilities:{value:(key,fallback)=>values[key]??fallback},util:{injectCSS(){}}},FirstMateEmbeddableApps:{registerApp:app=>apps.push(app)},
    fetch:async url=>{requested.push(url);return {ok:true,json:async()=>({ok:true,kind:'tab_promo',entries})};}};
  vm.runInNewContext(src,{window});
  await window.FirstMateTabPromos.ready;
  return {window,app:apps[0],values,requested};
}
test('promos are read from the library and images are library assets',async()=>{const {app,requested,values}=await setup({'firstmeasure.materials_promo':true});assert.deepEqual(requested,['/v1/config-library/read/tab_promo']);assert.equal(app.id,'project.materials_promo');const root={innerHTML:''};app.mount({roots:{main:root},materialsEnabled:false});assert.match(root.innerHTML,/src="\/v1\/config-library\/assets\/[0-9a-f]{64}"/);assert.doesNotMatch(root.innerHTML,/tab-promos\/images/);assert.ok(values);});
test('promo is off by default, requires explicit boolean opt-in, and does not require expanded access',async()=>{const {app,values}=await setup();assert.equal(app.enabled({materialsEnabled:false}),false);values['firstmeasure.materials_promo']='true';assert.equal(app.enabled({}),false);values['firstmeasure.materials_promo']=true;assert.equal(app.enabled({materialsEnabled:false}),true);});
test('real Materials wins even if both flags are set',async()=>{const {app,values}=await setup({'firstmeasure.materials_promo':true,'platform.materials':true});assert.equal(app.enabled({}),false);values['platform.materials']=false;assert.equal(app.enabled({materialsEnabled:true}),false);});
test('mount is read-only and clears its content after eligibility is revoked',async()=>{const {app,values}=await setup({'firstmeasure.materials_promo':true});const root={innerHTML:''};const handle=app.mount({roots:{main:root},materialsEnabled:false});assert.match(root.innerHTML,/Your products/);assert.doesNotMatch(root.innerHTML,/<form|<input|<button/);values['firstmeasure.materials_promo']=false;handle.activate();assert.equal(root.innerHTML,'');});
test('future promo definitions register independently and reject duplicate ids',async()=>{const {window}=await setup();const base=window.FirstMateTabPromos.definitions()[0];window.FirstMateTabPromos.register({...base,id:'next_promo',tab_id:'next',flag:'firstmeasure.next_promo'});assert.equal(window.FirstMateTabPromos.definitions().length,2);assert.throws(()=>window.FirstMateTabPromos.register(base),/Duplicate/);});
test('without the library the page still loads and offers no promo',async()=>{const apps=[];const window={Portal:{capabilities:{value:()=>true},util:{injectCSS(){}}},FirstMateEmbeddableApps:{registerApp:app=>apps.push(app)}};vm.runInNewContext(src,{window});assert.equal((await window.FirstMateTabPromos.ready).length,0);assert.equal(apps.length,0);});
