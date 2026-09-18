# Exterior training practice — development

Runtime release: `a6282cafe40ff410945df3b27cf540849b14261f`.
Baseline: `8e062a062f871e8d9a56a939800f9e5e45d3c8b3` (chimney height extension retained).
Source branch: `codex/exterior-training`, isolated FirstMeasure Training worktree.

## Using exterior training

In Tutorials → Edit Curriculum, add a practice source from the existing project browser, its project ID, or the new **Exterior sources** search filter. Each practice row has a **Full exteriors** checkbox. Roof imagery (google.png/google.jpg or rgb.tif), a nonempty dsm.tif, and complete uploaded reference photos assigned to front/back/left/right qualify the source. Diagonal photos and video are optional. The initial selection follows this data check. Instructors can select Roof only for a qualified source and turn exteriors back on. Incomplete sources default to Roof only and display missing inputs. Readiness describes file availability, not an assessment of photograph quality or coverage.

Save the curriculum before starting a practice assignment. Scope is resolved from the saved assignment on the server, stored on each new student instance, and cannot be retargeted through editor patches. If an explicitly selected exterior source loses required files, starting it reports the missing inputs instead of silently switching it to roof. Existing attempts retain their original scope; old attempts without scope remain roof-only. Existing training curricula are not rewritten.

Exterior practice starts with blank geometry, loads roof/wall tools and Resources, persists wall/trim/view state, supports report preview, and uses ordinary training submission/completion. Source references are read-only; uploaded photos, video chunks and markups live on the student's isolated attempt. Instructors can open saved attempts for review. Exterior practice completes without a misleading roof score. Graded exams remain explicitly roof-only until an exterior grading rubric is implemented. Starter geometry and exterior automatic grading are not included.

## Access and persistence

A signed PHP-session bridge authenticates the complete training request to the compatibility API. Instructor permission is required for source discovery and readiness checks. Students can read only their own assigned source; instructors can review student instances. Answer geometry, source report snapshots, PDFs and source markup documents are not served by the source-file bridge. Training source reads do not broaden normal experimental-project access. The feature-enable flag still applies; the original experimental allowlist and production configuration are unchanged. No database migration is needed.

The PHP bridge uses the existing shared staff-tracking bridge secret when configured, with the compatibility internal secret as fallback. It deliberately avoids the separate web-only full-house signing override. No new credential or configuration is required.

## Validation

- Real Node + PHP integration: source readiness, automatic and explicit scope, missing data rejection, signed session authentication, cross-student denial, source artifact denial, source read-only protection, editor-patch provenance protection, wall module selection, reference browsing/uploads, blank starter geometry, exterior save/reopen, ungraded completion, instructor review and feature revocation.
- Integration passed on Windows and against the staged Linux runtime with temporary isolated data.
- Browser checks: automatic exterior/roof defaults, disabled unavailable-data toggle, explicit roof selection surviving rerender, switching back to exterior, changing source IDs including cached readiness, grading disabled, serialized curriculum retaining scope. No page errors.
- Existing curriculum cutover, full-house access, full-house PHP/order/reference tests passed; staff tracking's two tests passed with the PHP curl extension enabled.
- Fifty wall-mode and exterior-report tests passed. TypeScript check/build and changed PHP syntax checks passed.

## Deployment

Fifteen runtime source/compiled files are in `/tmp/training-delta.tar.gz` with `/tmp/training-delta.json` and guarded `/tmp/deploy-training.py` on all three development roles. Artifact SHA-256: `e2a2be065f42513c82a8c6c8459b8eb3c7c1e3708490b04c741110acc5d55328`. All three stages verified 18,080 other runtime files unchanged. Dependencies and other editor work are preserved. Source files were compared to the live baseline before staging; compiled TypeScript ships with its matching source.

All three development services activated and independently verified this exact release. The worker had no running jobs before restart. Public readiness recovered after load-balancer reentry and reports development data with outbound isolation enforced. All three changed browser scripts served through dev.1m8.ai match the tested source after newline normalization.

Authenticated live browser verification: opened Tutorials → Edit Curriculum in an unsaved test chapter, searched Exterior sources, selected an existing source with complete references, observed Full exteriors default on and Grading off/disabled, switched to roof-only and back to exteriors. The signed PHP-to-compatibility readiness request succeeded with the real service configuration. Reloaded to discard the unsaved chapter; no curriculum or source geometry was replaced. Actual drawing/save/completion was tested with isolated fixtures on Windows and the staged Linux runtime, not on a live student attempt. Production was not changed.

Rollback: restore the preserved baseline consistently across the development worker, web and compatibility roles, wait for no running worker jobs, restart the development services and PHP FPM on compatibility, then check exact release identity, readiness and enforced outbound isolation. Existing student data remains on the shared tutorial volume. Do not promote or activate production from this authorization.
