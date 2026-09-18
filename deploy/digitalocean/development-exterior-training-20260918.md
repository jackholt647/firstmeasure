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

## Full House Drawing curriculum scaffold

Follow-up runtime release: `b8d15b8a02828f6f114ea6a40b3aac68c9ac53e5`. Baseline: `e583720737060dac1494650f0546e8787c9dcb9a`, preserving the concurrent Resources/core-photo-views update. The initial activation attempt against the older baseline was stopped by the release guard before changing a service. The final delta changes only `public/measure/internal/index.php`; staging on each development role verified 18,094 other runtime files unchanged.

The course registry now includes `full-house-drawing` / **Full House Drawing**. The editable starter is versioned in `dev/curricula/full-house-drawing.json`. It contains eight chapters with objectives and suggested exercises: reference readiness, roof drawing, exterior shell, wall/chimney details, windows and doors, finishes and trim, report review, and independent instructor-reviewed practice. Media, project and exam lists are empty for the instructor to populate. No students were assigned or existing courses rewritten.

The starter was created exclusively (refusing overwrite) under the development compatibility service's configured durable tutorial root at `courses/full-house-drawing/master/curriculum.json`. The seed verified the running service was development and set ownership to the existing tutorial root owner. This is a one-time scaffold: future editor changes are authoritative; do not reapply the fixture over them. No production curriculum was created.

Validation: PHP syntax and diff checks passed. All three development roles activated and verified the follow-up release. Public readiness recovered with development isolation enforced. The authenticated browser displayed all eight saved chapters, opened the Full House Drawing editor, successfully saved through its normal Save Curriculum action, and reopened the editor. The editor was left open for the user.

## Assignment-only optional curricula

Runtime release: `7d341c1ececfdbbffa0167285bbfa50e7562d92b`, based on `c6963cea9c6bc4165c56b022021933ab7838b9d7`. The concurrent soffit and opaque-depth changes are preserved.

New Hire Training is the default for every employee. Account creation date no longer grants or selects Software Update Refresh. Software Update Refresh and Full House Drawing require explicit assignments. Instructors select a course in Tutorials and use **Assignments** to search people and assign or remove access. Students see New Hire plus their assigned optional courses in the selector. Managers retain editing/review access without being enrolled. The Student Progress list for an optional course includes its assigned students.

Assignments are stored on the existing internal user record as `assigned_tutorial_course_ids`. An existing explicit `assigned_tutorial_course_id` remains valid until the first assignment edit migrates it to the array. An empty array deliberately revokes all optional access. Removing access retains progress and project data; reassignment restores access. No users are enrolled by deployment, and no existing curriculum contents change.

Server checks cover curriculum fetch, start, progress, project save, artifact upload, the exterior source bridge, and PHP editor/resources access. PHP resolves the project's actual course so an omitted or changed query parameter cannot bypass revocation. Instructor assignment endpoints reject student requests.

Validation: TypeScript build/check and PHP/JavaScript syntax checks passed. Real PHP + Node integration tests exercise old unassigned accounts, default access, self-assignment denial, independent optional assignments, legacy explicit assignments, revocation, direct-link bypass denial, instructor review, retained work after reassignment, and existing exterior drawing behavior. The curriculum-cutover test now explicitly assigns its refresher student and passes.

Deployment: all three development roles staged the eight-file delta, verified 18,090 other runtime files unchanged, and activated the exact release with development isolation enforced. Production was not changed.

Live verification initially showed duplicate retained user records for the same email. The assignment-list follow-up resolves duplicates to the canonical user record used by assignment writes. Follow-up release `c7ad4a788c5dce86f62b1c10ff3ca52ff2d4d550` uses baseline `3ca9f780538614c3ab78a6f7bc11118faa0e6fe1`, preserving the concurrent opaque-mode default update. The guard rejected staging against the superseded baseline before changing it. Only internal API source and matching compiled output differ in the follow-up.

Follow-up validation: all three development roles activated `c7ad4a788c5dce86f62b1c10ff3ca52ff2d4d550`; staging verified 18,096 other runtime files unchanged. Public readiness reports this release with development isolation enforced. The authenticated browser defaults to New Hire, displays the assignment controls, and shows the refresher assignment list with one row per employee (including one canonical Jack Test row). Assignment and revocation writes were tested with isolated synthetic users, not live employees.
