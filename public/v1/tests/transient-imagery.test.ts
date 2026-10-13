import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchSolarWithRetry, isTransientProviderFailure } from '../firstmeasure/transient_failure.js';
import { imageryFailurePatch, fetchRequiredSolarLayers } from '../firstmeasure/solar_imagery.js';

test('throttles retry with delay; genuine missing coverage does not retry', async () => {
  const original=globalThis.fetch; let calls=0; const delays:number[]=[];
  try {
    globalThis.fetch=async()=> new Response('',{status:++calls<3?503:200});
    assert.equal((await fetchSolarWithRetry('https://example.invalid',undefined,async ms=>{delays.push(ms);})).status,200);
    assert.equal(calls,3);assert.equal(delays.length,2);assert.ok(delays[1]!>=500);
    calls=0;globalThis.fetch=async()=>{calls++;return new Response('',{status:404});};
    assert.equal((await fetchSolarWithRetry('https://example.invalid')).status,404);assert.equal(calls,1);
  } finally {globalThis.fetch=original;}
});
test('persistent overload stays retryable and is never classified as no coverage', async()=>{
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async()=>new Response('',{status:429});
    await assert.rejects(fetchRequiredSolarLayers('https://example.invalid'),error=>{
      assert.equal(isTransientProviderFailure(error),true);
      assert.equal(imageryFailurePatch(error).structure_pin_status,'retry_pending');
      assert.notEqual(imageryFailurePatch(error).status,'rejected');return true;
    });
  } finally {globalThis.fetch=original;}
});
