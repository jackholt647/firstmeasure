import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source=await readFile(process.env.FEED_PRESENTATION_SCRIPT || new URL('../../libraries/apps/photos/feed.js',import.meta.url),'utf8');
const block=(name,next)=>source.slice(source.indexOf(`  function ${name}(`),source.indexOf(next,source.indexOf(`  function ${name}(`)));
const clean=value=>String(value ?? '').trim();
const first=(...values)=>values.map(clean).find(Boolean)||'';

test('Feed uses current terminology and configured scope titles without exposing event IDs',()=>{
  const terms={'projects.project':'Case','scope.scope':'Service workflow','documents.document':'Agreement','proposals.proposal':'Estimate'};
  const window={PlatformTerminology:{get:(key,fallback)=>terms[key] || fallback}};
  // The summary block starts at its area words (FEED_AREA_WORDS) and the person check it uses.
  const start=source.indexOf('  const FEED_AREA_WORDS'),summaryBlock=source.slice(start,source.indexOf('  function isPhotoTrashed(',start));
  const feedText=(key,fallback,vars={})=>String(fallback).replace(/\{(\w+)\}/g,(match,name)=>String(vars[name]??match));
  let actor='Alex';
  const project={title:'Pump room refit',address:'12 Mill Lane'};
  const summary=new Function('window','feedActor','activityObjectLabel','activityPayload','activityContext','cleanText','firstText','feedText','findActivityProject','projectTitle','savedProjectTitle','projectAddress','activityProjectLabel',summaryBlock+';return feedActivitySummary;')(window,()=>actor,event=>event.payload?.title||'',event=>event.payload||{},event=>event.context||{},clean,first,feedText,event=>event.project_id?project:null,p=>p.title,p=>p.title,p=>p.address,()=> '');
  assert.equal(summary({type:'project.created'}),'Alex created a case','a capitalized term reads in lower case mid-sentence');
  terms['projects.project']='Service request';
  assert.equal(summary({type:'project.created'}),'Alex created a service request');
  assert.equal(summary({type:'project.created',project_id:'p',payload:{title:'12 Mill Lane'}}),'Alex created a service request','the project address is not repeated after the action');
  terms['projects.project']='RFQ';
  assert.equal(summary({type:'project.created'}),'Alex created a RFQ','an acronym keeps its case');
  terms['projects.project']='Service request';
  assert.equal(summary({type:'work.node.completed',feed_presentation:{scope_title:'Equipment commissioning',node_title:'Customer handoff'}}),'Alex finished “Customer handoff” in Equipment commissioning');
  assert.equal(summary({type:'work.plan.stage_manually_set',payload:{to_stage_title:'Case closed'},feed_presentation:{scope_title:'Support'}}),'Alex moved the service request to Case closed · Support');
  assert.equal(summary({type:'document.signed',payload:{document_type:'proposal',title:'New service estimate'}}),'Customer signed an estimate: New service estimate');
  assert.equal(summary({type:'document.created',payload:{document_type:'proposal'},feed_presentation:{description:'A document was created on a project.',group:'documents'}}),'Alex started an estimate');
  assert.equal(summary({type:'material.lines.created',payload:{title:'Materials from measurements',line_count:12}}),'Alex listed 12 materials: Materials from measurements');
  assert.equal(summary({type:'custom.technical_event_identifier',feed_presentation:{description:'A delivery was accepted.',group:'materials'}}),'Materials update','an event with no wording names its area, never its internal description');
  assert.equal(summary({type:'unregistered.technical_event_identifier'}),'Update');
  assert.equal(summary({type:'project.event.completed',payload:{title:'Inspection',event:{completed_emitted_at:'2026-10-11'}}}),'Scheduled event ended: Inspection');
  // With no person behind it, an entry reads in the passive.
  actor='System';
  assert.equal(summary({type:'document.created',payload:{document_type:'proposal'}}),'New estimate started');
  assert.equal(summary({type:'work.node.completed',feed_presentation:{scope_title:'Roofing',node_title:'Order measurements'}}),'“Order measurements” is done in Roofing');
  assert.equal(summary({type:'media.uploaded',payload:{content_type:'image/jpeg'}}),'Photo added');
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
