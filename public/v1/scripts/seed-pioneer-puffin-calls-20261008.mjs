/** Add transport-free call examples to the Pioneer Puffin development sandbox. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const ORG_ID='org_983c8e17cd313149';
const SOURCE='pioneer_puffin_calls_20261008';
const apply=process.argv.includes('--apply');
const root=process.env.FIRSTMEASURE_RUNTIME_ROOT||'/opt/firstmeasure/current/public/v1';
if(process.argv.includes('--service-env')){
  const pid=execFileSync('systemctl',['show','firstmeasure-development-web.service','-p','MainPID','--value'],{encoding:'utf8'}).trim();
  if(!/^\d+$/.test(pid)||pid==='0')throw new Error('Development web service is not running.');
  for(const item of readFileSync(`/proc/${pid}/environ`,'utf8').split('\0')){
    const equals=item.indexOf('=');if(equals>0)process.env[item.slice(0,equals)]=item.slice(equals+1);
  }
}
if(process.env.FIRSTMEASURE_DATA_ENVIRONMENT!=='development')throw new Error('Refusing to run outside development data.');
process.chdir(root);
const load=async name=>import(pathToFileURL(path.join(root,'dist',name)).href);
const platform=await load('platform/storage.js');
const calls=await load('comms/calls/storage.js');
const callLists=await load('internal/crm/call_lists.js');
const followUps=await load('work/followups.js');
const work=await load('work/storage.js');
const org=await platform.readOrganization(ORG_ID);
if(!String(org.name||'').startsWith('Pioneer Puffin Test Co')||org.metadata?.sandbox_test_org!==true)throw new Error('Unexpected target organization.');

const hash=value=>createHash('sha256').update(`${ORG_ID}:${SOURCE}:${value}`).digest('hex');
const id=(prefix,value)=>`${prefix}_${hash(value).slice(0,32)}`;
const at=value=>new Date(value).toISOString();
const projects=await platform.listDocuments(ORG_ID,'projects');
const users=await platform.listDocuments(ORG_ID,'users');
const byCustomer=new Map();
for(const project of projects){
  const contact=project.data?.contacts?.[0];
  if(project.data?.workflow_state!=='project'||!project.data?.tags?.includes('Synthetic')||!contact)continue;
  if(!String(contact.email||'').endsWith('@example.test')||!/^202-555-01\d\d$/.test(String(contact.phone||'')))continue;
  byCustomer.set(contact.name,{project,contact});
}
const byStaff=new Map(users.map(row=>[row.data?.name||row.data?.display_name,row]));
for(const name of ['Sam Rivera','Morgan Lee','Alex Martinez'])if(!byStaff.has(name))throw new Error(`Missing sample staff: ${name}`);

const scriptSpecs=[
  {key:'new-inquiry',title:'New roof inquiry and inspection booking',sections:[
    ['Opening','Hi, this is Sam with Pioneer Puffin. Is now still a good time for a few questions about the roof? I can explain what an inspection covers and help find a visit window.'],
    ['Understand the issue','Ask where the issue appears, when it started, whether water is entering the home, and whether any temporary protection is in place. Do not diagnose the roof by phone. If there is active water intrusion, flag it for same-day review.'],
    ['Set expectations','Confirm the property address, roof access, the person who will meet the inspector, and a practical arrival window. Explain that the written scope and price follow the site review. Repeat the agreed next step before ending the call.']
  ],questions:['Where are you seeing the leak or damage?','Is water entering the home right now?','Is the roof safe to access, and are there gates, pets, or parking details we should know?','What time can someone meet the inspector?']},
  {key:'estimate-review',title:'Estimate review and options',sections:[
    ['Opening','I am calling to walk through the written roof estimate. Have you had a chance to read the scope, and is there a section you would like to start with?'],
    ['Walk the scope','Separate base roof work from options such as a detached garage, ventilation, and gutters. Name the materials and the included disposal and cleanup. If a detail is uncertain, promise a revised written line item instead of guessing.'],
    ['Decision and next step','Ask which options the customer wants priced or held. Summarize any open choice, who owns it, and when the revised estimate or sample will arrive. Leave room for the customer to decide without pressure.']
  ],questions:['Which part of the scope needs clarification?','Would you like the garage or gutter option shown separately?','Are there color or ventilation choices still open?','When would a follow-up be useful?']},
  {key:'install-readiness',title:'Pre-install access confirmation',sections:[
    ['Opening','Hi, this is Alex with Pioneer Puffin, checking the practical details for your roof work. Do you have a few minutes to confirm access and the day-of plan?'],
    ['Confirm the site','Confirm start window, driveway and dumpster space, side gates, pets, fragile landscaping, power access, and who can answer crew questions. Give the weather decision time and how an update will arrive.'],
    ['Close','Read back any access instruction. Explain that the crew lead will confirm arrival and identify where materials and debris will go. Add special instructions to the project before the workday.']
  ],questions:['Can the driveway be clear before the crew arrives?','Which gates or areas need access?','Are there pets, plants, or surfaces we should protect?','Who is the best contact on the workday?']},
  {key:'quality-check',title:'Post-install walkthrough and quality check',sections:[
    ['Opening','Hi, this is Morgan checking in after the work. Is this a good time to hear how the roof and cleanup look from your side?'],
    ['Listen and verify','Ask about debris, gutters, downspouts, flashing, and any location the customer wants reviewed. Capture exact location and conditions, such as rain direction or when a drip occurs. Do not promise that an issue is fixed before a crew member checks it.'],
    ['Agree on follow-through','Name the person who will inspect, a specific visit or callback window, and how the customer will receive an update. Read back the concern and log a follow-up.']
  ],questions:['Does the finished work and cleanup match what you expected?','Is there any specific corner or detail you want us to inspect?','Can you safely share a photo of the spot?','What callback window works for you?']},
  {key:'voicemail',title:'Voicemail and missed-call callback',sections:[
    ['Voicemail','Hi, this is Morgan with Pioneer Puffin returning your call about your roof project. Please call our office when convenient, or reply to the message I sent through your existing thread. I will try you again at the agreed time. Thank you.'],
    ['After the attempt','Log that there was no conversation. Record voicemail only if a message was actually left. Avoid repeating sensitive project details on an unidentified voicemail. Set a specific callback time or mark that the customer requested no further calls.']
  ],questions:['Was a voicemail actually left?','What number and time should be used for the next attempt?','Did the customer request another channel or no calls?']}
];
const followUpSpecs=[
  {key:'jordan-revised-estimate',customer:'Jordan Rivera',owner:'Sam Rivera',title:'Call Jordan about revised house and garage estimate',description:'Confirm the separate garage price and whether the color choice is ready; send the revised written scope before the call.',due:'2026-10-09T10:00:00-04:00',related_call:'jordan-garage'},
  {key:'taylor-adjuster-update',customer:'Taylor Chen',owner:'Sam Rivera',title:'Call Taylor for adjuster response',description:'Ask whether the adjuster accepted the drip-edge and roof measurement lines. Request the written response before changing scope.',due:'2026-10-12T11:00:00-04:00',related_call:'taylor-voicemail'},
  {key:'riley-attic-photo',customer:'Riley Patel',owner:'Sam Rivera',title:'Call Riley after reviewing attic leak photo',description:'Review the uploaded hallway and chimney-area photo with the inspection notes; agree on a safe next visit if needed.',due:'2026-10-09T14:00:00-04:00',related_call:'riley-leak'},
  {key:'drew-porch-check',customer:'Drew Bennett',owner:'Morgan Lee',title:'Call Drew with porch gutter inspection findings',description:'Get Chris’s finding from the Thursday site visit, then tell Drew what repair or observation is planned.',due:'2026-10-09T15:00:00-04:00',related_call:'drew-site-visit'},
  {key:'avery-color-callback',customer:'Avery Morgan',owner:'Sam Rivera',title:'Try Avery again about final color confirmation',description:'One callback after the unanswered attempt. Confirm charcoal selection before any material order; leave a voicemail only if appropriate.',due:'2026-10-09T13:00:00-04:00',related_call:'avery-busy'},
  {key:'jamie-walkthrough',customer:'Jamie Wilson',owner:'Alex Martinez',title:'Check Jamie’s final walkthrough items',description:'Confirm the patio cleanup and roof-and-garage walkthrough notes; arrange any remaining punch-list work.',due:'2026-10-12T15:00:00-04:00',related_call:'jamie-walkthrough'}
];
const callSpecs=[
  {key:'jordan-garage',customer:'Jordan Rivera',owner:'Sam Rivera',direction:'inbound',start:'2026-10-08T09:13:00-04:00',connected:'2026-10-08T09:13:08-04:00',end:'2026-10-08T09:19:42-04:00',purpose:'Clarify garage roof option',disposition:'answered',next_action:'follow_up',script:'estimate-review',notes:'Jordan called after reviewing the house-and-garage estimate. They asked whether the detached garage could be done during the same crew visit and why it appears as a separate line. Sam explained that the garage is priced separately so Jordan can choose either scope, and said crew timing needs confirmation from Alex. Jordan wants the combined option kept in the revision. Sam will send the written revision and call Friday to review it.'},
  {key:'riley-leak',customer:'Riley Patel',owner:'Sam Rivera',direction:'inbound',start:'2026-10-08T10:06:00-04:00',connected:'2026-10-08T10:06:11-04:00',end:'2026-10-08T10:14:03-04:00',purpose:'Attic staining near chimney',disposition:'answered',next_action:'follow_up',script:'new-inquiry',notes:'Riley called about staining above the hallway near the chimney after the recent rain. The stain is not actively dripping today. Sam asked when it first appeared and whether Riley can safely upload the Sunday attic photo; Riley said they will add it to the project tonight. Sam did not diagnose by phone. He will compare the photo with the roof inspection notes and call Friday with the next inspection step.'},
  {key:'taylor-voicemail',customer:'Taylor Chen',owner:'Sam Rivera',direction:'outbound',start:'2026-10-08T11:15:00-04:00',connected:'',end:'2026-10-08T11:15:48-04:00',purpose:'Check adjuster response',disposition:'voicemail',next_action:'follow_up',script:'voicemail',notes:'No answer. Sam left a short voicemail asking Taylor to call back when the adjuster’s written response is available. No claim details or roof measurements were left in the message. Next attempt is Monday at 11 a.m.'},
  {key:'jamie-walkthrough',customer:'Jamie Wilson',owner:'Alex Martinez',direction:'outbound',start:'2026-10-07T15:02:00-04:00',connected:'2026-10-07T15:02:17-04:00',end:'2026-10-07T15:08:36-04:00',purpose:'Roof and garage walkthrough',disposition:'answered',next_action:'follow_up',script:'quality-check',notes:'Alex called Jamie after the roof and garage work. Jamie said the roof looks good from the driveway but asked for a closer look at patio cleanup and the garage flashing during the final walkthrough. Alex agreed to check those spots in person and send completion photos. Jamie prefers an afternoon update after the walkthrough.'},
  {key:'drew-site-visit',customer:'Drew Bennett',owner:'Morgan Lee',direction:'inbound',start:'2026-10-08T13:21:00-04:00',connected:'2026-10-08T13:21:06-04:00',end:'2026-10-08T13:25:29-04:00',purpose:'Porch gutter site visit confirmation',disposition:'answered',next_action:'follow_up',script:'quality-check',notes:'Drew called before Chris’s scheduled porch gutter visit. The drip is at the front-left corner when facing the house and appears during heavier rain. Morgan confirmed Chris’s 1–3 p.m. window and that the photo is in the office thread. Drew will show Chris the exact spot. Morgan will call Friday with the inspection finding; no repair outcome was promised on this call.'},
  {key:'avery-busy',customer:'Avery Morgan',owner:'Sam Rivera',direction:'outbound',start:'2026-10-08T12:40:00-04:00',connected:'',end:'2026-10-08T12:40:22-04:00',purpose:'Final shingle color confirmation',disposition:'busy',next_action:'follow_up',script:'voicemail',notes:'Line was busy; no conversation and no voicemail. Sam needs final written confirmation of the charcoal selection before placing the material order. One retry is scheduled for Friday at 1 p.m.'},
  {key:'cameron-inspection',customer:'Cameron Reed',owner:'Morgan Lee',direction:'inbound',start:'2026-10-08T08:32:00-04:00',connected:'2026-10-08T08:32:14-04:00',end:'2026-10-08T08:38:57-04:00',purpose:'Storm damage inspection intake',disposition:'answered',next_action:'none',script:'new-inquiry',notes:'Cameron asked what the storm-damage inspection includes and whether roof photos can be shared with an insurer. Morgan explained that the site review documents visible damage and measurements, followed by a written scope; coverage decisions remain with the insurer. Cameron reported no active interior leak. Morgan noted driveway access and a dog that will be inside during the visit. The office will confirm the inspection window through the existing project thread.'}
];
const listSpecs=[
  {key:'sample-estimate-decisions',title:'Estimate and insurance decisions',description:'Customers waiting for a scoped price, option choice, or insurer response. Confirm the written next step after each conversation.',sort_order:60,entries:[
    ['Parker Hayes','Review detached garage option','2026-10-08T10:00:00-04:00'],
    ['Morgan Ellis','Confirm shingle and ventilation choices','2026-10-08T11:00:00-04:00'],
    ['Blair Roberts','Check insurer response to storm scope','2026-10-08T12:00:00-04:00']
  ]},
  {key:'sample-access-checks',title:'Upcoming job access checks',description:'Confirm site access before scheduling the crew. Capture driveway, gates, pets, and the day-of contact.',sort_order:61,entries:[
    ['Robin Campbell','Confirm driveway and material delivery space','2026-10-08T09:30:00-04:00'],
    ['Sam Mitchell','Confirm garage and side-gate access','2026-10-08T10:30:00-04:00'],
    ['Alexis Turner','Confirm best contact and safe inspection access','2026-10-08T13:00:00-04:00']
  ]},
  {key:'sample-quality-checks',title:'Post-work quality checks',description:'Ask about cleanup and specific roof or gutter details; record a precise location for any requested review.',sort_order:62,entries:[
    ['Reese Cooper','Ask about gutter drainage after rain','2026-10-08T10:15:00-04:00'],
    ['Quinn Foster','Check roof and gutter walkthrough notes','2026-10-08T11:15:00-04:00']
  ]}
];

const scriptByKey=new Map(scriptSpecs.map(spec=>[spec.key,spec]));
const scriptSnapshot=key=>{const spec=scriptByKey.get(key);if(!spec)throw new Error(`Missing script: ${key}`);
  return {id:id('script',key),version:1,title:spec.title,status:'published',data:{sections:spec.sections.map(([title,body])=>({title,body})),questions:spec.questions,department_ids:[]}};};
const stats={mode:apply?'applied':'dry-run',org_id:ORG_ID,calls:0,script_links:0,scripts:0,followups:0,lists:0,entries:0,existing:0};
const db=calls.database();
const author=byStaff.get('Sam Rivera').id;
for(const spec of scriptSpecs){
  const scriptId=id('script',spec.key);
  const existing=await db.prepare('SELECT id FROM customer_call_scripts WHERE organization_id=? AND id=? LIMIT 1').get(ORG_ID,scriptId);
  if(existing){stats.existing++;continue;}
  stats.scripts++;
  if(apply)await db.prepare('INSERT INTO customer_call_scripts(organization_id,id,version,title,status,data_json,created_at,author_id) VALUES(?,?,?,?,?,?,?,?)').run(
    ORG_ID,scriptId,1,spec.title,'published',JSON.stringify({sections:spec.sections.map(([title,body])=>({title,body})),questions:spec.questions,department_ids:[]}),at('2026-10-08T08:00:00-04:00'),author);
}

const followUpIds=new Map();
for(const spec of followUpSpecs){
  const target=byCustomer.get(spec.customer),staff=byStaff.get(spec.owner);
  if(!target||!staff)throw new Error(`Missing fixture target: ${spec.customer}`);
  const sourceKey=`${SOURCE}:${spec.key}`;
  const existing=(await work.listNodeRecords(ORG_ID,{actionable:true,open_only:false})).find(node=>node.metadata?.follow_up?.synthetic_source===sourceKey);
  if(existing){stats.existing++;followUpIds.set(spec.related_call,existing.id);continue;}
  stats.followups++;
  if(!apply)continue;
  const result=await followUps.createFollowUpTodo(ORG_ID,{id:id('fu',spec.key),source_key:sourceKey,branch_id:'default',project_id:target.project.id,
    title:spec.title,description:spec.description,due_at:at(spec.due),channel:'call',assigned_user_ids:[staff.id],
    metadata:{synthetic:true,source:SOURCE,follow_up:{synthetic_source:sourceKey,contact_id:target.contact.id,contact_name:spec.customer,
      phone:`+1${target.contact.phone.replace(/\D/g,'')}`,timezone:'America/New_York',channel:'call',origin:'sample_call',
      related_call_id:id('call',spec.related_call),completion_policy:'explicit'}}});
  followUpIds.set(spec.related_call,result.node.id);
}

for(const spec of callSpecs){
  const target=byCustomer.get(spec.customer),staff=byStaff.get(spec.owner);
  if(!target||!staff)throw new Error(`Missing fixture target: ${spec.customer}`);
  const callId=id('call',spec.key);
  let existing;try{existing=await calls.readCall(ORG_ID,callId);}catch(error){if(error.statusCode!==404)throw error;}
  if(existing){
    if(existing.metadata?.source===SOURCE&&!existing.metadata?.script){
      stats.script_links++;
      if(apply)await db.prepare('UPDATE customer_calls SET metadata_json=? WHERE organization_id=? AND id=?').run(
        JSON.stringify({...existing.metadata,script:scriptSnapshot(spec.script)}),ORG_ID,callId);
    }else stats.existing++;
    continue;
  }
  stats.calls++;
  if(!apply)continue;
  const start=at(spec.start),end=at(spec.end),connected=spec.connected?at(spec.connected):'';
  const result={disposition:spec.disposition,next_action:spec.next_action,actor_user_id:staff.id,
    ...(followUpIds.has(spec.key)?{follow_up_id:followUpIds.get(spec.key)}:{})};
  await db.prepare(`INSERT INTO customer_calls (id,organization_id,branch_id,project_id,contact_id,owner_user_id,mode,direction,state,wrap_up_state,
    customer_number,business_number,customer_name,entry_id,created_at,updated_at,connected_at,ended_at,revision,notes,result_json,metadata_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(callId,ORG_ID,'default',target.project.id,target.contact.id,staff.id,'external',spec.direction,'ended','saved',
    `+1${target.contact.phone.replace(/\D/g,'')}`,'',spec.customer,'',start,end,connected,end,1,spec.notes,JSON.stringify(result),
    JSON.stringify({synthetic:true,source:SOURCE,purpose:spec.purpose,actor_name:spec.owner,script_id:id('script',spec.script),
      script:scriptSnapshot(spec.script),recording_available:false}));
  for(const [kind,when] of [['communication.call.created',start],['communication.call.ended',end],['communication.call.wrap_up_saved',end]]){
    await db.prepare('INSERT INTO customer_call_events(id,organization_id,call_id,type,created_at,data_json) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(id('ce',`${spec.key}:${kind}`),ORG_ID,callId,kind,when,JSON.stringify({synthetic:true,source:SOURCE}));
  }
}

for(const spec of listSpecs){
  const existing=await callLists.getCallListDatabase().prepare('SELECT id FROM crm_call_lists WHERE organization_id=? AND list_key=?').get(ORG_ID,spec.key);
  if(existing)stats.existing++;else stats.lists++;
  if(apply)await callLists.ensureCallList(ORG_ID,{key:spec.key,title:spec.title,description:spec.description,status:'active',
    kind:'manual',icon:'fa-phone',tone:'default',sort_order:spec.sort_order,create_only:true,metadata:{synthetic:true,source:SOURCE}});
  for(const [customer,title,due] of spec.entries){
    const target=byCustomer.get(customer);if(!target)throw new Error(`Missing fixture target: ${customer}`);
    const sourceKey=`${SOURCE}:${spec.key}:${customer}`;
    const prior=await callLists.getCallListDatabase().prepare('SELECT id FROM crm_call_list_entries WHERE organization_id=? AND source_key=?').get(ORG_ID,sourceKey);
    if(prior){stats.existing++;continue;}
    stats.entries++;
    if(apply)await callLists.upsertCallListEntry(ORG_ID,spec.key,{source_key:sourceKey,project_id:target.project.id,
      subject_id:target.contact.id,subject_type:'project',title,due_at:at(due),priority:2,
      payload:{name:customer,phone:target.contact.phone,contact_id:target.contact.id},metadata:{synthetic:true,source:SOURCE}});
  }
}
console.log(JSON.stringify(stats,null,2));
process.exit(0);
