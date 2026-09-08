import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
for (const file of ['../measure/internal/portal_scripts/qa.js','../measure/internal/editor_scripts/notes_overlay.js']) {
 const s=await readFile(file,'utf8');const a=s.indexOf('function mergeThreadDrafts(');const b=s.indexOf('\n  function ',a+10);const asyncEnd=s.indexOf('\n  async function ',a+10);
 assert.match(s,/let qaThreadDraftSaveQueue = Promise\.resolve\(\)/);
 assert.match(s,/queueQaThreadDraftSave\(async \(\) =>/);
 assert.match(s,/editor\/qa-thread-drafts/);
 const persistStart=s.indexOf('async function persistThreadDrafts(');const clearStart=s.indexOf('async function clearThreadDrafts(',persistStart);const nextFunction=s.indexOf('\n  function ',clearStart);
 assert.doesNotMatch(s.slice(persistStart,nextFunction),/editor\/save/);
 const end=Math.min(...[b,asyncEnd].filter(n=>n>a));
 const ctx=vm.createContext({cloneJson:x=>JSON.parse(JSON.stringify(x))});vm.runInContext(s.slice(a,end),ctx);
 const old={id:'t',status:'open',history:[{ts:'2026-09-06T10:00:00Z'}]};const fresh={id:'t',status:'resolved',history:[...old.history,{ts:'2026-09-06T11:00:00Z'}]};
 ctx.base=[fresh];ctx.draft=[old];let result=vm.runInContext('mergeThreadDrafts(base,draft)',ctx);assert.equal(result.length,1);assert.equal(result[0].status,'resolved');
 ctx.base=[old];ctx.draft=[fresh];result=vm.runInContext('mergeThreadDrafts(base,draft)',ctx);assert.equal(result.length,1);assert.equal(result[0].status,'resolved');
 console.log('PASS: stale drafts cannot reopen resolved feedback; newer drafts preserved:',file);
 console.log('PASS: QA draft writes use the serialized durable endpoint:',file);
}
