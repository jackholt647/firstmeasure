/* FirstMate application undo/redo
 *
 * Feature code registers reversible commands here after a mutation succeeds,
 * or uses perform() to run and register a command together. Browser navigation
 * and native text-editing history remain separate concerns.
 */
(function(root){
  'use strict';

  const Portal = root.Portal = root.Portal || {};
  const undoStack = [];
  const redoStack = [];
  const listeners = new Set();
  const keyboardGuards = new Set();
  const suspensions = new Set();
  const MAX_DEPTH = 100;
  let sequence = 0;
  let busy = false;
  let queue = Promise.resolve();

  const clean = (value) => String(value ?? '').trim();

  function publicCommand(command){
    if (!command) return null;
    return {
      id: command.id,
      label: command.label,
      scope: command.scope,
      metadata: { ...command.metadata },
      recordedAt: command.recordedAt
    };
  }

  function getState(){
    const undoCommand = undoStack[undoStack.length - 1] || null;
    const redoCommand = redoStack[redoStack.length - 1] || null;
    return {
      canUndo: !!undoCommand && !busy,
      canRedo: !!redoCommand && !busy,
      undoLabel: clean(undoCommand?.label),
      redoLabel: clean(redoCommand?.label),
      undoDepth: undoStack.length,
      redoDepth: redoStack.length,
      busy,
      suspended: suspensions.size > 0,
      undoCommand: publicCommand(undoCommand),
      redoCommand: publicCommand(redoCommand)
    };
  }

  function notify(reason = 'state'){
    const state = getState();
    listeners.forEach((listener) => {
      try { listener(state, reason); } catch (_) {}
    });
    try {
      root.dispatchEvent(new CustomEvent('fm:undo:state', { detail:{ ...state, reason } }));
    } catch (_) {}
  }

  function normalize(command = {}){
    if (!command || typeof command !== 'object') throw new TypeError('Undo command must be an object.');
    if (typeof command.undo !== 'function' || typeof command.redo !== 'function') {
      throw new TypeError('Undo commands require undo and redo functions.');
    }
    return {
      ...command,
      id: clean(command.id) || `undo_${Date.now().toString(36)}_${(++sequence).toString(36)}`,
      label: clean(command.label) || 'change',
      scope: clean(command.scope) || 'application',
      metadata: command.metadata && typeof command.metadata === 'object' ? { ...command.metadata } : {},
      mergeKey: clean(command.mergeKey),
      recordedAt: new Date().toISOString()
    };
  }

  function record(command){
    const next = normalize(command);
    const previous = undoStack[undoStack.length - 1];
    if (next.mergeKey && previous?.mergeKey === next.mergeKey && previous.scope === next.scope) {
      previous.redo = next.redo;
      previous.label = next.label;
      previous.metadata = next.metadata;
      previous.recordedAt = next.recordedAt;
    } else {
      undoStack.push(next);
      if (undoStack.length > MAX_DEPTH) undoStack.splice(0, undoStack.length - MAX_DEPTH);
    }
    redoStack.length = 0;
    notify('record');
    return publicCommand(next);
  }

  async function perform(command){
    const execute = command?.do || command?.execute;
    if (typeof execute !== 'function') throw new TypeError('perform() requires a do function.');
    const result = await execute();
    record(command);
    return result;
  }

  function showResultToast(direction, command, error){
    const showToast = root.PlatformUI?.showToast || root.Portal?.ui?.showToast;
    if (typeof showToast !== 'function') return;
    if (error) {
      showToast(direction === 'undo' ? 'Could not undo' : 'Could not redo', clean(error?.message) || command.label, false);
      return;
    }
    const title = direction === 'undo' ? `Undid ${command.label}` : `Redid ${command.label}`;
    const hint = direction === 'undo' ? 'Press Ctrl+Y to redo.' : 'Press Ctrl+Z to undo.';
    showToast(title, hint, true);
  }

  async function apply(direction){
    const source = direction === 'undo' ? undoStack : redoStack;
    const destination = direction === 'undo' ? redoStack : undoStack;
    const command = source.pop();
    if (!command) return { ok:false, empty:true, direction };
    busy = true;
    notify(`${direction}:start`);
    try {
      const result = await command[direction]();
      destination.push(command);
      showResultToast(direction, command);
      try {
        root.dispatchEvent(new CustomEvent('fm:undo:applied', {
          detail:{ direction, command:publicCommand(command), result }
        }));
      } catch (_) {}
      return { ok:true, direction, command:publicCommand(command), result };
    } catch (error) {
      source.push(command);
      showResultToast(direction, command, error);
      try {
        root.dispatchEvent(new CustomEvent('fm:undo:error', {
          detail:{ direction, command:publicCommand(command), error }
        }));
      } catch (_) {}
      return { ok:false, direction, command:publicCommand(command), error };
    } finally {
      busy = false;
      notify(`${direction}:finish`);
    }
  }

  function enqueue(direction){
    const operation = () => apply(direction);
    const next = queue.then(operation, operation);
    queue = next.catch(() => null);
    return next;
  }

  function undo(){ return enqueue('undo'); }
  function redo(){ return enqueue('redo'); }

  function clear(options = {}){
    const scope = clean(options.scope);
    if (!scope) {
      undoStack.length = 0;
      redoStack.length = 0;
    } else {
      for (let index = undoStack.length - 1; index >= 0; index -= 1) {
        if (undoStack[index].scope === scope) undoStack.splice(index, 1);
      }
      for (let index = redoStack.length - 1; index >= 0; index -= 1) {
        if (redoStack[index].scope === scope) redoStack.splice(index, 1);
      }
    }
    notify('clear');
  }

  function subscribe(listener){
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    listener(getState(), 'subscribe');
    return () => listeners.delete(listener);
  }

  function suspend(reason = 'feature'){
    const token = Symbol(clean(reason) || 'feature');
    suspensions.add(token);
    notify('suspend');
    return () => {
      if (suspensions.delete(token)) notify('resume');
    };
  }

  function registerKeyboardGuard(guard){
    if (typeof guard !== 'function') return () => {};
    keyboardGuards.add(guard);
    return () => keyboardGuards.delete(guard);
  }

  function hasNativeEditingHistory(target){
    if (!target || typeof target.closest !== 'function') return false;
    if (target.closest('[contenteditable="true"],[contenteditable="plaintext-only"],textarea,[data-fm-native-undo]')) return true;
    const input = target.closest('input');
    if (!input) return false;
    const type = clean(input.type || 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(type);
  }

  function localUndoSurfaceIsActive(){
    return !!root.document?.querySelector?.(
      '.fm-photo-modal.markup-active, #rProposalPreview .markup-active, [data-fm-undo-scope="local"]'
    );
  }

  function keyboardAllowed(event){
    if (suspensions.size || busy || event.defaultPrevented || event.repeat || event.altKey) return false;
    if (hasNativeEditingHistory(event.target) || localUndoSurfaceIsActive()) return false;
    for (const guard of keyboardGuards) {
      try { if (guard(event, getState()) === false) return false; } catch (_) {}
    }
    return true;
  }

  function onKeydown(event){
    if (!(event.ctrlKey || event.metaKey) || !keyboardAllowed(event)) return;
    const key = clean(event.key).toLowerCase();
    const direction = key === 'y' || (key === 'z' && event.shiftKey) ? 'redo' : (key === 'z' ? 'undo' : '');
    if (!direction) return;
    const state = getState();
    if (direction === 'undo' ? !state.canUndo : !state.canRedo) return;
    event.preventDefault();
    event.stopImmediatePropagation?.();
    void (direction === 'undo' ? undo() : redo());
  }

  const api = {
    record,
    perform,
    undo,
    redo,
    clear,
    subscribe,
    suspend,
    registerKeyboardGuard,
    getState,
    get applying(){ return busy; }
  };

  root.PlatformUndo = api;
  Portal.undo = api;
  root.addEventListener?.('keydown', onKeydown);
})(window);
