const test=require('node:test'),assert=require('node:assert/strict');
const {referenceCache}=require('../public/measure/internal/editor_scripts/project_resources');
test('repeated and concurrent reference loads share one fetch and decoded object',async()=>{
 const c=referenceCache();let loads=0;const load=async()=>{loads++;return {pixels:16};};const [a,b]=await Promise.all([c.get('image',load,x=>x.pixels),c.get('image',load)]);assert.equal(a,b);assert.equal(await c.get('image',load),a);assert.equal(loads,1);assert.equal(c.bytes,16);
});
test('decoded-byte budget evicts the least recently used image',async()=>{
 const c=referenceCache({maxBytes:20,maxEntries:5});let loads=0;const load=async()=>({id:++loads}),get=k=>c.get(k,load,()=>10);const a=await get('a');await get('b');assert.equal(await get('a'),a);await get('c');assert.equal(c.bytes,20);await get('b');assert.equal(loads,4);assert.equal(c.count,2);
});
test('entry limit bounds small markup documents and oversized images are not retained',async()=>{
 const c=referenceCache({maxBytes:10,maxEntries:2});for(const k of ['a','b','c'])await c.get(k,()=>k);assert.equal(c.count,2);await c.get('large',()=>100,x=>x);assert.equal(c.count,2);assert.equal(c.bytes,0);
});
test('failed references retry instead of retaining rejected promises',async()=>{
 const c=referenceCache();await assert.rejects(c.get('a',()=>{throw Error('offline');}));assert.equal(c.count,0);assert.equal(await c.get('a',()=>42),42);
});
test('project changes clear references and in-flight old loads cannot repopulate the cache',async()=>{
 const c=referenceCache();let finish;const pending=c.get('a',()=>new Promise(r=>finish=r),()=>8);await Promise.resolve();c.clear();const fresh=await c.get('a',()=>({new:true}),()=>4);finish({old:true});await pending;assert.equal(await c.get('a',()=>{throw Error('unexpected');}),fresh);assert.equal(c.bytes,4);assert.equal(c.count,1);
});
