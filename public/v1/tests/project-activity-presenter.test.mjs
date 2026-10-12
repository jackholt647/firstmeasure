import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const box={Intl,Date,Map,Set,setTimeout,clearTimeout};
vm.runInNewContext(await readFile(new URL('../../libraries/project-trays/activity-presenter.js',import.meta.url),'utf8'),box);
const activity=box.FirstMateActivity,at='2026-10-12T04:00:00Z';
const c=activity.context();
c.users.set('crew',{id:'crew',name:'Casey Nguyen'});
c.plans.set('sales',{id:'sales',title:'Sales pipeline'});
c.nodes.set('todo',{id:'todo',plan_id:'sales',title:'Tighten downspout strap',actionable:true,metadata:{history:[{at,to:'completed',actor_user_id:'crew'}]}});
c.nodes.set('stage',{id:'stage',plan_id:'sales',title:'Installation',metadata:{history:[{at,to:'completed',actor_user_id:'crew'}]}});
test('real resource names, action emphasis, categories and precise actors',()=>{
 const todo=activity.describe({type:'work.node.completed',node_id:'todo',created_at:at,payload:{to_status:'completed'}},c);
 assert.equal(todo.text,'Completed Tighten downspout strap');assert.equal(todo.action,'Completed');assert.equal(todo.subject,'Tighten downspout strap');assert.equal(todo.category,'tasks');assert.equal(todo.actor.id,'crew');assert.equal(todo.actor.name,'Casey Nguyen');
 const rollup=activity.describe({type:'work.node.completed',node_id:'stage',created_at:at,payload:{to_status:'completed',reason:'child_rollup'}},c);
 assert.equal(rollup.category,'workflow');assert.equal(rollup.actor.id,'');
 for(const [verb,word] of [['started','Started'],['completed','Finished'],['scheduled','Scheduled']]){
  const e=activity.describe({type:'project.event_'+verb,payload:{event:{title:'Roof inspection and estimate',scheduled_by_user_id:'crew'}}},c);
  assert.equal(e.text,word+' Roof inspection and estimate');assert.equal(e.category,'schedule');assert.equal(e.actor.id,verb==='scheduled'?'crew':'');
 }
 assert.equal(activity.describe({type:'crew.checklist.item_completed',payload:{title:'Verify flashing'}},c).category,'field');
 c.media.set('report',{id:'report',file_name:'raw.pdf',metadata:{title:'Roof inspection report'},owner:{slot:'documents'}});
 assert.equal(activity.describe({type:'media.uploaded',payload:{media_id:'report'}},c).text,'Uploaded a document');
 assert.equal(activity.describe({type:'media.uploaded',payload:{media_id:'report'}},c).category,'documents');
 assert.equal(activity.describe({type:'expense.recorded',payload:{title:'Decking allowance',projected_cents:65000}},c).text,'Budgeted Decking allowance — $650.00');
 assert.equal(activity.describe({type:'payment.received',payload:{amount_cents:10000,payment:{created_by_user_id:'crew'}}},c).actor.id,'crew');
 assert.equal(activity.describe({type:'task.completed',payload:{summary:'Completed site inspection'}},c).text,'Completed site inspection');
 assert.equal(activity.describe({type:'report.created',payload:{summary:'Roof report completed'}},c).text,'Roof report completed');
 assert.equal(activity.describe({type:'project.updated',payload:{summary:'Updated project details'}},c).text,'Updated project details');
 assert.equal(activity.describe({type:'internal.unknown_machine_code'},c).text,'Project activity');
});
test('uploads summarize batches by recorded actor, kind and a bounded three-minute window',()=>{
 const rows=Array.from({length:8},(_,i)=>({id:'image'+i,type:'media.uploaded',created_at:new Date(Date.parse(at)+i*10000).toISOString(),actor_user_id:'crew',payload:{media_id:'image'+i,content_type:'image/jpeg',file_name:'internal-name-'+i+'.jpg'}}));
 rows.push(...Array.from({length:5},(_,i)=>({id:'doc'+i,type:'media.uploaded',created_at:new Date(Date.parse(at)+i*10000).toISOString(),actor_user_id:'crew',payload:{content_type:'application/pdf',file_name:'private-name-'+i+'.pdf'}})));
 rows.push({id:'later',type:'photo.uploaded',created_at:'2026-10-12T04:04:00Z',actor_user_id:'crew'}, {id:'other',type:'photo.uploaded',created_at:at,actor_user_id:'other'}, {id:'unknown',type:'photo.uploaded',created_at:at});
 const grouped=activity.groupUploads(rows,c),texts=grouped.map(e=>activity.describe(e,c).text);
 assert.equal(grouped.length,5);assert.equal(texts[0],'Uploaded 8 images');assert.equal(texts[1],'Uploaded 5 documents');assert.equal(texts[2],'Uploaded an image');assert.equal(grouped[0].actor_user_id,'crew');assert.ok(texts.every(t=>!t.includes('internal-name')&&!t.includes('private-name')));
});
test('communications emphasize channel and resolve the project contact',()=>{
 const catalog=activity.context();catalog.project={contacts:[{id:'taylor',name:'Taylor Chen',email:'taylor@example.test'}]};
 const entry=activity.describe({type:'communication.received',payload:{channel:'email',sender_address:'taylor@example.test'}},catalog);
 assert.equal(entry.action,'Received email');assert.equal(entry.subject,'from Taylor Chen');assert.equal(entry.text,'Received email from Taylor Chen');
 assert.equal(activity.describe({type:'sms.sent',payload:{summary:'Sent text message to Taylor Chen'}},catalog).action,'Sent text message');
});
test('notes follow authorized note roots with messaging separation disabled and never ensure a channel',async()=>{
 const catalog=activity.context();let reads=0;
 await activity.hydrate(catalog,[],{channels:{channels:{list:async(_oid,params)=>{assert.equal(params.initialize,false);return {channels:[{id:'channel',project_id:'project',separate_notes:false}]};},ensureProject:()=>{throw Error('No writes');}},messages:{list:async(_oid,_id,params)=>{reads++;assert.equal(params.view,'all');return {channel:{separate_notes:false},messages:[{id:'note1',kind:'text',text:'Weather confirmed',created_at:at,author:{id:'crew',name:'Casey Nguyen'},metadata:{project_note:true}},{id:'note2',text:'Homeowner update',created_at:at,author:{id:'crew'}},{id:'reply',text:'Reply',parent_id:'note1'},{id:'system',kind:'system',text:'Joined'},{id:'archived',text:'Archived',deleted_at:at}]};}}}},'org','project');
 const notes=activity.withNotes([],catalog);assert.equal(reads,1);assert.equal(notes.length,2);assert.equal(activity.describe(notes[0],catalog).category,'notes');assert.equal(activity.describe(notes[0],catalog).actor.id,'crew');assert.match(activity.describe(notes[0],catalog).text,/Weather confirmed/);
 const real={id:'created',_source:'work',type:'project.note.created',payload:{message_id:'note1'},created_at:at};assert.equal(activity.withNotes([real],catalog).length,2,'a real note creation and its record do not become duplicate rows');
});
test('merge only proven cross-source duplicates and preserve separate recorded actions',()=>{
 const work={id:'same',_source:'work',type:'work.node.completed',node_id:'todo',created_at:at,payload:{to_status:'completed'}};
 const audit={id:'audit',_source:'audit',type:'work.node.completed',data:{occurred_at:at,actor_user_id:'crew',metadata:{backed_work_event_id:'same'}}};
 const distinct={id:'same',_source:'audit',type:'file.uploaded',data:{summary:'Uploaded roof photos'},created_at:at};
 const rows=activity.merge([work,audit,distinct]);assert.equal(rows.length,2);assert.equal(rows.find(e=>e._source==='work').actor_user_id,'crew');assert.equal(rows.find(e=>e._source==='audit').type,'file.uploaded');
 const repeated={...work,id:'second',created_at:'2026-10-12T04:01:00Z'};
 assert.equal(activity.merge([work,repeated,audit]).length,2);
});
test('authorized read-only hydration tolerates denied lookups and names native deliveries',async()=>{
 const catalog=activity.context(),seen=[];
 const events=[{type:'material.delivery.completed',payload:{order_id:'order',delivery_id:'delivery'},created_at:at}];
 await activity.hydrate(catalog,events,{platform:{users:{list:async()=>{throw Error('403');}},work:{plans:()=>{throw Error('Must never ensure a pipeline');}}},materials:{orders:{get:async()=>({order:{id:'order',material_list_id:'list'}}),deliveries:async()=>({deliveries:[{id:'delivery',created_at:at,created_by_user_id:'crew',received_by:{name:'Casey Nguyen'}}]})},projects:{list:async()=>({material_lists:[{id:'list',title:'Chen roof system'}]})}}},'org','project');
 const entry=activity.describe(events[0],catalog);assert.equal(entry.text,'Received Chen roof system');assert.equal(entry.actor.id,'crew');assert.equal(entry.actor.name,'Casey Nguyen');assert.equal(entry.category,'scope');assert.deepEqual(seen,[]);
 assert.equal(activity.describe({...events[0],created_at:'2026-10-13T04:00:00Z'},catalog).actor.id,'','do not reuse a delivery creator as the actor of later events');
});
