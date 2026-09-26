# Mobile final order readiness — September 25, 2026

Source and development release: `060150a24dd4e70d62593a2fbe466a0f191e93e1`.

## Cause and correction

The mobile pager changed the exterior controller from Details to Review, then copied the generic submit button disabled state computed on Details. This left both buttons disabled even with eight uploaded angles and valid pricing. Recompute the shared submit predicate after the page transition and synchronize both controls. Preserve the spinner lock while submitting; existing photo and order validation still applies.

## Verification

- Three mobile navigation tests passed, including a regression for stale disabled state, actual underlying submit enablement, an upload blocker and an in-flight submission lock.
- Nine exterior photo workflow tests passed against the immutable release checkout.
- JavaScript syntax check passed. No order was placed.
- Deployment clones each current development release and changes only `public/libraries/apps/project-request/app.js` and release metadata. Baseline hash and symlink guards protect concurrent work.
- Prior web-one release: `85174c5296db43ff46022d9c5c679a4dd7cf44b5`.
- Prior web-two release: `93c0a6460f1c173c8523e4170615e9d7b0571a91`.
- Production and native binaries are unchanged.

Both development web nodes passed readiness on the release above with development isolation enforced. The public script exactly matched SHA-256 a068e65f1befbef2fce264627de9deb9849d4c55207f4da08c78f7f12115c204.
