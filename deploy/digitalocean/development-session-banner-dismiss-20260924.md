# Session-only attention banner dismissal — September 24, 2026

Commit `b545ad88cef850b235e9dca15de2fedb1848374b` adds an X to both the
shared top attention bar and the sidebar attention card. Each X hides that
entry on its own surface for the current browser tab session. Dismissal is
scoped by organization, user, banner ID, and surface in `sessionStorage`; it
survives reload and polling, then resets in a new session. The notification
surface remains visible, and the X does not call the server's persistent
per-user dismissal API. Existing source-specific `dismissible` rules remain
available to server feeds but no longer gate these local X controls.

The release was staged from the exact development web baseline
`c9bb07c2204098c7e2afbe0c023971034f52aca8`, with only
`public/libraries/platform-banners/platform-banners.js` and its focused test
overlaid. Payload SHA-256:
`fd282a490e9aab9f1f321113066a4700ddb5555ca4cdd03c32d32f26dc7441c7`.
Both serving development web nodes reported the exact new release ID with
healthy development readiness. JavaScript syntax check and both focused tests
passed.

In Chrome, the generated full organization showed both X controls on the
"Finish setting up payments" banners. Closing the top bar left the sidebar
card visible; closing the card removed it. Both stayed hidden after reload.
A fresh tab showed the banners again. The temporary sidebar expansion used
to exercise its X was restored to the original compact preference. Production
was not changed. The development autoscale image remains historical and needs
this release before a replacement node can preserve the behavior.

Rollback target on both development web nodes:
`c9bb07c2204098c7e2afbe0c023971034f52aca8`.
