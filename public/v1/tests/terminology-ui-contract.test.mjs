import assert from 'node:assert/strict';import test from 'node:test';import {readFile} from 'node:fs/promises';import vm from 'node:vm';import {execFileSync} from 'node:child_process';
const read=path=>readFile(new URL(path,import.meta.url),'utf8');
const catalog=await read('../../libraries/platform-terminology/platform-terminology.js');
const manifest=await read('../../libraries/apps/firstmate-apps-manifest.js');
const editor=await read('../../libraries/platform-terminology/editor.js');
test('every registered portal and project surface declares a catalogued display key',()=>{
 const apps=[],window={FirstMateEmbeddableApps:{registerManifest:app=>apps.push(app),registerApp(){}}};
 vm.runInNewContext(catalog,{window});vm.runInNewContext(manifest,{window,document:{currentScript:{src:'https://example.test/libraries/apps/firstmate-apps-manifest.js'}},URL});
 const keys=new Set(window.PlatformTerminology.CATALOG.flatMap(group=>group.terms.map(row=>`${group.id}.${row.key}`)));
 const tabs=apps.filter(app=>['portal_tab','project_modal_app'].includes(app.kind));assert.ok(tabs.length>=49);assert.deepEqual(tabs.filter(app=>!keys.has(app.terminologyKey)).map(app=>app.id),[]);
});
test('source terminology references are covered by the catalog',()=>{execFileSync(process.execPath,[new URL('../scripts/terminology-audit.mjs',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')],{stdio:'pipe'});});
test('editor uses shared FirstMate conversations and one locale-scoped persistence path',()=>{
 assert.match(editor,/api\.terminologyAssistant\.send/);assert.match(editor,/FirstMateAgentChat/);assert.match(editor,/localized_labels/);assert.doesNotMatch(editor,/workforce\.saveConfiguration|work\.saveConfiguration|terminologyAgent\.ask/);
 assert.match(editor,/data-sort/);assert.match(editor,/data-reset/);assert.match(editor,/role="tooltip"/);assert.match(editor,/type="search"/);
});
test('shared resolver handles empty navigation placeholders safely',()=>{
 const window={dispatchEvent(){},PlatformLanguage:{term(){throw Error('Must not resolve an empty key');}}};vm.runInNewContext(catalog,{window});assert.equal(window.PlatformTerminology.get(undefined,'Workspace'),'Workspace');
});

test('an older organization load cannot replace newer organization terminology',async()=>{
 const pending=new Map();const window={dispatchEvent(){},PlatformScheduling:{loadBranchConfig:org=>new Promise(resolve=>pending.set(org,resolve))},PlatformAPI:{terminologyConfiguration:async org=>({mappings:{localized_labels:{'en-US':{projects:{project:org}}}}})}};
 vm.runInNewContext(catalog,{window,CustomEvent:class{constructor(type,init){this.type=type;this.detail=init.detail;}}});
 const first=window.PlatformTerminology.load('first'),second=window.PlatformTerminology.load('second');
 pending.get('second')({mappings:{}});await second;pending.get('first')({mappings:{}});await first;
 assert.equal(window.PlatformTerminology.current().orgId,'second');assert.equal(window.PlatformTerminology.current().mappings.localized_labels['en-US'].projects.project,'second');
});
