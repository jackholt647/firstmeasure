import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const src=await readFile('../../outputs/qa-pass-build/firstmeasure/api.js','utf8');
const section=(a,b)=>src.slice(src.indexOf(a),src.indexOf(b,src.indexOf(a)));
let stored=null;
const ctx=vm.createContext({readManifest:async()=>({}),asRecord:x=>x||{},readStoredPdf:async()=>stored,
 conflict:(code,message)=>Object.assign(new Error(message),{code}),buildLegacyManifest:x=>x,drafterEmailForQaRank:()=>''});
vm.runInContext(section('async function resolveProjectPdfSyncReference(', 'async function enqueueProjectReportDelivery(')+section('function qaBulkApprovalMatches(', 'async function approveQaProjectFromBulk('),ctx);
await assert.rejects(vm.runInContext("resolveProjectPdfSyncReference('test')",ctx),{code:'missing_pdf'});
stored={content:Buffer.alloc(0)};
await assert.rejects(vm.runInContext("resolveProjectPdfSyncReference('test')",ctx),{code:'missing_pdf'});
stored={content:Buffer.from('%PDF-test')};
assert.equal(await vm.runInContext("resolveProjectPdfSyncReference('test')",ctx),null);
for(const criteria of ['{max_score:20}','{max_score:20,max_height_points:null,max_project_points:""}'])
 assert.equal(vm.runInContext(`qaBulkApprovalMatches({}, {error_score:13,height_quality_points:2,project_points:3},${criteria})`,ctx),true);
for(const criteria of ['{max_score:20,max_height_points:0}','{max_score:20,max_project_points:0}'])
 assert.equal(vm.runInContext(`qaBulkApprovalMatches({}, {error_score:13,height_quality_points:2,project_points:3},${criteria})`,ctx),false);
console.log('PASS: missing/empty PDF rejected; existing PDF accepted; optional bulk limits unbounded; explicit zero enforced.');
