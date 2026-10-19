# Full-house engine fixes — development, October 19, 2026

Source `ff9ad1c9470a4ebd20e72482b36493fa20dabf96` on `codex/consolidated-firstmeasure-20260923`,
one commit on `4f0e17a0`. It fixes the highest-severity items of the October 16 full-house
engine audit (`output/full-house-audit-20261016/FULL_HOUSE_BUGS.md`), from three fix sessions:

- **Wall editor (audit 1–4, 19, 26–28).** A roof change asks before discarding wall edits
  (unedited walls still rebuild silently; Undo restores). Wall mode owns the keyboard while a
  clicked 3D-toolbar control has focus, so roof shortcuts never see wall keys. A distance typed,
  or an arrow nudge, after orbiting replays the last pointer released instead of placing the
  stale preview. Line moves, nudges, transforms and steps keep deleted-face records, so Shift+F
  still restores them. Drawing, plain clicks and sticker hover no longer change saved drafts;
  the legacy draft repair runs once at load and before edits.
- **Kernel and extrusion (audit 9, 10, 29–36).** Unique `~region-k` ids with per-region anchors,
  and a load-time repair of saved duplicates. A hole touching its outline stays a hole.
  Triangulation welds touching vertices first. Sweep slivers and zero-area quantized rings are
  removed (the 1.6 m Clipper failure). Vertical and zero-area roof faces are skipped. Repeated
  vertices no longer sweep returns. Walls leaning up to 2° are roof-clipped. The fillet flap
  (`03caa748`) and eave curtain (`e3524410`) regressions are fixed.
- **Base and ground (audit 8, 11–14, 37, 64–66, 68–70, 124).** Sketch points keep to their faces
  on sloped bases. Height edits and fold deletes no longer drop faces, and there are no ghost
  copies. Closed loops make holes. Reground and DSM ground picks keep materials, stickers,
  sketch, curves and base cuts. Courtyards stay open, and a base above wall tops is refused.
  Curved-base previews are much faster (414 ms to 0.6 ms point checks with four arcs).

Another session's uncommitted plane Auto-step work in `wall_mode.js`, `wall_face_draft.js`,
`wall_steps.js` and its tests was deliberately left out of the commit and is not deployed. The
commit was built in a temporary index from HEAD plus only the fix sessions' hunks
(`output/full-house-fixes-20261019/candidate.py`, which asserts that replaying every hunk
reproduces the working copy).

## Checks

Run on a detached worktree of the exact commit with `public/v1/node_modules` junctioned:

- `node --test dev/*.test.cjs`: 1,597 of 1,599 pass. Two failures, neither caused by this commit:
  - `exterior-ai`: the AI tab has not been mounted since `d2ccc238`.
  - `wall-plane-editor.browser`: it fails on `4f0e17a0` too (`host.select` since `7c409009`). The
    uncommitted Auto-step test edit fixes it.
- Both `dev/exterior-engine-replay.cjs` runs: 160 previews, 0 failed.
- `php -l editor.php` is clean, and `node --check` passes on every editor script.

## Verified development rollout

Frontend editor files only (11 under `public/measure/internal/editor_scripts/`) were overlaid onto
each role's live release. Before the rollout, all three roles ran `4f0e17a0` with no drift in those
files, so no merge was needed. Each role was staged, then activated one at a time; the activation
reloaded PHP. The worker was not changed, and neither was production.

All three roles verified file hashes, runtime identity, readiness and development isolation.
Every one of the 11 files, fetched three times each over HTTPS from `dev.1m8.ai` (33 fetches),
matched the commit's SHA-256. `/v1/health/ready` reports `ff9ad1c9` in the development environment.
Logs, manifest and payloads are in `output/full-house-fixes-20261019/`.

| Role | Release | Previous |
| --- | --- | --- |
| web | `/opt/firstmeasure/releases/ff9ad1c9470a4ebd20e72482b36493fa20dabf96` | `/opt/firstmeasure/releases/4f0e17a0db6076d7680f23522c653d47546941aa` |
| legacy | `/mnt/firstmeasure_dev_releases/releases/ff9ad1c9470a4ebd20e72482b36493fa20dabf96` | `/mnt/firstmeasure_dev_releases/releases/4f0e17a0db6076d7680f23522c653d47546941aa` |
| pool | `/opt/firstmeasure/releases/ff9ad1c9470a4ebd20e72482b36493fa20dabf96` | `/opt/firstmeasure/releases/4f0e17a0db6076d7680f23522c653d47546941aa` |

Rollback: if nothing has been deployed since, restore each role's previous symlink and reload PHP.
Otherwise revert only this commit's editor files on top of the later release.

Not verified: the full editor was not opened on dev, because that needs a staff sign-in.
