const test=require('node:test'),assert=require('node:assert/strict');
const {referenceCatalog}=require('../public/measure/internal/editor_scripts/project_resources.js');
test('references preserve customer, technician and QA origins without personal identity',()=>{
 const result=referenceCatalog({manifest:{tech_notes:'Customer order',resubmissions:[{notes:'Customer correction',images:[{name:'photo.png'}]}],submission_sources:{notes:'Tech method',images:[{file_name:'source.png'}]},qa_threads:[{id:'q',history:[{role:'qa',text:'Old feedback',by_name:'Secret identity'}]}]},app_metadata:{qa_thread_drafts:{qa:{threads:[{id:'q',history:[{role:'qa',text:'Current feedback',images:['qa.png']},{role:'drafter',text:'Fixed',images:['fixed.png']}]}]}}}},name=>'/artifacts/'+name);
 assert.equal(result.filter(r=>r.role==='customer').length,3);assert.equal(result.filter(r=>r.role==='tech').length,4);assert.equal(result.filter(r=>r.role==='qa').length,2);assert.ok(result.some(r=>r.notes==='Current feedback'));assert.ok(!JSON.stringify(result).includes('Secret identity'));assert.ok(!result.some(r=>r.notes==='Old feedback'));assert.ok(result.some(r=>r.src==='/artifacts/photo.png'));
});
test('Full House customer references are typed by their stored file, not their "Structure N · view" label',()=>{
 const {fileExtension,isVideoFile,coreViews}=require('../public/measure/internal/editor_scripts/project_resources.js');
 // The shape firstmeasure/api.ts writes for a Full House order.
 const result=referenceCatalog({manifest:{elevation_photos:[{file_name:'customer-reference-0.jpg',original_name:'Structure 1 · front-left',elevation_view:'front-left',structure:0}],exterior_reference_videos:[{file_name:'customer-reference-8.mov',original_name:'Structure 1 · video walkaround',content_type:'video/quicktime',view:'orbital_video',structure:0}]}},name=>'/v1/firstmeasure/projects/p/artifacts/'+name);
 const photo=result.find(r=>r.slot==='front-left'),video=result.find(r=>r.original_name==='Structure 1 · video walkaround');
 assert.equal(photo.original_name,'Structure 1 · front-left');assert.equal(fileExtension(photo),'jpg');assert.equal(fileExtension(video),'mov');assert.ok(isVideoFile(video));assert.ok(!isVideoFile(photo));
 assert.equal(coreViews(result).find(v=>v.slot===null).file,video);
 // A label's own extension still wins; files with no extension anywhere stay unrecognised.
 assert.equal(fileExtension({original_name:'Front.PNG',name:'internal-resource-v2-x-front.bin'}),'png');
 assert.equal(fileExtension({original_name:'Signed',src:'https://cdn.example/a/photo.webp?X-Sig=1'}),'webp');
 assert.equal(fileExtension({original_name:'Customer notes',name:'reference-note-order'}),'');
 assert.equal(fileExtension({original_name:'Pasted',src:'data:image/png;base64,AAAA'}),'');
});
// FM-340: a Full House order with only a walkthrough video offered the video as a "Customer photo" for every
// elevation slot, and the slot's <img> could not show it. Elevation photos are photos; frames saved from it are artifacts.
test('elevation photo choices leave out the customer walkthrough video and keep photos',()=>{
 const {photoReferences}=require('../public/measure/internal/editor_scripts/project_resources.js');
 const result=referenceCatalog({manifest:{tech_notes:'Order notes',elevation_photos:[{file_name:'customer-reference-1.jpg',original_name:'Structure 1 · front',elevation_view:'front',structure:0}],exterior_reference_videos:[{file_name:'customer-reference-0.mov',original_name:'Structure 1 · video walkaround',content_type:'video/quicktime',view:'orbital_video',structure:0}],resubmissions:[{images:[{name:'internal-resource-v2-x-front.png',resource_name:'internal-resource-v2-x-front.png'}]}]}},name=>'/v1/firstmeasure/projects/p/artifacts/'+name);
 const photos=photoReferences(result,[{name:'internal-resource-v2-x-front.png'}]);
 assert.deepEqual(photos.map(f=>f.name),['customer-reference-1.jpg'],'no video, no notes, and no reference already listed as a stored artifact');
 assert.ok(result.some(f=>f.name==='customer-reference-0.mov'),'the video is still a Resources reference');
});
