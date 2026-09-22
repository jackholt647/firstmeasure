import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const undoSource = await readFile(path.join(publicRoot, 'libraries/platform-undo/platform-undo.js'), 'utf8');
const actionItemsSource = await readFile(path.join(publicRoot, 'libraries/platform-action-items/platform-action-items.js'), 'utf8');
const portalSource = await readFile(path.join(publicRoot, 'portal/index.php'), 'utf8');

function harness(){
  const listeners = new Map();
  class CustomEvent {
    constructor(type, init = {}){ this.type = type; this.detail = init.detail; }
  }
  const window = {
    Portal:{},
    document:{ querySelector(){ return null; } },
    addEventListener(type, listener){ listeners.set(type, [...(listeners.get(type) || []), listener]); },
    removeEventListener(type, listener){ listeners.set(type, (listeners.get(type) || []).filter((item) => item !== listener)); },
    dispatchEvent(event){ (listeners.get(event.type) || []).forEach((listener) => listener(event)); }
  };
  vm.runInNewContext(undoSource, { window, document:window.document, CustomEvent, console });
  return {
    window,
    api:window.PlatformUndo,
    keydown(event){
      const dispatched = { type:'keydown', shiftKey:false, altKey:false, metaKey:false, repeat:false, defaultPrevented:false, ...event };
      window.dispatchEvent(dispatched);
      return dispatched;
    }
  };
}

function keyboardEvent(key, target){
  return {
    key,
    ctrlKey:true,
    target,
    prevented:false,
    preventDefault(){ this.prevented = true; },
    stopImmediatePropagation(){ this.stopped = true; }
  };
}

test('the shared command stack undoes, redoes, and invalidates redo after a new change', async () => {
  const { api } = harness();
  let value = 1;
  api.record({ label:'changing value', undo:async () => { value = 0; }, redo:async () => { value = 1; } });
  assert.equal(api.getState().canUndo, true);
  assert.equal((await api.undo()).ok, true);
  assert.equal(value, 0);
  assert.equal(api.getState().canRedo, true);
  assert.equal((await api.redo()).ok, true);
  assert.equal(value, 1);
  await api.undo();
  api.record({ label:'new change', undo:async () => {}, redo:async () => {} });
  assert.equal(api.getState().canRedo, false);
});

test('a failed compensation stays undoable', async () => {
  const { api } = harness();
  api.record({ label:'failing change', undo:async () => { throw new Error('offline'); }, redo:async () => {} });
  const result = await api.undo();
  assert.equal(result.ok, false);
  assert.equal(api.getState().canUndo, true);
  assert.equal(api.getState().undoLabel, 'failing change');
});

test('Ctrl+Z uses app history outside editors and preserves native typing history', async () => {
  const { api, keydown } = harness();
  let value = 1;
  api.record({ label:'changing value', undo:async () => { value = 0; }, redo:async () => { value = 1; } });
  const textTarget = { closest(selector){ return selector.includes('textarea') ? this : null; } };
  const nativeEvent = keydown(keyboardEvent('z', textTarget));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nativeEvent.prevented, false);
  assert.equal(value, 1);

  const buttonTarget = { closest(){ return null; } };
  const appEvent = keydown(keyboardEvent('z', buttonTarget));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(appEvent.prevented, true);
  assert.equal(value, 0);

  const redoEvent = keydown(keyboardEvent('y', buttonTarget));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(redoEvent.prevented, true);
  assert.equal(value, 1);
});

test('the portal loads shared history before features that register commands', () => {
  const undoIndex = portalSource.indexOf('platform-undo/platform-undo.js');
  const actionItemsIndex = portalSource.indexOf('platform-action-items/platform-action-items.js');
  assert.ok(undoIndex > 0);
  assert.ok(actionItemsIndex > undoIndex);
  assert.match(actionItemsSource, /PlatformUndo\?\.record\?\./);
  assert.match(actionItemsSource, /action:'complete'/);
  assert.match(actionItemsSource, /action:'reschedule'/);
});
