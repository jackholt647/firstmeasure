const test=require('node:test'),assert=require('node:assert/strict');
const {mergeSubmissionSources}=require('../public/measure/internal/editor_scripts/project_resources.js');
// Sources & Notes (report configuration) holds only what the tech adds there; Resources uploads and screenshots
// stay in Resources (Jack, 2026-11-01). Copies earlier versions merged in come out again.
const upload={name:'internal-resource-v2-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-street.png',original_name:'Street view.png',role:'tech'};
const markup={name:'internal-markup-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-1-x.json'};
test('Resources uploads are never added to Sources & Notes',async()=>{
 const state={};
 await mergeSubmissionSources(state,[upload,markup],async()=>({notes:'Siding checked'}));
 assert.deepEqual(state.finalizeSources,{images:[],notes:''});
});
test('images and notes merged from Resources by earlier versions come out; what the tech added stays',async()=>{
 const byHand={dataUrl:'data:image/png;base64,AA',name:'gable.png'};
 const state={finalizeSources:{images:[{resource_name:upload.name,url:'https://x/a',name:'Street view.png',role:'tech'},byHand,null],
  notes:'Pitch from Street View.\n\nStreet view.png:\nSiding checked'}};
 await mergeSubmissionSources(state,[upload,markup],async()=>({notes:'Siding checked'}));
 assert.deepEqual(state.finalizeSources.images,[byHand]);
 assert.equal(state.finalizeSources.notes,'Pitch from Street View.');
});
test('a merged note that was all there was leaves the notes empty, and an unreadable markup keeps the notes',async()=>{
 const state={finalizeSources:{images:[],notes:'Street view.png:\nSiding checked'}};
 await mergeSubmissionSources(state,[upload,markup],async()=>({notes:'Siding checked'}));
 assert.equal(state.finalizeSources.notes,'');
 const kept={finalizeSources:{images:[],notes:'Street view.png:\nSiding checked'}},warn=console.warn;console.warn=()=>{};
 try{await mergeSubmissionSources(kept,[upload,markup],async()=>{throw Error('Resource request failed (500).');});}finally{console.warn=warn;}
 assert.equal(kept.finalizeSources.notes,'Street view.png:\nSiding checked');
});
