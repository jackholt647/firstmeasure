/** Add retained, transport-free communication examples to the Pioneer Puffin dev sandbox. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ORG_ID = 'org_983c8e17cd313149';
const SOURCE = 'pioneer_puffin_communications_20261007';
const apply = process.argv.includes('--apply');
const runtimeRoot = process.env.FIRSTMEASURE_RUNTIME_ROOT || '/opt/firstmeasure/current/public/v1';

// Reuse the running development service's configuration without printing secrets.
if (process.argv.includes('--service-env')) {
  const pid = execFileSync('systemctl', ['show', 'firstmeasure-development-web.service', '-p', 'MainPID', '--value'], {encoding:'utf8'}).trim();
  if (!/^\d+$/.test(pid) || pid === '0') throw new Error('Development web service is not running.');
  for (const item of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
    const equals = item.indexOf('=');
    if (equals > 0) process.env[item.slice(0, equals)] = item.slice(equals + 1);
  }
}
if (process.env.FIRSTMEASURE_DATA_ENVIRONMENT !== 'development') throw new Error('Refusing to run outside development data.');
process.chdir(runtimeRoot);
const load = async name => import(pathToFileURL(path.join(runtimeRoot, 'dist', name)).href);
const platform = await load('platform/storage.js');
const messages = await load('messaging/communications_storage.js');
const chat = await load('chat/storage.js');
const calls = await load('comms/calls/storage.js');
const db = messages.getCommunicationsDatabase();
const hash = value => createHash('sha256').update(value).digest('hex');
const key = value => `pp_comms_${hash(`${ORG_ID}:${SOURCE}:${value}`).slice(0,24)}`;
const scoped = (prefix, value) => `${prefix}_${hash(ORG_ID).slice(0,12)}_${value}`;
const at = value => new Date(value).toISOString();
const data = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const org = await platform.readOrganization(ORG_ID);
if (!String(org.name || '').startsWith('Pioneer Puffin Test Co') || data(org.metadata).sandbox_test_org !== true) {
  throw new Error('Target is not the expected Pioneer Puffin sandbox.');
}

const projectRows = await platform.listDocuments(ORG_ID, 'projects');
const peopleRows = await platform.listDocuments(ORG_ID, 'users');
const projectByCustomer = new Map();
for (const project of projectRows) {
  if (project.data?.workflow_state !== 'project' || !project.data?.tags?.includes('Synthetic')) continue;
  const contact = project.data.contacts?.[0];
  if (!contact || !String(contact.email || '').endsWith('@example.test') || !/^202-555-01\d\d$/.test(String(contact.phone || ''))) continue;
  projectByCustomer.set(contact.name, {project,contact});
}
const staffByName = new Map(peopleRows.map(person => [person.data?.name || person.data?.display_name, person]));
for (const name of ['Morgan Lee','Sam Rivera','Alex Martinez']) if (!staffByName.has(name)) throw new Error(`Sample staff missing: ${name}`);
for (const name of ['Avery Morgan','Jordan Rivera','Taylor Chen','Jamie Wilson','Casey Brooks','Drew Bennett','Riley Patel']) {
  if (!projectByCustomer.has(name)) throw new Error(`Sample project missing: ${name}`);
}

const threads = [
  {id:'jordan-estimate',channel:'email',customer:'Jordan Rivera',subject:'Garage roof added to the estimate',items:[
    ['2026-09-29T09:14:00-04:00','in','Hi Sam, could you price the detached garage roof along with the house? The garage has the same shingles and I would rather have both done at once.'],
    ['2026-09-29T11:36:00-04:00','out','Absolutely. I will measure the garage separately and send a revised estimate so you can see the added cost. Is the garage accessible from the driveway?','Sam Rivera'],
    ['2026-09-30T08:42:00-04:00','in','Yes, you can get to it from the driveway. The side gate is narrow, but the garage door faces the street.'],
    ['2026-10-01T15:06:00-04:00','out','Thanks, that helps. The revised scope includes both roofs, matching charcoal shingles, and a separate line for the garage. I can walk through the changes by phone if you like.','Sam Rivera'],
    ['2026-10-02T10:18:00-04:00','in','I reviewed it. The separate line makes sense. Please keep the garage in the scope; I will confirm the color after I check the sample board.']
  ]},
  {id:'taylor-adjuster',channel:'email',customer:'Taylor Chen',subject:'Storm damage photos and adjuster visit',items:[
    ['2026-10-02T13:27:00-04:00','in','Our adjuster is coming Monday morning. Can you send the photos of the lifted shingles and the notes from your inspection before then?'],
    ['2026-10-02T15:03:00-04:00','out','Yes. I have the inspection photos and the measurements together. I will send the photo report this afternoon, then call you Monday after the adjuster has seen the roof.','Sam Rivera'],
    ['2026-10-05T08:11:00-04:00','in','The report came through, thank you. The adjuster asked whether the drip edge is included in the replacement scope.'],
    ['2026-10-05T08:49:00-04:00','out','It is included on the eaves and rakes in our scope. I can point that out in the estimate when we speak later today.','Sam Rivera'],
    ['2026-10-06T16:24:00-04:00','in','That answered his question. He is reviewing the estimate now. I will send you his response once I have it.']
  ]},
  {id:'avery-color',channel:'email',customer:'Avery Morgan',subject:'Shingle color and ventilation',items:[
    ['2026-10-01T10:22:00-04:00','in','We like the charcoal sample best. Can you confirm the ridge vent and the bathroom vent are part of the roof work?'],
    ['2026-10-01T12:07:00-04:00','out','Charcoal is available for this roof. The ridge vent is in the estimate. We will also replace the bathroom vent flashing and reconnect the existing duct at the roof; I will make that line explicit in the scope.','Sam Rivera'],
    ['2026-10-03T09:31:00-04:00','in','Perfect. One more question: how long would the house be without the old roof once the crew starts?'],
    ['2026-10-03T11:12:00-04:00','out','The tear-off and dry-in are planned for the same day, weather permitting. The roof should be watertight before the crew leaves. We will confirm the start window the day before.','Alex Martinez'],
    ['2026-10-06T17:02:00-04:00','in','Thanks, that is what I needed. Please keep charcoal as the selected color.']
  ]},
  {id:'jamie-install',channel:'sms',customer:'Jamie Wilson',items:[
    ['2026-10-02T08:18:00-04:00','out','Hi Jamie, this is Morgan at Pioneer Puffin. We are planning the house and garage roof for Tuesday. Is the driveway available for a dumpster around 8:30 a.m.?','Morgan Lee'],
    ['2026-10-02T08:31:00-04:00','in','Yes, I can move both cars before 8. Will the crew need the side gate open too?'],
    ['2026-10-02T08:36:00-04:00','out','Please leave it unlocked so the crew can protect the patio and bring materials to the garage. Alex will call before they arrive.','Morgan Lee'],
    ['2026-10-05T16:12:00-04:00','out','Quick update: the shingles are confirmed. We are still on for Tuesday, weather permitting. I will text by 7 a.m. if the forecast changes.','Morgan Lee'],
    ['2026-10-05T16:19:00-04:00','in','Sounds good. The driveway and gate will be clear.'],
    ['2026-10-06T07:06:00-04:00','out','Good morning. The forecast looks clear and the crew is on the way. Expected arrival is 8:15–8:30.','Morgan Lee'],
    ['2026-10-06T07:18:00-04:00','in','Thanks! I am home if they need anything.'],
    ['2026-10-06T15:48:00-04:00','out','The main roof is dried in and the garage is complete. Alex will walk the site with you tomorrow after cleanup.','Morgan Lee'],
    ['2026-10-06T16:02:00-04:00','in','Looks great from the driveway. Tomorrow afternoon works for the walkthrough.']
  ]},
  {id:'casey-gutters',channel:'sms',customer:'Casey Brooks',items:[
    ['2026-10-05T10:04:00-04:00','in','Hi, checking on the gutter color. Is the dark bronze sample the one in my estimate?'],
    ['2026-10-05T10:17:00-04:00','out','Hi Casey, yes, dark bronze is the selected gutter color. The downspouts will match. I can send a photo of the sample next to the fascia if helpful.','Morgan Lee'],
    ['2026-10-05T10:25:00-04:00','in','No need, that is the one we picked. Can the back downspout still go toward the garden side?'],
    ['2026-10-05T11:02:00-04:00','out','Yes. Alex marked the garden-side location in the crew notes. They will confirm the final elbow position with you before fastening it.','Morgan Lee'],
    ['2026-10-07T11:48:00-04:00','in','Alex just called. The garden-side spot works; please go ahead with that location.'],
    ['2026-10-07T12:03:00-04:00','out','Got it. I have updated the crew note and will send a photo after the downspout is installed.','Morgan Lee']
  ]},
  {id:'drew-punch-list',channel:'sms',customer:'Drew Bennett',items:[
    ['2026-10-05T14:23:00-04:00','in','Hi, after the gutter work I noticed one corner near the porch still drips when it rains. Could someone take a look?'],
    ['2026-10-05T14:41:00-04:00','out','Thanks for telling us, Drew. I will have Chris check the porch corner and the downspout connection. Could you send a photo when it is safe to do so?','Morgan Lee'],
    ['2026-10-05T15:08:00-04:00','in','I can send one after work. It is the front left corner when facing the house.'],
    ['2026-10-06T09:12:00-04:00','out','I left you a voicemail. Chris has an opening Thursday between 1 and 3 p.m. to inspect that corner. Does that window work?','Morgan Lee'],
    ['2026-10-06T12:17:00-04:00','in','Thursday at 1 works. I will be home and can show him the spot.'],
    ['2026-10-06T12:28:00-04:00','out','You are set for Thursday at 1 p.m. Chris will text when he is on his way. Thanks for helping us pinpoint it.','Morgan Lee'],
    ['2026-10-07T13:42:00-04:00','in','I sent the corner photo to the office email too. Let me know if Chris needs another angle.']
  ]},
  {id:'riley-portal',channel:'webchat',customer:'Riley Patel',items:[
    ['2026-10-07T15:05:00-04:00','in','Hi, does the inspection report include photos of the staining in the attic? I want to make sure the leak location is clear.'],
    ['2026-10-07T15:07:00-04:00','out','Hi Riley. The roof photos are in your project report. I am checking whether the attic photo was added too. If you have one from Sunday, you can share it here for Sam to review.','Morgan Lee'],
    ['2026-10-07T15:10:00-04:00','in','I do have a picture from Sunday. The stain is above the hallway, close to the chimney.'],
    ['2026-10-07T15:12:00-04:00','out','That is helpful. Please add the picture to this project when you have a moment. I will flag the hallway and chimney location for Sam before the next visit.','Morgan Lee'],
    ['2026-10-07T15:15:00-04:00','in','I will upload it tonight. Thanks for the quick answer.'],
    ['2026-10-07T15:16:00-04:00','out','You are welcome. We will review it alongside the roof inspection notes.','Morgan Lee']
  ]}
];

const callSpecs = [
  {id:'jamie-driveway',customer:'Jamie Wilson',direction:'outbound',owner:'Alex Martinez',start:'2026-10-02T11:40:00-04:00',connected:'2026-10-02T11:40:19-04:00',end:'2026-10-02T11:45:58-04:00',purpose:'Confirm installation access',disposition:'answered',notes:'Spoke with Jamie about Tuesday access. Both cars will be moved before 8 a.m.; side gate will be unlocked. Confirmed dumpster at approximately 8:30 and asked the crew to protect the patio pavers. Jamie prefers a text if weather changes.'},
  {id:'taylor-adjuster',customer:'Taylor Chen',direction:'inbound',owner:'Sam Rivera',start:'2026-10-05T10:14:00-04:00',connected:'2026-10-05T10:14:12-04:00',end:'2026-10-05T10:21:23-04:00',purpose:'Review storm damage scope',disposition:'answered',notes:'Taylor called after the adjuster visit. We reviewed the lifted shingle photos, drip edge at eaves and rakes, and the roof measurement total. Taylor will forward the adjuster response when it arrives; no scope change requested yet.'},
  {id:'drew-porch',customer:'Drew Bennett',direction:'outbound',owner:'Morgan Lee',start:'2026-10-06T09:10:00-04:00',connected:'',end:'2026-10-06T09:10:46-04:00',purpose:'Porch gutter inspection',disposition:'voicemail',notes:'No answer. Left a brief voicemail offering Chris a Thursday 1–3 p.m. inspection window for the porch gutter corner. Followed up by text; Drew confirmed 1 p.m. later that day.'},
  {id:'avery-vent',customer:'Avery Morgan',direction:'outbound',owner:'Sam Rivera',start:'2026-10-06T15:20:00-04:00',connected:'2026-10-06T15:20:14-04:00',end:'2026-10-06T15:24:06-04:00',purpose:'Confirm roof options',disposition:'answered',notes:'Reviewed charcoal shingle selection, ridge ventilation and bathroom vent flashing. Avery confirmed the color and understood that tear-off and dry-in are planned for the same workday, subject to weather. No further estimate changes requested.'},
  {id:'casey-downspout',customer:'Casey Brooks',direction:'inbound',owner:'Alex Martinez',start:'2026-10-07T11:20:00-04:00',connected:'2026-10-07T11:20:09-04:00',end:'2026-10-07T11:23:40-04:00',purpose:'Confirm downspout placement',disposition:'answered',notes:'Casey confirmed the back downspout can run to the garden side. I explained where the final elbow would land and said we would confirm before fastening it. Morgan will send a completion photo.'}
];

const stats = {mode:apply?'applied':'dry-run',org_id:ORG_ID,threads:0,legacy_threads_enriched:0,chat_visitors:0,chat_states:0,messages:0,deliveries:0,calls:0,existing:0};
for (const thread of threads) {
  const target = projectByCustomer.get(thread.customer);
  const {project,contact} = target;
  const conversationKey = key(`conversation:${thread.id}`);
  const conversationId = scoped('conversation', conversationKey);
  let conversation;
  try { conversation = await messages.readConversationRecord(ORG_ID, conversationId); } catch (error) { if (error.statusCode !== 404) throw error; }
  if (!conversation && !apply) stats.threads++;
  if (!conversation && apply) {
    const address = thread.channel === 'email' ? contact.email : thread.channel === 'sms' ? `+1${contact.phone.replace(/\D/g,'')}` : `portal:${contact.id}`;
    conversation = await messages.createConversationRecord({id:conversationKey,organization_id:ORG_ID,branch_id:'default',channel_strategy:thread.channel,
      subject:thread.subject || '',participants:[{name:contact.name,address,type:'external'}],context:{project_id:project.id,contact_id:contact.id},
      metadata:{synthetic:true,source:SOURCE},created_by_user_id:staffByName.get('Morgan Lee').id});
    await db.prepare('UPDATE communication_conversations SET created_at=?,updated_at=? WHERE organization_id=? AND id=?').run(at(thread.items[0][0]),at(thread.items[0][0]),ORG_ID,conversation.id);
    stats.threads++;
  } else if (conversation) stats.existing++;
  for (const [index,item] of thread.items.entries()) {
    const [when,direction,body,staffName] = item;
    const messageKey = key(`message:${thread.id}:${index}`);
    const messageId = scoped('message', messageKey);
    let existing;
    try { existing = await messages.readMessageRecord(ORG_ID,messageId); } catch (error) { if (error.statusCode !== 404) throw error; }
    if (existing) { stats.existing++; continue; }
    if (!apply) { stats.messages++; if (direction==='out' && thread.channel!=='webchat') stats.deliveries++; continue; }
    const staff = staffByName.get(staffName || 'Morgan Lee');
    const customerAddress = thread.channel === 'email' ? contact.email : thread.channel === 'sms' ? `+1${contact.phone.replace(/\D/g,'')}` : `portal:${contact.id}`;
    const staffAddress = thread.channel === 'email' ? 'office@pioneerpuffin.example.test' : thread.channel === 'sms' ? '+12025550100' : 'portal:team';
    const addressField = thread.channel==='email'?'email':thread.channel==='sms'?'phone':null;
    const sender = direction === 'in' ? {name:contact.name,address:customerAddress,...(addressField?{[addressField]:customerAddress}:{}),type:'external'}
      : {name:staffName,address:staffAddress,...(addressField?{[addressField]:staffAddress}:{}),type:'internal',user_id:staff.id};
    const recipient = direction === 'in' ? {name:'Pioneer Puffin Test Co',address:staffAddress,type:'internal'} : {name:contact.name,address:customerAddress,type:'external',contact_id:contact.id};
    const emailMeta = thread.channel==='email' ? {message_id:`<${messageKey}@example.test>`,...(index?{in_reply_to:`<${key(`message:${thread.id}:${index-1}`)}@example.test>`,references:thread.items.slice(0,index).map((_,i)=>`<${key(`message:${thread.id}:${i}`)}@example.test>`)}:{})} : undefined;
    const result = await messages.createMessageRecord({id:messageKey,idempotency_key:messageKey,organization_id:ORG_ID,branch_id:'default',conversation_id:conversation.id,
      context:{project_id:project.id,contact_id:contact.id},direction:direction==='in'?'inbound':'outbound',channel:thread.channel,status:direction==='in'?'received':'sent',
      subject:thread.subject || '',text_body:body,sender,recipients:[recipient],metadata:{synthetic:true,source:SOURCE,...(direction==='out'&&thread.channel!=='webchat'?{transport_mode:'capture'}:{}),...(emailMeta?{email:emailMeta}:{})},
      source:{type:direction==='in'?'webhook':'user',id:direction==='in'?'synthetic_fixture':staff.id},tags:['synthetic'],created_by_user_id:direction==='out'?staff.id:''});
    if (!result.created) { stats.existing++; continue; }
    const stamp=at(when);
    await db.prepare('UPDATE communication_messages SET created_at=?,updated_at=?,sent_at=? WHERE organization_id=? AND id=?')
      .run(stamp,stamp,direction==='out'?stamp:null,ORG_ID,result.message.id);
    if (direction==='out' && thread.channel!=='webchat') {
      const deliveryId=key(`delivery:${thread.id}:${index}`);
      await messages.createDeliveryRecord({id:deliveryId,organization_id:ORG_ID,message_id:result.message.id,channel:thread.channel,recipient_address:customerAddress,
        recipient,provider:'synthetic',transport_mode:'capture',status:'sent',queued_at:stamp,sent_at:stamp,response:{synthetic:true,source:SOURCE}});
      await db.prepare('UPDATE communication_deliveries SET created_at=?,updated_at=? WHERE organization_id=? AND id=?').run(stamp,stamp,ORG_ID,deliveryId);
      stats.deliveries++;
    }
    stats.messages++;
  }
  if (apply && conversation) await messages.touchConversationForMessage(ORG_ID,conversation.id,at(thread.items.at(-1)[0]));
}

// The global Chats inbox reads its visitor/state tables, not only the shared
// communication messages. Link the retained portal example through that path.
const portalThread=threads.find(thread=>thread.id==='riley-portal');
const portalTarget=projectByCustomer.get(portalThread.customer);
const portalConversationId=scoped('conversation',key(`conversation:${portalThread.id}`));
const tokenHash=hash(`${ORG_ID}:${SOURCE}:portal-visitor:riley`);
let portalVisitor=await chat.findVisitorByTokenHash(ORG_ID,tokenHash);
if (!portalVisitor) {
  if (apply) {
    portalVisitor=await chat.createVisitor({organization_id:ORG_ID,branch_id:'default',token_hash:tokenHash,contact_id:portalTarget.contact.id,
      display_name:portalTarget.contact.name,email:portalTarget.contact.email,phone:portalTarget.contact.phone,
      page_url:`https://dev.1m8.ai/portal/?project=${portalTarget.project.id}`,portal_customer_id:portalTarget.contact.id,
      metadata:{synthetic:true,source:SOURCE}});
    await db.prepare('UPDATE chat_visitors SET first_seen_at=?,last_seen_at=? WHERE organization_id=? AND id=?')
      .run(at(portalThread.items[0][0]),at(portalThread.items.at(-1)[0]),ORG_ID,portalVisitor.id);
  }
  stats.chat_visitors++;
} else stats.existing++;
let portalState;
try { portalState=await chat.readConversationState(ORG_ID,portalConversationId); } catch (error) { if (error.statusCode!==404) throw error; }
if (!portalState) {
  if (apply) {
    portalState=await chat.createConversationState({conversation_id:portalConversationId,organization_id:ORG_ID,branch_id:'default',visitor_id:portalVisitor.id,
      widget_key:key('inert-portal-widget'),source:'portal',handling_mode:'human',origin_url:`https://dev.1m8.ai/portal/?project=${portalTarget.project.id}`});
    await db.prepare('UPDATE chat_conversation_state SET created_at=?,updated_at=? WHERE organization_id=? AND conversation_id=?')
      .run(at(portalThread.items[0][0]),at(portalThread.items.at(-1)[0]),ORG_ID,portalConversationId);
  }
  stats.chat_states++;
} else stats.existing++;

// Turn the three original one-sided development examples into ordinary replies.
// Only touch the exact generator records; leave any user-edited thread alone.
const legacySpecs = [
  {customer:'Avery Morgan',original:'Can you include the garage roof in the estimate?',subject:'Garage roof option',items:[
    ['2026-10-07T12:05:00-04:00','out','Yes. I will price the detached garage as a separate option so you can compare the house-only and combined totals. I will confirm the crew timing before I send the revision.','Sam Rivera'],
    ['2026-10-07T12:31:00-04:00','in','Thank you. If adding the garage means a second workday, please let me know before we finalize it.'],
    ['2026-10-07T13:14:00-04:00','out','Of course. Alex is checking the schedule and I will put the timing beside the garage price in the revised estimate.','Sam Rivera']
  ]},
  {customer:'Jordan Rivera',original:'The driveway will be clear for your site visit.',subject:'Site visit access',items:[
    ['2026-10-07T11:54:00-04:00','out','Thanks, Jordan. Sam plans to arrive between 2 and 2:30 p.m. and will call if traffic changes that window.','Morgan Lee'],
    ['2026-10-07T12:08:00-04:00','in','Great. Please use the side gate; the dog will be inside.'],
    ['2026-10-07T12:22:00-04:00','out','Noted. Sam will use the side gate and knock before going around back.','Morgan Lee']
  ]},
  {customer:'Taylor Chen',original:'Please show me the charcoal and weathered wood options.',subject:'Shingle color samples',items:[
    ['2026-10-07T11:48:00-04:00','out','I can bring both shingle boards to the site visit. Charcoal reads darker in direct sun; weathered wood has a warmer mix. We can hold off on ordering until you see them outdoors.','Sam Rivera'],
    ['2026-10-07T12:36:00-04:00','in','That would help. Could you leave the boards on the porch for my partner to see after work?'],
    ['2026-10-07T14:02:00-04:00','out','Yes. I will label both boards and leave them on the covered porch after the visit. Text me your choice when you have looked at them together.','Sam Rivera']
  ]}
];
const legacyConversations=await messages.listConversationRecords(ORG_ID,{limit:250});
for (const spec of legacySpecs) {
  const target=projectByCustomer.get(spec.customer);
  const conversation=legacyConversations.find(row=>row.project_id===target.project.id && row.channel_strategy==='email' && row.metadata?.source==='development_tools');
  if (!conversation) throw new Error(`Original sample conversation missing: ${spec.customer}`);
  const prior=await messages.listMessageRecords(ORG_ID,{conversation_id:conversation.id,limit:100});
  const original=prior.find(row=>row.direction==='inbound' && row.text_body===spec.original && row.metadata?.source==='development_tools');
  if (!original || prior.some(row=>!['development_tools',SOURCE].includes(String(row.metadata?.source||'')))) {
    throw new Error(`Original sample conversation changed: ${spec.customer}`);
  }
  if (conversation.subject==='Roofing enquiry (Sample)') {
    if (apply) {
      await db.prepare('UPDATE communication_conversations SET subject=? WHERE organization_id=? AND id=? AND subject=?').run(spec.subject,ORG_ID,conversation.id,'Roofing enquiry (Sample)');
      await db.prepare('UPDATE communication_messages SET subject=? WHERE organization_id=? AND id=? AND subject=?').run(spec.subject,ORG_ID,original.id,'Roofing enquiry (Sample)');
    }
    stats.legacy_threads_enriched++;
  }
  for (const [index,[when,direction,body,staffName]] of spec.items.entries()) {
    const messageKey=key(`legacy:${spec.customer}:${index}`),messageId=scoped('message',messageKey);
    let existing;
    try { existing=await messages.readMessageRecord(ORG_ID,messageId); } catch (error) { if (error.statusCode!==404) throw error; }
    if (existing) { stats.existing++; continue; }
    if (!apply) { stats.messages++; if(direction==='out')stats.deliveries++; continue; }
    const staff=staffByName.get(staffName||'Morgan Lee'),customerAddress=target.contact.email,staffAddress='office@pioneerpuffin.example.test',stamp=at(when);
    const sender=direction==='in'?{name:spec.customer,address:customerAddress,email:customerAddress,type:'external'}
      :{name:staffName,address:staffAddress,email:staffAddress,type:'internal',user_id:staff.id};
    const recipient=direction==='in'?{name:'Pioneer Puffin Test Co',address:staffAddress,type:'internal'}
      :{name:spec.customer,address:customerAddress,type:'external',contact_id:target.contact.id};
    const result=await messages.createMessageRecord({id:messageKey,idempotency_key:messageKey,organization_id:ORG_ID,branch_id:'default',conversation_id:conversation.id,
      context:{project_id:target.project.id,contact_id:target.contact.id},direction:direction==='in'?'inbound':'outbound',channel:'email',status:direction==='in'?'received':'sent',
      subject:spec.subject,text_body:body,sender,recipients:[recipient],metadata:{synthetic:true,source:SOURCE,...(direction==='out'?{transport_mode:'capture'}:{})},
      source:{type:direction==='in'?'webhook':'user',id:direction==='in'?'synthetic_fixture':staff.id},tags:['synthetic'],created_by_user_id:direction==='out'?staff.id:''});
    if (!result.created) { stats.existing++; continue; }
    await db.prepare('UPDATE communication_messages SET created_at=?,updated_at=?,sent_at=? WHERE organization_id=? AND id=?')
      .run(stamp,stamp,direction==='out'?stamp:null,ORG_ID,result.message.id);
    if (direction==='out') {
      const deliveryId=key(`delivery:legacy:${spec.customer}:${index}`);
      await messages.createDeliveryRecord({id:deliveryId,organization_id:ORG_ID,message_id:result.message.id,channel:'email',recipient_address:customerAddress,
        recipient,provider:'synthetic',transport_mode:'capture',status:'sent',queued_at:stamp,sent_at:stamp,response:{synthetic:true,source:SOURCE}});
      await db.prepare('UPDATE communication_deliveries SET created_at=?,updated_at=? WHERE organization_id=? AND id=?').run(stamp,stamp,ORG_ID,deliveryId);
      stats.deliveries++;
    }
    stats.messages++;
  }
  if (apply) await messages.touchConversationForMessage(ORG_ID,conversation.id,at(spec.items.at(-1)[0]));
}

for (const spec of callSpecs) {
  const target=projectByCustomer.get(spec.customer);
  const callId=`call_${hash(`${ORG_ID}:${SOURCE}:call:${spec.id}`).slice(0,32)}`;
  let existing;
  try { existing=await calls.readCall(ORG_ID,callId); } catch (error) { if (error.statusCode !== 404) throw error; }
  if (existing) { stats.existing++; continue; }
  if (!apply) { stats.calls++; continue; }
  const owner=staffByName.get(spec.owner);
  const number=`+1${target.contact.phone.replace(/\D/g,'')}`;
  const start=at(spec.start),end=at(spec.end),connected=spec.connected?at(spec.connected):'';
  await db.prepare(`INSERT INTO customer_calls (id,organization_id,branch_id,project_id,contact_id,owner_user_id,mode,direction,state,wrap_up_state,
    customer_number,business_number,customer_name,entry_id,created_at,updated_at,connected_at,ended_at,revision,notes,result_json,metadata_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(callId,ORG_ID,'default',target.project.id,target.contact.id,owner.id,'external',spec.direction,'ended','saved',
    number,'',spec.customer,'',start,end,connected,end,1,spec.notes,JSON.stringify({disposition:spec.disposition,next_action:'none',actor_user_id:owner.id}),
    JSON.stringify({synthetic:true,source:SOURCE,purpose:spec.purpose,actor_name:spec.owner}));
  for (const [kind,when] of [['communication.call.created',start],['communication.call.ended',end],['communication.call.wrap_up_saved',end]]) {
    const eventId=`ce_${hash(`${callId}:${kind}`).slice(0,32)}`;
    await db.prepare('INSERT INTO customer_call_events (id,organization_id,call_id,type,created_at,data_json) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(eventId,ORG_ID,callId,kind,when,JSON.stringify({synthetic:true,source:SOURCE}));
  }
  stats.calls++;
}
console.log(JSON.stringify(stats,null,2));
await messages.closeCommunicationsDatabase();
process.exit(0);
