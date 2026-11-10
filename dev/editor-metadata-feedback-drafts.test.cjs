// FM-357: the QA-notes overlay refreshes a small feedback bundle after every load and on every focus.
// Its app_metadata holds only the QA drafts, and the overlay used to put that in place of the project
// the editor had loaded. "Save submission notes" posts the loaded copy back as the whole
// app_metadata.json, so a tab switch before it deleted the roof and walls (26 production orders).
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function slicer(file){
 const source=fs.readFileSync(file,'utf8');
 return start=>{
  const at=source.indexOf(start);assert.ok(at>=0,start);
  let depth=0;for(let i=source.indexOf('{',at);i<source.length;i++){if(source[i]==='{')depth++;else if(source[i]==='}'&&--depth===0)return source.slice(at,i+1);}
  throw Error('unterminated '+start);
 };
}
const notes=slicer('public/measure/internal/editor_scripts/notes_overlay.js');
const report=slicer('public/measure/internal/editor_scripts/report.js');
const model=()=>({geometry:{points:[{x:1,y:2,z:3}]},exteriorsWalls:{wallEdits:{w1:{faces:[[0,1,2]]}}},editorHistory:['editor-history-a.bin'],qa_thread_drafts:{qa:{threads:[{id:'old'}]}}});
function editor({loaded,stored,storedError}={}){
 const calls=[];
 const ctx={JSON,Object,Array,String,Error,encodeURIComponent,currentProjectId:'exteriors_x',currentProjectLoadedAppMetadata:loaded,
  firstMeasureFetchJson:async(path,init={})=>{calls.push({path,method:init.method||'GET',body:init.body&&JSON.parse(init.body)});
   if((init.method||'GET')==='GET'){if(storedError)throw Error(storedError);return stored;}
   return {success:true};}};
 ctx.window=ctx;vm.createContext(ctx);
 vm.runInContext([notes('function cloneJson('),notes('function getDraftMetaKey('),notes('function adoptFeedbackDrafts('),
  report('function cloneSubmissionSourcesValue('),report('async function getSubmissionSourceMetadataBase('),report('async function persistSubmissionSourceMetadata(')].join('\n'),ctx);
 return {ctx,calls,saves:()=>calls.filter(c=>c.method==='POST')};
}
test('a feedback refresh keeps the loaded model, and saving submission notes after it keeps the roof and walls',async()=>{
 assert.doesNotMatch(notes('async function refreshForFolder('),/currentProjectLoadedAppMetadata\s*=/,'the refresh only merges its drafts');
 const {ctx,calls,saves}=editor({loaded:model()});
 ctx.adoptFeedbackDrafts('exteriors_x',{qa_thread_drafts:{qa:null}});
 assert.deepEqual(JSON.parse(JSON.stringify(ctx.currentProjectLoadedAppMetadata)),{...model(),qa_thread_drafts:{qa:null}});
 await ctx.persistSubmissionSourceMetadata('exteriors_x',{});
 assert.equal(calls.filter(c=>c.method==='GET').length,0,'a loaded model needs no extra read');
 assert.equal(saves().length,1);assert.equal(saves()[0].path,'/projects/exteriors_x/editor/save');
 assert.deepEqual(saves()[0].body.metadata,{...model(),qa_thread_drafts:{qa:null},submission_sources:{}});
});
test('feedback for another project, or with no drafts, leaves the loaded model alone',()=>{
 const {ctx}=editor({loaded:model()});
 ctx.adoptFeedbackDrafts('exteriors_other',{qa_thread_drafts:{qa:null}});
 ctx.adoptFeedbackDrafts('exteriors_x',{});
 assert.deepEqual(JSON.parse(JSON.stringify(ctx.currentProjectLoadedAppMetadata)),model());
});
test('with no model loaded, submission notes are saved onto the stored model, never as the whole file',async()=>{
 const stored=model();
 const {ctx,calls,saves}=editor({loaded:{qa_thread_drafts:{qa:null}},stored});
 await ctx.persistSubmissionSourceMetadata('exteriors_x',{notes:'Siding checked',images:[]});
 assert.equal(calls[0].path,'/projects/exteriors_x/artifacts/app_metadata.json');
 assert.deepEqual(saves()[0].body.metadata,{...stored,qa_thread_drafts:{qa:null},submission_sources:{notes:'Siding checked',images:[]}});
 const failed=editor({loaded:{qa_thread_drafts:[]},storedError:'FirstMeasure request failed (502).'});
 await assert.rejects(failed.ctx.persistSubmissionSourceMetadata('exteriors_x',{}),/502/);
 assert.equal(failed.saves().length,0,'an unreadable model is not overwritten');
});
