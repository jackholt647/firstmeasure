import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile('../measure/internal/portal_scripts/qa.js','utf8').catch(()=>readFile('../../public/measure/internal/portal_scripts/qa.js','utf8'));
const elements=new Map();
function element(){return {style:{},classList:{add(){},remove(){}},setAttribute(){},focus(){},after(){},remove(){this.removed=true;}};}
for(const id of ['qaConfirmOverlay','qaConfirmTitle','qaConfirmMessage','qaConfirmOkBtn','qaConfirmCancelBtn'])elements.set(id,element());
let input;
const ctx=vm.createContext({document:{getElementById:id=>elements.get(id),createElement:()=>input=element()},window:{confirm:()=>{throw Error('Native prompt/confirm must not be used');}}});
vm.runInContext(source.slice(source.indexOf('function qaConfirm(options){'),source.indexOf('function qaNotice(')),ctx);
const accepted=vm.runInContext("qaConfirm({promptValue:'Default note'})",ctx);
input.value='DEV reviewed';elements.get('qaConfirmOkBtn').onclick();assert.equal(await accepted,'DEV reviewed');assert.equal(input.removed,true);
const cancelled=vm.runInContext("qaConfirm({promptValue:'note'})",ctx);elements.get('qaConfirmCancelBtn').onclick();assert.equal(await cancelled,null);
const normal=vm.runInContext('qaConfirm({})',ctx);elements.get('qaConfirmOkBtn').onclick();assert.equal(await normal,true);
assert.ok(source.includes('const note = await qaConfirm({'));
console.log('PASS: resolution note, cancellation, cleanup, and existing boolean confirmations.');
