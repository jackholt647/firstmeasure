# Editor toolbar layout runaway — development, October 19, 2026

Source `7c49b06e2a7c92c1fe925ba9a11a39704a32dc23`.

**Problem.** An idle full-house editor used more and more memory and CPU the longer it stayed open.

**Cause.** In `editor.php`, `updateToolbarLayout` removes and re-adds `toolbar-split` on `#global-toolbar`. A
MutationObserver on that toolbar's attributes reacted to the write and queued another `requestAnimationFrame` pass. Each
pass queued another, and the ResizeObserver added more whenever the split changed the toolbar's size. The number of
queued passes therefore grew without bound. Each pass forced a full layout.

Measured on dev with the pilot project, idle:
- 50,000 toolbar callbacks per second at load, 103,000 per second after 2.5 minutes, still climbing;
- CPU rose from 44% to 80% of a core over 3 minutes.

**Fix.**
- The observer ignores the toolbar's own class writes.
- Only one layout frame is queued at a time.
- The wall panel's per-redraw writes in `wall_mode.js` `updateInteraction` happen only when a value changes; they
  previously woke the observer about six times a second.
- The claim timer's zone class and tooltip are written only on change.

**After.** Zero toolbar callbacks and about 180 frame callbacks per second in total (3D view, globe and claim timer). CPU
stays flat at about 17%. Renderer and GPU memory were flat in the headless runs both before and after the fix, so the
memory climb on a desktop machine was not reproduced directly.

**Tests.** `dev/wall-mode.test.cjs` 92 pass. The idle probes are `output/full-house-pilot-20261019/leak*.cjs`.

**Rollout.** `editor.php` and `wall_mode.js` were overlaid on web, legacy and pool. All roles verified, and an unpatched
probe of live dev confirms the result. The worker and production were not changed.
