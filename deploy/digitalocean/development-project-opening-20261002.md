# Development project opening â€” October 2, 2026

Deployed source release `d0d196f2da0b1092c693ae5910a48e438e2e67ac` to development web, compatibility/legacy and pool roles. Previous release on these roles was `667433e375ed90daf07d7f74b206018bac12ae5a`. User explicitly authorized development deployment. Worker and production were not changed.

## Behavior and cause

Every project iframe previously loaded another portal document with timestamp-versioned assets, defeating reuse between opens. Portal bootstrap performed independent requests serially, and the project fetch started late. Initial rendering could mount the default app before the requested app and reveal unfinished window controls.

The parent now paints the known title/address and an inline-SVG close control immediately, and starts the authoritative project read concurrently with iframe startup. A window-, organization- and project-bound one-shot bridge hands the result to the child. The child renders the shell before mounting the selected app, avoids duplicate hydration/mount work, and is revealed only when its styled shell is ready. Provisional editing is inert. Independent bootstrap requests run concurrently; portal assets use content hashes so unchanged files retain their browser cache URLs.

## Deployment and validation

- Six runtime files deployed as guarded immutable role payloads. Three-way source merges preserved existing role differences and unrelated local work. Only task-owned changes were committed.
- 20 focused local tests passed, covering opening, portal asset caching, capability recovery, project chrome, window shell/manager and project trays. Actual per-role payload checks passed 14 tests. JavaScript syntax and PHP lint passed.
- The separate project-feature-gates autocomplete regex assertion also fails against the pre-change source; this unrelated failure was not changed.
- All three activated roles passed release, hash, readiness, development data/session and outbound-isolation checks. Backend fingerprint remained `301b07db99d4778f9f33ef308868d787a472ca96490f343cfdae76b369f51719`.
- Staging initially stopped on a transient readiness HTTP 503 before activation. Readiness recovered and all checks were rerun successfully; no guard was bypassed.
- Four public JavaScript assets matched expected deployed content. Two authenticated portal responses retained identical script URLs, including 155 content-versioned references. HTML response times were 474 ms and 331 ms; these are not full project-opening measurements.
- A real browser on the public development portal showed the immediate loading header/close control, then the styled New Project form. The unsaved form was closed. The accessible sandbox had no saved projects, so saved-project/tab end-to-end latency remains unmeasured. No subsecond completion claim is made.

## Rollback and limits

Ignored operational evidence is under `output/project-opening-20261002`, including manifest, role payloads, verification results and deployment scripts. Installed role release receipts are `channels-release.json`; use their `previous_path` and the guarded rollout workflow to restore the prior role release. Release artifact staging is under `/opt/firstmeasure/channels-release-d0d196f2`.

This updates the currently running development roles. Existing autoscale replacement-image/template limitations remain; no provider topology or replacement image was changed. Cold iframe startup and selected-tab-specific data can still take time, even though reusable assets and known window chrome no longer need to wait for that work.
