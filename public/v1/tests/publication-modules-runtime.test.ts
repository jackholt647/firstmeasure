import test from "node:test";
import assert from "node:assert/strict";
import { runModuleCode } from "../documents/modules/runtime.js";

const broker = { read: async () => ({ items: [{ cube: 3, count: 4 }] }), invoke: async () => { throw new Error("Effects denied during evaluation"); } };
test("module executes raw JS with async JSON capabilities and no Node globals", async () => {
  const result = await runModuleCode({ source: `const cube = await api.data.read('cube'); return {outputs:{volume:cube.items.reduce((n, row)=>n+row.cube*row.count,0), node:typeof process}};`, inputs: {}, mode: "evaluate" }, broker);
  assert.deepEqual(result.outputs, { volume: 12, node: "undefined" });
});
test("module broker errors reject code execution", async () => {
  await assert.rejects(runModuleCode({ source: `await api.actions.invoke('pay', {}); return {outputs:{}}`, inputs: {}, mode: "evaluate" }, broker), /Effects denied/);
});
test("module interruption bounds loops and pending promises", async () => {
  await assert.rejects(runModuleCode({ source: `while(true) {}`, inputs: {}, mode: "evaluate", limits: { milliseconds: 50 } }, broker));
  await assert.rejects(runModuleCode({ source: `await new Promise(()=>{}); return {outputs:{}}`, inputs: {}, mode: "evaluate", limits: { milliseconds: 50 } }, broker));
});
test("module rejects cyclic and non-JSON output", async () => {
  await assert.rejects(runModuleCode({ source: `const a={}; a.a=a; return {outputs:a}`, inputs: {}, mode: "evaluate" }, broker));
  await assert.rejects(runModuleCode({ source: `return {outputs:{n:Infinity}}`, inputs: {}, mode: "evaluate" }, broker));
});
test("module cannot complete before accepted unawaited effects finish", async () => {
  let complete = false;
  const result = await runModuleCode({ source: `api.actions.invoke('slow',{}); return {outputs:{done:true}}`, inputs: {}, mode: "command" }, {
    read: async () => null,
    invoke: async () => { await new Promise(resolve => setTimeout(resolve, 100)); complete = true; return null; }
  });
  assert.equal(complete, true); assert.equal(result.outputs.done, true);
  await assert.rejects(runModuleCode({ source: `api.actions.invoke('slow',{}); return {outputs:{}}`, inputs: {}, mode: "command" }, {
    read: async () => null, invoke: async () => { await new Promise(resolve => setTimeout(resolve, 50)); throw new Error('late failure'); }
  }), /late failure/);
});
