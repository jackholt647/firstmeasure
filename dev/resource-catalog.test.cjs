const test=require('node:test'),assert=require('node:assert/strict');
const {referenceCatalog}=require('../public/measure/internal/editor_scripts/project_resources.js');
test('references preserve customer, technician and QA origins without personal identity',()=>{
 const result=referenceCatalog({manifest:{tech_notes:'Customer order',resubmissions:[{notes:'Customer correction',images:[{name:'photo.png'}]}],submission_sources:{notes:'Tech method',images:[{file_name:'source.png'}]},qa_threads:[{id:'q',history:[{role:'qa',text:'Old feedback',by_name:'Secret identity'}]}]},app_metadata:{qa_thread_drafts:{qa:{threads:[{id:'q',history:[{role:'qa',text:'Current feedback',images:['qa.png']},{role:'drafter',text:'Fixed',images:['fixed.png']}]}]}}}},name=>'/artifacts/'+name);
 assert.equal(result.filter(r=>r.role==='customer').length,3);assert.equal(result.filter(r=>r.role==='tech').length,4);assert.equal(result.filter(r=>r.role==='qa').length,2);assert.ok(result.some(r=>r.notes==='Current feedback'));assert.ok(!JSON.stringify(result).includes('Secret identity'));assert.ok(!result.some(r=>r.notes==='Old feedback'));assert.ok(result.some(r=>r.src==='/artifacts/photo.png'));
});
