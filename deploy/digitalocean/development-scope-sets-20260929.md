# Scope Sets — development, September 29, 2026

Source and development release: `9cfc7fc78d0c55bd83d6a4b0e70c9ed554d88906`.
Previous release on both web nodes and compatibility:
`45cad4faddf640bdbd00b3e7021852345ba0e35d`.

The Scope Sets sidebar removes duplicate project notes. Existing lists render
before catalog, workforce and measurement requests finish; normal refresh
initializes only when there are no lists. The tab loads the shared FirstMeasure
measurement source, supplies report values when scope measurements are absent,
and retains explicit saved scope and piece measurements. Empty default values
do not mask a completed report. Regeneration surfaces missing resource list
definitions and permission failures instead of showing success for empty output.

The release overlays only the Materials project script and its bundle token onto
each role's existing release. Compatibility retains its older note audio icon
inside the unused note renderer, and unrelated live manifest entries are retained.
Seven focused UI regressions, five Materials API tests, JavaScript syntax and
TypeScript checks passed. Release artifacts, baseline hashes and rollout scripts
are in ignored `output/scope-sets-20260929/`.

Both development web nodes and compatibility passed guarded activation,
development isolation, local readiness and final file-hash checks.

Public verification matched both changed asset hashes and six development
readiness responses. All seven UI regressions also passed using the script
downloaded from dev.1m8.ai.

The exact customer demo project was not identified in this chat; its selected
scope and report configuration still require project-specific verification.

Rollback: check for newer releases, restore the previous role release through
the atomic current symlink, and restart the development web or compatibility
service and PHP FPM one role at a time, checking readiness after each change.
Production and the development worker are unchanged.
