import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const src=await readFile('../../outputs/qa-pass-build/firstmeasure/api.js','utf8');
function section(a,b){return src.slice(src.indexOf(a),src.indexOf(b,src.indexOf(a)));}
const now=Date.now(), dayStart=now-3600000;
const cache=new Map();
const projects=[{id:'a',address:'Synthetic A',status:'completed',qa_history:[{ts:new Date(now-1000).toISOString(),decision:'approved',qa_email:'qa@1m8.ai'}],work_history:[{event:'qa_claimed',qa_email:'qa@1m8.ai',ts:new Date(now-61000).toISOString()}]},
 {id:'b',address:'Synthetic B',status:'queued',qa_history:[{ts:new Date(now-500).toISOString(),decision:'rejected',qa_email:'qa@1m8.ai'}]},
 {id:'c',qa_history:[{ts:new Date(now).toISOString(),decision:'approved',qa_email:'other@1m8.ai'}]}];
let reads=0;
const ctx=vm.createContext({qaShiftLeaderboardCache:cache,normalizeQaShiftDateKey:x=>x,normalizeQaTeamFilter:x=>x,
 qaShiftDateKey:()=> '2026-09-06',qaShiftQueryWindow:()=>({}),managementDayBounds:()=>({startMs:dayStart,endExclusiveMs:now+10000}),
 queryIndexedProjectManifests:async()=>{reads++;return {projects};},qaShiftPointEventFromManifest:()=>null,
 buildQaShiftLeaderboard:()=>({leaderboard:[{email:'qa@1m8.ai',approved_count:1}]}),buildLegacyManifest:x=>x,
 asRecord:x=>x||{},parseDateLikeTimestamp:x=>Date.parse(x),
 listQaClaimedManifestsForActor:async()=>[],getIndexedQueueCounts:async()=>({groups:{qa_waiting:4}}),buildProjectListViewRow:x=>x});
vm.runInContext(section('async function loadQaShiftLeaderboard(', 'function buildQaLeaderboardFromRows(')+section('async function buildQaTechnicianStatus(', 'function qaClaimEmailFromLegacyRow('),ctx);
const result=await vm.runInContext("buildQaTechnicianStatus({email:'qa@1m8.ai'},null,{})",ctx);
assert.equal(result.stats.has_available_next,true);
assert.equal(result.history.length,1);
assert.equal(result.history[0].id,'a');
assert.equal(result.stats.personal_qa.submitted_projects,2);
assert.equal(result.stats.personal_qa.approved_projects,1);
assert.equal(result.stats.personal_qa.kickback_projects,1);
assert.equal(result.stats.personal_qa.average_decision_ms,60000);
await vm.runInContext("buildQaTechnicianStatus({email:'qa@1m8.ai'},null,{})",ctx);
assert.equal(reads,1,'Reuse indexed reporting cache');
console.log('PASS: QA actor isolation, approval history, decision counts, duration, availability, cache reuse.');
