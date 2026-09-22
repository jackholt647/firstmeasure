import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../libraries/apps/settings/company.js', import.meta.url), 'utf8');
const implementation = source.slice(source.indexOf('      const setScopeSaveStatus ='), source.indexOf('      const drawEditor ='));
function editor(save) {
  return new Function('save', `
    let dirty=false, scopeEditRevision=0, scopeSaveTimer, scopeSavePromise, scopeSaveStatus;
    let selectedId='scope', editorSection='details', draftDefinition={id:'scope',name:'Original'};
    let templates=[{id:'scope',version:1,definition:draftDefinition}];
    let jsonInput=null;
    const orgId='org',branchId='default';
    const paneScopeTemplates={querySelector:key=>key==='[data-scope-json]'?jsonInput:null};
    const window={PlatformAPI:{scopes:{save}},dispatchEvent(){}};
    const CustomEvent=class {};
    const definitionFor=t=>structuredClone(t.definition);
    ${implementation}
    return {save:saveScopeDraft, edit:name=>{draftDefinition={...draftDefinition,name};dirty=true;scopeEditRevision++;},
      json:value=>{jsonInput={value};dirty=true;scopeEditRevision++;},
      state:()=>({dirty,status:scopeSaveStatus,draft:draftDefinition,version:templates[0].version})};
  `)(save);
}

test('autosave serializes changes made during an in-flight save and advances expected version', async () => {
  const calls=[];
  const ui=editor((_org,_branch,_id,body)=>new Promise(resolve=>calls.push({body,resolve})));
  ui.edit('First');
  const pending=ui.save();
  ui.edit('Second');
  calls[0].resolve({template:{id:'scope',version:2,definition:{id:'scope',name:'First'}}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,2);
  assert.equal(calls[1].body.expected_version,2);
  assert.equal(calls[1].body.name,'Second');
  calls[1].resolve({template:{id:'scope',version:3,definition:{id:'scope',name:'Second'}}});
  assert.equal(await pending,true);
  assert.equal(ui.state().dirty,false);
  assert.equal(ui.state().draft.name,'Second');
});

test('invalid edits and save failures remain unsaved and block navigation flush', async () => {
  let calls=0;
  const ui=editor(async()=>{calls++;throw Error('Version conflict');});
  ui.edit('');
  assert.equal(await ui.save(),false);
  assert.equal(calls,0);
  ui.edit('Valid');
  assert.equal(await ui.save(),false);
  assert.equal(ui.state().dirty,true);
  assert.match(ui.state().status,/Version conflict/);
  ui.json('{');
  assert.equal(await ui.save(),false);
  assert.equal(calls,1);
});

test('an invalid JSON edit during a save cannot be marked saved by its older response', async () => {
  let finish;
  const ui=editor(()=>new Promise(resolve=>{finish=resolve;}));
  ui.edit('Valid');
  const pending=ui.save();
  ui.json('{');
  finish({template:{id:'scope',version:2,definition:{id:'scope',name:'Valid'}}});
  assert.equal(await pending,false);
  assert.equal(ui.state().dirty,true);
  assert.match(ui.state().status,/Not saved/);
});

test('artifact autosave keeps the editor open and uses the returned version for subsequent edits', async () => {
  const source=readFileSync(new URL('../../libraries/apps/settings/scope-artifacts.js',import.meta.url),'utf8');
  const body=source.slice(source.indexOf('      const save=async()=>{'),source.indexOf('      leaveEditor=async()=>{'));
  const calls=[];
  const ui=new Function('request',`
    let revision=0,savedRevision=0,saveTimer,saving,selected,editing=true;
    const creating=false,type='todos',fields=['title'],itemDraft=[],usage=null;
    const config={title:'Before'},item={id:'todo',config:{title:'Before'}},data={template:{version:1}};
    const input={dataset:{saFormat:'text',saField:'title'},value:'Before'};
    const error={textContent:''},host={querySelector:()=>error},form={querySelectorAll:()=>[input]};
    const options={},json=JSON.stringify,root={PlatformAPI:{scopes:{saveArtifact:request}}};
    ${body}
    return {save,edit:title=>{input.value=title;revision++;},state:()=>({editing,config,version:data.template.version,status:error.textContent})};
  `)(async(_org,_branch,_id,payload)=>{calls.push(payload);return {template:{version:payload.expected_version+1},artifact_id:'todo'};});
  ui.edit('After');
  assert.equal(await ui.save(),true);
  assert.equal(ui.state().editing,true);
  assert.equal(ui.state().config.title,'After');
  assert.equal(await ui.save(),true);
  assert.equal(calls.length,1);
  ui.edit('Final');
  assert.equal(await ui.save(),true);
  assert.equal(calls[1].expected_version,2);
});
