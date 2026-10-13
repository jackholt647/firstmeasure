import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import test from 'node:test';
const source=await readFile(new URL('../firstmeasure/api.ts',import.meta.url),'utf8');
const start=source.indexOf('  app.get("/projects/:id",');
const code=ts.transpileModule(source.slice(start,source.indexOf('  });',start)+5),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
test('summary conditional reads reauthorize before returning unchanged and never touch object storage',async()=>{
  let handler, permitted=true,org='one',reads=0;
  const context=vm.createContext({createHash,Boolean,String,JSON,
    app:{get:(_path,fn)=>handler=fn}, getProjectId:()=> 'a',asRecord:x=>x||{},
    requirePlatformAuth:async()=>{if(!permitted)throw new Error('revoked');return {orgId:org,identity:{email:'a@example.test'}};},
    readManifest:async()=>{reads++;return {id:'a',organization_id:'one'};},buildLegacyManifest:x=>x,
    catalogState:async()=>({generation:'1',ready:true}),
    getProjectDetail:async()=>{throw new Error('must not fetch detail');},
    FirstMeasureError:class extends Error{constructor(code,status,message){super(message);this.code=code;this.statusCode=status;}}
  });
  vm.runInContext(code,context);
  const first=await handler({query:{view:'portal-card'}});
  assert.equal(first.project.summary_only,true);
  assert.equal((await handler({query:{view:'portal-card',revision:first.project.revision}})).unchanged,true);
  org='two';await assert.rejects(handler({query:{view:'portal-card',revision:first.project.revision}}),{code:'project_forbidden'});
  permitted=false;const before=reads;await assert.rejects(handler({query:{view:'portal-card'}}),/revoked/);assert.equal(reads,before);
});
