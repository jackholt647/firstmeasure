const test=require('node:test'),assert=require('node:assert/strict');
const {referenceCatalog}=require('../public/measure/internal/editor_scripts/project_resources.js');
test('references preserve customer, technician and QA origins without personal identity',()=>{
 const result=referenceCatalog({manifest:{tech_notes:'Customer order',resubmissions:[{notes:'Customer correction',images:[{name:'photo.png'}]}],submission_sources:{notes:'Tech method',images:[{file_name:'source.png'}]},qa_threads:[{id:'q',history:[{role:'qa',text:'Old feedback',by_name:'Secret identity'}]}]},app_metadata:{qa_thread_drafts:{qa:{threads:[{id:'q',history:[{role:'qa',text:'Current feedback',images:['qa.png']},{role:'drafter',text:'Fixed',images:['fixed.png']}]}]}}}},name=>'/artifacts/'+name);
 assert.equal(result.filter(r=>r.role==='customer').length,3);assert.equal(result.filter(r=>r.role==='tech').length,4);assert.equal(result.filter(r=>r.role==='qa').length,1);assert.ok(!result.some(r=>r.notes==='Current feedback'));assert.ok(result.some(r=>r.role==='qa'&&r.src==='/artifacts/qa.png'));assert.ok(!JSON.stringify(result).includes('Secret identity'));assert.ok(!result.some(r=>r.notes==='Old feedback'));assert.ok(result.some(r=>r.src==='/artifacts/photo.png'));
});
test('QA thread text is left out of Files; only what QA attached is listed (FM-524)',()=>{
 const result=referenceCatalog({manifest:{qa_threads:[{id:'a',history:[{role:'qa',text:'-fix roof perimeter see eave.'},{role:'qa',text:'See photo',images:['qa1.png']}]}],manager_threads:[{id:'m',history:[{role:'qa',text:'Manager only text'},{role:'drafter',text:'Done'}]}]}},name=>'/artifacts/'+name);
 const qa=result.filter(r=>r.role==='qa');
 assert.deepEqual(qa.map(r=>r.src),['/artifacts/qa1.png']);assert.ok(!qa.some(r=>r.notes));
 assert.ok(result.some(r=>r.role==='tech'&&r.notes==='Done'));
});
