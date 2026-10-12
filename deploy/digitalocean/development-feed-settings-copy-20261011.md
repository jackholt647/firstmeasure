# Feed settings wording — October 11, 2026

Source commit `d6f3d5e33f7391a35df0eba57b7bad326892701c` replaces the
Automatic posts description with the exact requested text:

> These settings control which activity automatically appears in the posts view. List and thumbnail views always include all activity. Posts submitted manually always appear in posts view.

The settings file was absent from canonical source but already deployed from
`codex/feed-permissions-autosave-20261010`. Its live bytes matched that branch
on all three dev frontend roles before the wording replacement. Only this one
browser file is overlaid onto the current release; its controls are preserved.

Activated successfully on web, pool and compatibility from audited current
releases, with JavaScript syntax and Linux TypeScript checks passing before
activation. Final per-role and public asset hashes matched the committed file;
readiness and enforced development isolation passed. The publicly served script
contains the exact requested text and no longer contains the prior wording.
Scripts, baseline/payload hashes and receipts are in ignored
`output/feed-settings-copy-20261011/`.

Rollback should restore the single description in the latest settings file,
preserving any subsequent changes. Do not replace a whole release to revert copy.
