# Contact window and modal identity icons — development, September 29, 2026

Source and development web release: `72482beb4b9cfbc45c01771ba6be8adf1f8ed672`.
Previous release on both web nodes: `4733be6b2b99fc7ae303b96bc72b6210c7910375`.

Contacts now uses the shared window manager for modal, floating, docked,
workspace fill, fullscreen, minimize/restore, pin and close. Its existing
contact fields, project list and unsaved input remain mounted across placement
changes. Project and Contact show their respective icons beside the current
title in the window header and minimized bar. The Contact detail heading also
shows its contact icon. Minimized bars retain only Restore and Close controls
so their titles have room.

The three changed frontend assets were overlaid onto each node's current
development release. Live baselines matched the parent source commit before
staging. Each node was activated separately with development environment,
session cookie, readiness and file hash checks. Both nodes verified the new
release; the three public asset hashes and six public readiness responses
matched. Local Chromium checks passed for Project and Contact window modes,
minimize/restore, retained draft values and close. Evidence and guarded
rollout scripts are in ignored `output/contact-window-20260929/`.

Rollback requires checking for newer releases, then restoring each node's
previous release through the atomic current symlink and restarting its web
service and PHP FPM, one node at a time. Production and other development
roles were unchanged.
