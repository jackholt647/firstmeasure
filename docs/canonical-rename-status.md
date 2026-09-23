# Canonical directory rename status

Consolidation and development rollout are complete. The physical directory
rename is **blocked**, not complete. Actual canonical checkout:
`C:/Users/jackh/Code/2026/FirstMeasure`. Intended destination:
`C:/Users/jackh/Code/2026/FirstMate Platform`. No duplicate or junction exists.

## Verified release

Branch: `codex/consolidated-firstmeasure-20260923`.
Deployed revision: `ac96d0c19eb3256c01ed89ddc8bcd11d7c8bdc9a`.
All three development roles verified 2,507 packaged source files and one Linux
runtime; public readiness and five public assets matched. Production untouched.
This final handoff correction is a **documentation-only descendant** of that
revision, not the identical commit. Later feature work must be distinguished
from this verified baseline; compare Git history and deployment receipts.

The release includes coordinated exterior fix `28ac29f` and its record. Its five
concurrent dirty files were archived/stashed before merging their exact commit.
No independent later exterior work is implicitly included. The runtime was built
from `5c3af72`; no Node API source changed between that build and `ac96d0c`.
Runtime archive SHA-256:
`2254e37ed323a2015cb49b6b18eda1f7317f86a525a6797e50eca3730696ffe9`.

Evidence: ignored `output/consolidation-20260923/deployment-receipt.json`,
`final-source-manifest.json`, `final-stage-results.json` and
`activation-results-final.json`. Public 503s during web restart recovered.
The first worker activation rolled back because an over-strict environment
comparison included systemd's changing WATCHDOG_PID. Excluding that process ID
preserved comparison of actual configuration; final activation passed all roles.

## Complete the physical move after closing Codex

Native Move-Item failed with a directory-in-use error. Read-only inspection found
multiple Codex node_repl/node helpers whose current directory is this checkout.
Supported REPL resets did not release all holders. Two specifically identified
idle helpers were stopped; remaining multi-task helpers were not broadly killed.
No application services or browser tabs were closed for the rename.

After active tasks save/checkpoint their work, close Codex completely. From a
separate PowerShell window outside the checkout, run:

```powershell
& 'C:/Users/jackh/Code/2026/FirstMeasure-consolidation-recovery-20260923-001654/finish-canonical-rename.ps1'
```

The script verifies source/destination boundaries, the recorded expected Git
HEAD, clean tracked work and absent destination. It moves the one physical
checkout, repairs Git worktree references, and creates an old-path directory
junction to the renamed tree for existing task attachments. It deletes no old
worktrees and terminates no processes. It refuses newer dirty work or changed
HEAD: subsequent development requires refreshing the expected checkpoint after
review, not bypassing checks blindly. Another application's lock may still need
that identified application closed.

Reopen the new physical directory after success. The old-path junction is an
alias to the same tree, not a second checkout. Saved project labels may still
need selecting the new directory in Codex; do not modify app databases. A local
rename alone needs no deployment. All ignored artifacts remain in the unmoved
checkout until then; no local local-stack.config.json existed at consolidation.

## Validation and architecture continuity

TypeScript and Linux build pass; 28 focused portal/mobile, eight localization,
one isolated mobile API and three PHP deployment-safeguard tests pass. Original
exterior suite: 1,132/1,134; both failures reproduce unchanged. Navigation/settings:
46/50; all four failures reproduce unchanged. After the coordinated exterior
merge, 388 targeted sketch/wall tests pass. A fully green inherited suite is not
claimed. External dirty-work recovery archives and Git stashes remain retained.

[Architecture continuity](architecture/data-actions-continuity.md) links the
full-conversation fork and preserves decisions/acceptance scenarios. The fork
subsequently authorized all three architecture layers and clarified that this
naming-only blocker must not indefinitely hold implementation. Work can continue
in the actual canonical directory. This does not authorize automatic deployment
of the architecture rewrite or production changes.
