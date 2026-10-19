# Curved copy/paste, Resources media viewer and plane Auto-step — development, October 19, 2026

Source `700b8d540c69894d7d2a66e03c8bc5b3993b99ae` on `codex/consolidated-firstmeasure-20260923`.

## What changed

- **Curved copy/paste.** A pasted curve gets new curve ids, so it keeps its analytic definition instead of turning its
  tessellation into user points. A sticker's curves move with it, which fixes the broken wedge render. Guides and
  snapping use only defining curve points. See `dev/EXTERIOR_ENGINE.md`, "Copying and pasting curves".
- **Resources media viewer.**
  - Reliability: files open reliably and keyboard focus is fixed.
  - Layout: rows are compact, and the divider between library and viewer can be dragged.
  - Grouping: videos are listed first within QA, Tech and Customer instead of in their own group.
  - Playback: J/K/L skip back, play/pause and skip forward. Space plays and pauses. Arrow keys step one video frame,
    or move to the next photo. Video is muted by default.
  - Save Frame: it now asks the server to extract the frame with ffmpeg (`_resource_frames.php`) in the background,
    instead of uploading it from the browser. See `dev/RESOURCES_UI.md`.
- **Plane Auto-step.** Steps for collinear angled lines on a drawing plane (wall_steps.js and wall_face_draft.js).

## Host change

The distribution `ffmpeg` package (6.1.1) was installed on the development web, pool and compatibility hosts. PHP finds
it with an empty environment. Production hosts do not have it yet.

## Checks

- Full suite on the combined tree: 1,632 of 1,635 pass. The only failure is the long-standing exterior-ai test;
  `wall-plane-editor.browser` now passes.
- Rollout: the first attempt stopped before activation because another session's release (`dd213586`) became active
  between staging and activation. The retry re-audited all three roles on `dd213586`, merged onto it and activated
  each role in turn.
- All roles verified hashes, runtime identity, readiness and isolation. 21 HTTPS fetches of the seven editor
  JavaScript/CSS files matched the shipped files, which are identical to the commit. `/v1/health/ready` reports
  `700b8d54`.
- On the web host, `fm_resource_extract_frame` produced a 19 KB frame image from a generated test video.

| Role | Release |
| --- | --- |
| web | `/opt/firstmeasure/releases/700b8d540c69894d7d2a66e03c8bc5b3993b99ae` |
| legacy | `/mnt/firstmeasure_dev_releases/releases/700b8d540c69894d7d2a66e03c8bc5b3993b99ae` |
| pool | `/opt/firstmeasure/releases/700b8d540c69894d7d2a66e03c8bc5b3993b99ae` |

The previous release on every role was `dd213586`. The worker and production were not changed. Not verified in a
signed-in editor on dev.
