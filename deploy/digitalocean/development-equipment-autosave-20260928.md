# Equipment autosave — September 28, 2026

Existing equipment units and equipment type definitions now save edits without a
Save Changes/Save button. Text waits 500 ms after input; selections and changes
save immediately. A compact fixed bottom-right Saved toast appears only after a
successful write. The editor stays open and its input focus is preserved.
New unit/type creation retains its explicit creation action.

Writes are serialized per editor and newer snapshots queue behind in-flight
requests. Each request uses the revision returned by the previous successful
write. Save errors retain pending values, show an inline message and Retry, and
prevent explicit popup close until saved. Required names are checked before a
request. Close and route transitions flush pending changes; unmount starts a
flush, and page unload warns while requests/drafts remain pending. Uploads,
condition-note removals and media changes participate in unit autosave. Clearing
the home facility now persists that selection rather than restoring the old yard.
No API/schema/permission changes; this uses the existing revision-aware endpoints.

Validation: JavaScript syntax and three focused browser/contract checks. Chromium
covers type name/icon saves, no existing-record save buttons, required-name
validation, failed save retention/retry, slow serialized requests with newer edits,
revision progression, preserved focus, immediate selections, close/unmount flush,
Saved feedback, and earlier status/icon/layout behavior. APIs use synthetic fixtures.

Deployment: only public/libraries/apps/equipment/app.js from the canonical commit,
over each verified live development web baseline. Verify per-node readiness,
development isolation and hashes, public health/hash and the served script's
browser flow. Evidence: output/equipment-autosave-20260928/ (ignored).
No database, topology, service configuration or production changes.
Rollback: inspect intervening releases before restoring the previous per-node
receipt baseline through the existing symlink/service workflow, then verify
readiness/isolation. Autosaved data is not undone by a code rollback.
