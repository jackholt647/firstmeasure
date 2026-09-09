import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
const src=await readFile(new URL('../firstmeasure/api.ts',import.meta.url),'utf8');
const a=src.indexOf('async function requireQaManagerReviewActor('),b=src.indexOf('async function maybeEvaluateAutomaticRushMode(',a);
assert.ok(a>=0&&b>a,'Missing QA manager permission source boundary');
let user=null;
class FMError extends Error{constructor(code,status,message){super(message);this.code=code;this.status=status;}}
const ctx=vm.createContext({readInternalUser:async()=>user,asRecord:x=>x||{},FirstMeasureError:FMError});vm.runInContext(ts.transpileModule(src.slice(a,b),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
for(const denied of [null,{role:'qa',permissions:{manage_qa:true}},{role:'technician'}]){user=denied;await assert.rejects(vm.runInContext("requireQaManagerReviewActor('test@1m8.ai')",ctx),{code:'manager_required'});}
for(const allowed of [{role:'manager'},{role:'admin'},{role:'employee',permissions:{manage_qa_queue:true}}]){user=allowed;await vm.runInContext("requireQaManagerReviewActor('test@1m8.ai')",ctx);}
assert.match(src.slice(src.indexOf('app.post("/projects/:id/manager/decision"'),src.indexOf('app.post("/projects/:id/drafter/qa-response"')),/await requireQaManagerReviewActor\(actorEmail\)/);
console.log('PASS: QA-only, technician, and unknown accounts denied; manager/admin permissions accepted from stored user.');
