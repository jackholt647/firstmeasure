# Canonical combined platform â€” September 23, 2026

The canonical working directory is `C:/Users/jackh/Code/2026/FirstMate Platform`.
The branch is `codex/consolidated-firstmeasure-20260923`. It combines FirstMate
platform apps, FirstMeasure report/exterior tools, and the mobile hosts/native
projects. The repository remote remains `jackholt647/firstmeasure`; renaming the
local directory does not rename the repository or change GitHub's default branch.

## Provenance

- Former main directory `FirstMeasure`: `codex/internal-exteriors`, `e63c781721e6863bf34f9a9c86737e9630f30893`, with 206 individually enumerated dirty files (189 status entries when untracked directories were collapsed).
- Integrated platform worktree: `codex/firstmate-platform-integration`, `686d3fe0daf97d0e27596f135cc489d17afd783b`, with 1,014 individually enumerated dirty files (613 collapsed entries).
- Complete integrated development baseline: `2325b63c541aec4eb785a8998f2d11a752755d47`; its release record explains the platform, localization and exterior reconciliation.
- Latest exterior lineage: `27bb74d8b337df59cfbe8bde631930d6d88dde72`, including runtime `03c76e5d5c4cb02f50940503691e7a640c353720` and its Resoffit/performance fixes.
- Mobile lineage: `37a4bd9a915f16b0578995afd13ddbe0003462b2`. Mobile implementation already belongs to the exterior ancestry; its one unique later commit updates the rollout record. Both histories are merged.

All 17 registered worktrees were inventoried. Chimney shell/soffits, shallow
clearance, Resoffit, roof layers, references, and opaque-depth tips are already
ancestors. Wall-plane, Core Views, Linear Fixes, Training and Trim have only
unique rollout-documentation commits beyond the chosen lineage. Missing wall-
plane, Linear Fixes, garage-door backing and production bugfix records were
retained. Core Views and textured-control records already match. Production
193/189/190 code fixes are patch-equivalent (`git cherry`) to included changes.
No older production experiments or deployment archives were imported as code.

## Dirty-source reconciliation and recovery

Before changing the main directory, all dirty tracked/untracked files in main,
integration, Trim and production-artifact worktrees were archived and SHA-256
verified outside the checkout:

`C:/Users/jackh/Code/2026/FirstMeasure-consolidation-recovery-20260923-001654`

The directory contains four ZIP archives, original index/working patches,
worktree inventory, per-file hashes, baseline comparisons and three-way review
copies. The original main dirty state is additionally retained in Git stash
`d2f6185e343defbb95e6469401744a2e7ac9e617`; it was not dropped or blindly applied.
Other worktrees were not modified or deleted. Treat them as recovery references,
not alternate active development directories.

Of the dirty files, 182 main, 1,001 integration and eight Trim files exactly
match the selected latest source after line-ending normalization. Others match
an integrated/historical revision or were reviewed by three-way comparison.
Conflicting older localization, field-access, renderer and geometry fragments
were superseded by the newer integrated implementations. The only remaining
non-conflicting code delta was the missing `project` parameter on
`formatRoofingSquareRange`; it is retained with a regression covering imperial,
metric and repeated cross-project rendering. No unresolved source conflict is
intentionally carried forward. Eight old production packaging/audit artifacts
remain only in their original worktree and the recovery archive.

Ignored environment/configuration, databases, output, local runtime assets and
native build artifacts remain with the moved directory. Dependencies were
aligned to the committed package manifest without modifying its lockfile.
No local `local-stack.config.json` existed at consolidation time. Local launchers
derive their directory from the script path; their standard setup requirement
still applies. Git worktree back-references must be repaired after the move.

## Validation and existing limitations

- TypeScript check passes after dependency alignment.
- 28 focused portal, ordering, billing-resume, mobile-bridge and browser tests pass.
- Eight localization/API/browser/report tests and the isolated mobile API test pass.
- Full editor suite: 1,132/1,134 pass. The two curved-surfaces failures at lines
  71 and 78 reproduce unchanged in the unmodified latest exterior worktree.
  They concern eave curtains during curved extrusion and predate consolidation.
- The report-range regression passes inside the full suite.
- Navigation/settings contract checks pass 46/50; all four failures reproduce
  in the unchanged latest exterior worktree (invoice UI, Docs gallery, sharing
  feedback and Money settings expectations).

This is not a claim that every inherited platform contract is green. Earlier
platform/mobile deployment records document unrelated broader-suite failures.
Physical iPhone distribution still needs signing; consolidation does not certify
real-device provider/camera flows or authorize store publication.

## Development source and deployment workflow

Develop here and commit to the canonical branch. Push that branch, then stage
an immutable release from the exact commit. Verify hosted content against the
previous release before overlaying source; preserve environment, data, org flags,
private mobile builds and runtime-only assets. Build/check the Linux runtime and
activate the existing development web, worker and compatibility roles with
rollback and per-role verification. Do not turn a live release directory into
a mutable development workspace, change topology, or infer production approval.

The September 23 development baseline was verified on all three roles as
`03c76e5d5c4cb02f50940503691e7a640c353720`. Application source matched. Drift was
limited to older deployment templates/tests and worker lockfile platform
metadata; the canonical source retains the newer PHP-release safeguards and
mobile test expectations. Installed service/NGINX configuration is preserved.

Deployment identity and checksummed source/runtime manifests are recorded in
ignored `output/consolidation-20260923/`, and installed as release evidence on
each development role. Compare canonical `git rev-parse HEAD` with each running
`RELEASE_ID`, source manifest and public readiness; the release artifact, not
an old task label or directory name, establishes deployed identity. Historical
worktrees and production retain their existing branch identities.

The original function/action and data-publication architecture audit is a
separate pending read-only deliverable against this consolidated baseline.
No publication architecture was implemented during consolidation. See the
[architecture continuity record](architecture/data-actions-continuity.md) for
agreed decisions, acceptance scenarios and the full-conversation continuation.

The renamed directory is the only physical canonical checkout. When necessary
for existing Codex task attachments, the former `FirstMeasure` path is retained
as a directory junction to `FirstMate Platform`; it is not a second checkout.
Use the new path for future projects and commands.
