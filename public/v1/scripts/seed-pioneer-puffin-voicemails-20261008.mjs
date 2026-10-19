/** Add playable synthetic voicemails only to the Pioneer Puffin development sandbox. */
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const ORG_ID='org_983c8e17cd313149';
const SOURCE='pioneer_puffin_voicemails_20261008';
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
if(!path.isAbsolute(root))throw new Error('Runtime root must be absolute.');
process.chdir(root);
const load=async name=>import(pathToFileURL(path.join(root,'dist',name)).href);
const platform=await load('platform/storage.js');
const calls=await load('comms/calls/storage.js');
const media=await load('comms/calls/media.js');
const org=await platform.readOrganization(ORG_ID);
if(!String(org.name||'').startsWith('Pioneer Puffin Test Co')||org.metadata?.sandbox_test_org!==true)throw new Error('Unexpected target organization.');

const specs=[
  {key:'jordan-estimate',name:'Jordan Rivera',file:'jordan-estimate.wav',text:'Hi, this is Jordan Rivera. I am looking at the revised estimate and had a question about whether the garage can be included with the house roof. Please call me back when you get a chance. Thanks.'},
  {key:'riley-leak',name:'Riley Patel',file:'riley-leak.wav',text:'Hello, this is Riley Patel. I noticed a new stain near the chimney after last nights rain. It is not actively dripping, but I would like to know if someone can check it this week. Thank you.'},
  {key:'drew-gutter',name:'Drew Bennett',file:'drew-gutter.wav',text:'Hi, Drew Bennett here. I wanted to confirm the gutter inspection at my porch and ask whether I should move the car before Chris arrives. Please give me a call back. Thanks.'}
];
const projects=await platform.listDocuments(ORG_ID,'projects');
const contacts=new Map();
for(const project of projects){
  if(project.data?.workflow_state!=='project'||!project.data?.tags?.includes('Synthetic'))continue;
  for(const contact of project.data?.contacts||[]){
    if(specs.some(spec=>spec.name===contact.name)&&/^202-555-01\d\d$/.test(String(contact.phone||'')))contacts.set(contact.name,{project,contact});
  }
}
for(const spec of specs)if(!contacts.has(spec.name))throw new Error(`Missing synthetic contact: ${spec.name}`);
const line=(await calls.resources(ORG_ID,'number')).find(item=>item.status==='active'&&String(item.branch_id||'default')==='default'&&!item.assigned_user_id);
if(!line?.phone_number)throw new Error('No active company main line in the sandbox.');
const fixtureRoot=path.resolve(root,'fixtures','pioneer-puffin-voicemail');
const stats={new_calls:0,existing_calls:0,new_artifacts:0,existing_artifacts:0};
for(const [index,spec] of specs.entries()){
  const {project,contact}=contacts.get(spec.name);
  const callId=calls.id('call',`${ORG_ID}:${SOURCE}:${spec.key}`),recordingId=`synthetic:${SOURCE}:${spec.key}`;
  const existing=await calls.database().prepare('SELECT id,metadata_json FROM customer_calls WHERE organization_id=? AND id=?').get(ORG_ID,callId);
  if(existing&&JSON.parse(existing.metadata_json||'{}').source!==SOURCE)throw new Error(`Call ID conflict: ${callId}`);
  if(existing)stats.existing_calls++;else stats.new_calls++;
  const currentArtifacts=existing?await calls.artifacts(ORG_ID,callId):[];
  const hasAudio=currentArtifacts.some(item=>item.kind==='voicemail'&&item.state==='ready');
  const hasTranscript=currentArtifacts.some(item=>item.kind==='transcript'&&item.state==='ready');
  stats[hasAudio&&hasTranscript?'existing_artifacts':'new_artifacts']++;
  if(!apply)continue;
  if(!existing){
    const createdAt=new Date(Date.now()-(index+1)*38*60000).toISOString();
    await calls.insertCall({id:callId,organization_id:ORG_ID,branch_id:'default',project_id:project.id,contact_id:contact.id,
      mode:'browser',direction:'inbound',state:'ended',customer_number:`+1${contact.phone.replace(/\D/g,'')}`,
      business_number:line.phone_number,customer_name:spec.name,created_at:createdAt,
      metadata:{synthetic:true,synthetic_voicemail:true,source:SOURCE,voicemail:{started:true}}});
    await calls.patchCall(ORG_ID,callId,{ended_at:createdAt,wrap_up_state:'saved',result:{disposition:'voicemail',synthetic:true}});
  }
  const artifactId=calls.id('ca',`${ORG_ID}:voicemail:${recordingId}`);
  const recording=await media.saveRecording(ORG_ID,artifactId,readFileSync(path.join(fixtureRoot,spec.file)),'wav');
  await calls.saveArtifact(ORG_ID,callId,'voicemail',recordingId,{...recording,provider_recording_id:recordingId,synthetic:true},'ready',365);
  await calls.saveArtifact(ORG_ID,callId,'transcript',recordingId,{text:spec.text,final:true,source:'synthetic',recording_id:recordingId},'ready',365);
}
console.log(JSON.stringify({organization_id:ORG_ID,applied:apply,line:line.phone_number,...stats}));
process.exit(0);
