# Application undo and redo

Application mutations use `window.PlatformUndo` (also available as `Portal.undo`) for Ctrl+Z and Ctrl+Y. This history is separate from browser navigation and from editor-local histories such as photo or proposal markup.

## Behavior

- Ctrl+Z undoes the most recent supported application mutation.
- Ctrl+Y and Ctrl+Shift+Z redo it.
- Text inputs, textareas, contenteditable regions, and elements marked `data-fm-native-undo` retain native editing history.
- A feature with its own active history can render `data-fm-undo-scope="local"` or register a keyboard guard.
- History is bounded to 100 commands and remains in memory for the current browser tab. It is intentionally not persisted across reloads or user sessions because saved commands could become stale or apply under a different authorization context.
- A new command clears the redo stack. Failed undo/redo operations remain available to retry and surface an error toast.

## Registering a mutation

Register only after the original server write succeeds. Capture the prior values before that write and use stable entity identifiers in both compensation functions.

```js
const previous = project.status;
await PlatformAPI.projects.patch(orgId, project.id, { status:'scheduled' });

PlatformUndo.record({
  label: `scheduling “${project.title}”`,
  scope: `projects:${orgId}`,
  metadata: { entityType:'project', entityId:project.id, action:'schedule' },
  undo: () => PlatformAPI.projects.patch(orgId, project.id, { status:previous }),
  redo: () => PlatformAPI.projects.patch(orgId, project.id, { status:'scheduled' })
});
```

Use `PlatformUndo.perform()` when the feature benefits from keeping the original write and command registration together. Undo and redo functions must reject when their compensating write fails; the central service then keeps the command on its current stack.

Commands should dispatch the feature's normal update event or refresh its controller after compensation so every open surface reflects server state. Use `mergeKey` for a series of replace-like edits that should undo as one command.

## What belongs in history

Reversible data mutations belong in application history: field edits, schedule changes, item completion, proposal edits, and reversible create/archive operations. Page navigation stays in `Portal.navigation`; menus, selections, and other transient UI state stay out of both histories.

Actions with irreversible external effects must not claim full undo unless the command compensates those effects. Examples include sending messages, charging a card, filing externally, or permanently deleting a remote object. A status compensation may restore FirstMate state, but it does not retract email already sent or reverse an integration that has no compensation API.

## Current coverage

Project and sidebar to-dos currently register:

- marking a to-do complete, using the work engine's explicit authorized reopen transition;
- snoozing/rescheduling a to-do until tomorrow, restoring the exact prior due value on undo.

The work engine continues to reject ordinary attempts to reopen terminal nodes. Only an explicit `allow_reopen` transition—the compensation used by the undo command—can reopen one, and reopening restores a completed plan to active state.
