# Wall undo history survives a reload — development, October 20, 2026

Source `77bc9692eba7ef4177ef49b6487e099c0706505e`.

**Report.** After resetting the exterior model, rebuilding it and reloading the page, undo stepped back through recent
work and then jumped to the model from before the reset.

**Cause.** On load, the wall model comes from the browser's local backup when it is newer than the last project Save.
The undo history, however, only ever came from the last Save, because the local backup did not store it.
`restoreHistory` therefore paired the newer local model with the Save's old history, plus one recovery step from the
saved model to the local one. Everything done since that Save collapsed into that single step. One more undo landed on
the saved model, which was from before the reset, and further undos walked that older session.

Reset itself is unchanged. "Clear exterior model" remains an undoable step within a session.

**Fix.**
- `EditorHistory.saveLocal`/`loadLocal` keep a packed, gzipped copy of the wall undo history in IndexedDB
  (`firstmeasure-editor-history`). Each copy is stamped with the local backup's `savedAt`.
- Wall mode writes it 1.5 s after each persisted change, and flushes on page hide and before switching projects.
- On load, `main.js` reads it before `WallMode.restore`. When the resumed local backup's stamp matches exactly, its own
  history is used. Otherwise the previous behaviour applies.

**Tests.**
- A new `dev/wall-mode.test.cjs` test fails on the previous code: one undo jumped to the saved model. It passes now.
- Wall, base and history suites: 1,284 pass.
- In a real headless browser on the pilot copy, the editor loads with the new scripts and the IndexedDB save and load
  round trip succeeds.

**Rollout.** `wall_mode.js`, `editor_history.js` and `main.js` were overlaid on web, legacy and pool. All roles verified,
and the served files match. The worker and production were not changed.
