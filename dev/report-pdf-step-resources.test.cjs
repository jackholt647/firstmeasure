// FM-313: the PDF step of Report Configuration opens whatever the project's resources do. Before, any
// failure reading them (expired login, storage error, one unreadable markup) threw out of
// renderFinalizePage, and the tech got "Error rendering preview." and no way to make the PDF.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {mergeSubmissionSources}=require('../public/measure/internal/editor_scripts/project_resources.js');
const source=fs.readFileSync('public/measure/internal/editor_scripts/report.js','utf8');
function slice(start){
 const at=source.indexOf(start);assert.ok(at>=0,start);
 let depth=0;for(let i=source.indexOf('{',at);i<source.length;i++){if(source[i]==='{')depth++;else if(source[i]==='}'&&--depth===0)return source.slice(at,i+1);}
 throw Error('unterminated '+start);
}
const fakeContainer=()=>({innerHTML:'',querySelector(){return null;},querySelectorAll(){return [];}});
function renderPdfStep(state,mergeSubmission){
 const warnings=[],container=fakeContainer();
 const ctx=vm.createContext({console:{warn:(...a)=>warnings.push(a),error(){}},setTimeout(){},URLSearchParams,location:{search:''},reportConfigState:state,
  window:{ProjectResources:{mergeSubmission},location:{search:''}},shouldIncludeGutters:()=>false,getMissingRequiredGutterStories:()=>[],GUTTER_DIRECTION_LABELS:{},
  isQaPortalPdfReviewMode:()=>false,escapeHtml:v=>String(v)});
 vm.runInContext(slice('async function mergeProjectResourcesIntoSources(')+'\n'+slice('async function renderFinalizePage('),ctx);
 return ctx.renderFinalizePage(container).then(()=>({html:container.innerHTML,warnings}));
}
test('the PDF step still opens when the project files cannot be listed, and says why',async()=>{
 const {html,warnings}=await renderPdfStep({folderId:'fullhouse_x'},async()=>{throw Error('Internal login required.');});
 assert.match(html,/Generating PDF preview/);assert.match(html,/finalSubmitBtn/);
 assert.match(html,/finResourcesWarning/);assert.match(html,/Internal login required\./);
 assert.equal(warnings.length,1);
});
test('the PDF step shows no warning when the project files are added',async()=>{
 const {html}=await renderPdfStep({folderId:'fullhouse_x'},async()=>{});
 assert.match(html,/Generating PDF preview/);assert.doesNotMatch(html,/finResourcesWarning/);
});
test('an empty entry saved in Sources & Notes does not stop the PDF step',async()=>{
 const state={folderId:'fullhouse_x',finalizeSources:{images:[null,{dataUrl:'data:image/png;base64,AA',name:'a.png'}],notes:''}};
 const {html}=await renderPdfStep(state,async()=>{});
 assert.match(html,/data:image\/png;base64,AA/);assert.equal(state.finalizeSources.images.length,1);
});
test('every caller of the merge goes through the guard, and the error page names the reason',()=>{
 assert.equal((source.match(/ProjectResources\?\.mergeSubmission\(/g)||[]).length,1,'only mergeProjectResourcesIntoSources calls it');
 assert.match(slice('async function uploadSubmissionSourcesAndPersist('),/await mergeProjectResourcesIntoSources\(state\)/);
 assert.match(source,/Error rendering preview: \$\{escapeHtml\(e\?\.message/);
});
const upload={name:'internal-resource-v2-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-site.png',original_name:'Site.png',role:'tech'};
const other={name:'internal-resource-v2-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb-roof.png',original_name:'Roof.png',role:'tech'};
const markup=id=>({name:`internal-markup-${id}-1-x.json`});
test('one unreadable markup leaves out that note and keeps every upload',async()=>{
 const state={},bad=markup('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),good=markup('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
 const warn=console.warn;console.warn=()=>{};
 try{await mergeSubmissionSources(state,[upload,other,bad,good],async name=>{if(name===bad.name)throw Error('Resource request failed (500).');return {notes:'Ridge checked'};},name=>'https://x/'+name);}
 finally{console.warn=warn;}
 assert.deepEqual(state.finalizeSources.images.map(i=>i.name),['Site.png','Roof.png']);
 assert.match(state.finalizeSources.notes,/Roof\.png:\nRidge checked/);
});
test('an empty entry saved earlier does not stop the merge',async()=>{
 const state={finalizeSources:{images:[null],notes:''}};
 await mergeSubmissionSources(state,[upload],async()=>({}),name=>'https://x/'+name);
 assert.deepEqual(state.finalizeSources.images.map(i=>i.name),['Site.png']);
});
