# Project tooltip lifecycle fix

Release: `d6715469f8a24bf642d1de2b89c1d806b5c24485`.

The shared tooltip controller previously relied on bubbling mouseout/focusout/activation events, and only checked whether an anchor remained connected. A stopped event, hidden connected control, or layout change could leave the tooltip visible at stale coordinates. The screenshot alone does not establish which path triggered the reported instance.

Dismissal events now run in capture phase. Pointer movement away, document exit, window blur, page hiding and Escape dismiss the tooltip. While visible, the controller checks anchor visibility and geometry; delayed reveals also reject moved anchors. Keyboard focus tooltips remain supported. This changes the shared controller rather than removing the Close project hint.

Validation: browser regression covers stopped propagation, activation suppression, moved/hidden controls, keyboard focus/Escape, blur and movement during delayed reveal. The existing shared-tooltip contract test passes. Deployment overlays only platform-ui.js on the development web/pool baseline; no backend, production or configuration changes. Portal asset URLs already use the file hash for cache invalidation. Role baselines, payload hashes and rollback paths are recorded in `output/project-tooltip-lifecycle-20261002/manifest.json`.

Deployed and verified on development web and pool. Public asset hash matches the payload, and the browser regression passes using the served dev JavaScript. The same regression failed against the pre-update file during the rolling deployment, reproducing the stopped-event dismissal defect.
