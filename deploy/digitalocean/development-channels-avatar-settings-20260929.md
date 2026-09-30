# Assistant logo and Channels settings cleanup — September 29, 2026

Source/runtime release: `d4caa24f08abff96b3da647226c2f393b999ff17`.

The dedicated assistant conversation uses its explicit `assistant_dm` identity
to render the existing FirstMate logo. Removing the assistant from the exposed
member list had caused the sidebar to fall back to a name-only initials avatar.
The assistant remains hidden from membership and does not show a human presence
dot. Ordinary direct conversations retain their existing avatars and presence.

The redundant Channels app settings gear has been removed from the sidebar.
The app no longer supplies settings callbacks or exposes an overlay settings
entry point. Individual channel settings, autosave and archive dismissal remain.

JavaScript syntax and real-Chrome checks passed. Browser fixtures cover a
dedicated assistant DM with only the human exposed in its member list, verify
the existing logo mask rather than initials, and confirm no app settings entry
in either full or integrated-list mode. Existing channel settings autosave,
close flushing, archival and assistant member filtering also pass. The rendered
sidebar was inspected. Evidence: `output/channels-avatar-settings-20260929/`.

This is a three-asset frontend development overlay (Channels UI, app shell and
bundle manifest). It preserves concurrent work and live role-specific source.
No backend, schema, configuration, worker or production changes.

Activated on all three serving roles with hash, readiness and isolation checks.
Three public asset hashes and six public readiness responses matched the
release. The browser suite passed again with dev-served scripts.

Rollback predecessor on each serving role:
`5ad416c0685ec088fc5efc874eb2d574471d25b4`. Check for intervening releases before
restoring that immutable release pointer and restarting the role's service and
PHP-FPM. Verify development readiness and public assets afterward.
