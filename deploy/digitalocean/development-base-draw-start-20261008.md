# Shared base corner drawing - October 8, 2026

The shared 3D picker visits wall vertices before coincident base vertices. N
therefore started a vertical wall draft at a bottom corner even when the intended
operation was a cut across the purple base. The wall drawing handler now hands a
single supported base point to the base editor before creating a wall draft.
Explicit wall face selection remains authoritative unless the cursor is over a
base face. Base handoff verifies plane membership and leaves upper wall points
with the wall editor. Starting the tool does not change geometry.

Validation: the shared-corner routing regression fails on the preceding source
and passes with this change. All 45 base editor/control tests passed. Focused
regressions also cover pitched-base splitting and undo, rejection of an off-plane
wall point, and retaining an explicitly selected wall face. The wall suite passed
425/426 before the final explicit-face regression was added; its only failure is
the previously recorded generated chimney-support face selection test. All three
new regressions passed together after the final test changes. Four runtime files
passed JavaScript syntax checks.

Source commit 2ef778a1729ca6777d72318ebea082d20c69f3b4 was pushed and deployed as
an owned-file overlay on development web, pool and worker. Every deployed file
hash matched; runtime readiness and development isolation passed on all three.
Internal-editor capability and the saved Lake Washington Boulevard project both
returned HTTP 200 on both web nodes. No customer project data was changed.
Production was untouched. The compatibility mirror remains excluded because of
the previously recorded storage reserve/inode limits.
