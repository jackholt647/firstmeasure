import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../../libraries/apps/photos/feed.js',import.meta.url),'utf8');
const block=(name,next)=>source.slice(source.indexOf(`  function ${name}(`),source.indexOf(next,source.indexOf(`  function ${name}(`)));
const clean=value=>String(value ?? '').trim();
const first=(...values)=>values.map(clean).find(Boolean)||'';

test('Feed uses current terminology and configured scope titles without exposing event IDs',()=>{
  const terms={'projects.project':'Case','scope.scope':'Service workflow','documents.document':'Agreement','proposals.proposal':'Estimate'};
  const window={PlatformTerminology:{get:(key,fallback)=>terms[key] || fallback}};
  const summary=new Function('window','feedActor','activityObjectLabel','activityPayload','activityContext','cleanText','firstText',block('feedActivitySummary','  function isPhotoTrashed(')+';return feedActivitySummary;')(window,()=> 'Alex',event=>event.payload?.title||'',event=>event.payload||{},event=>event.context||{},clean,first);
  assert.equal(summary({type:'project.created'}),'Alex created a Case');
  terms['projects.project']='Service request';
  assert.equal(summary({type:'project.created'}),'Alex created a Service request');
  assert.equal(summary({type:'work.node.completed',feed_presentation:{scope_title:'Equipment commissioning',node_title:'Customer handoff'}}),'Alex completed Customer handoff · Equipment commissioning');
  assert.equal(summary({type:'work.plan.stage_manually_set',payload:{to_stage_title:'Case closed'},feed_presentation:{scope_title:'Support'}}),'Alex moved the Service request to Case closed · Support');
  assert.equal(summary({type:'document.signed',payload:{document_type:'proposal',title:'New service estimate'}}),'Alex had Estimate signed: New service estimate');
  assert.equal(summary({type:'custom.technical_event_identifier',feed_presentation:{description:'A delivery was accepted.'}}),'A delivery was accepted.');
  assert.equal(summary({type:'unregistered.technical_event_identifier'}),'Activity recorded');
  assert.equal(summary({type:'project.event.completed',payload:{title:'Inspection',event:{completed_emitted_at:'2026-10-11'}}}),'Scheduled event ended: Inspection');
});

test('existing signature switches match canonical document signatures by type or tags',()=>{
  const state={density:'posts',feedScope:'company',postSettings:{company_activity_types:['proposal.signed','contract.signed']}};
  const allowed=new Function('state','DEFAULT_POST_ACTIVITY_TYPES','cleanText','firstText','objectValue','activityPayload','feedEntryDepartments',block('automaticPostType','  function feedEntries(')+';return automaticPostEnabled;')(state,new Set(),clean,first,value=>value||{},event=>event.payload||{},()=>[]);
  const event=payload=>({kind:'activity',event:{type:'document.signed',payload}});
  assert.equal(allowed(event({document_type:'proposal'})),true);
  assert.equal(allowed(event({document_type:'service_agreement',document_tags:['contract']})),true);
  assert.equal(allowed(event({document_source:'proposals'})),true);
  assert.equal(allowed(event({document_type:'inspection_report'})),false);
  state.postSettings.company_activity_types=[];
  assert.equal(allowed(event({document_type:'proposal'})),false);
});
