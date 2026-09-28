# Dictation and audio recording — September 28, 2026

Source release: `a3448c00a662f9c604906bc4cb8ded5b26864ea8`, pushed on
`codex/consolidated-firstmeasure-20260923`.

Shared SVG assets distinguish a plain recording microphone from a microphone
with text lines for dictation. Assistant, checklist creation/update, document
dictation, proposal instructions, sales setup, channel controls, audio evidence,
project notes and communication composers use the appropriate shared asset.
Communication controls select their icon from their configured voice mode.

Channels offers both actions. Dictation adds recognized text to the draft
without uploading an attachment. Recording uploads audio without requesting
transcription or replacing existing text. Both controls prevent overlapping
capture; stale results cannot populate a different channel's composer.
Existing audio-plus-transcript consumers retain their default behavior.

Validation: TypeScript check; all changed JavaScript syntax checks; four
checklist UI contracts; 97 assistant/client CSRF checks; isolated Chromium
with fake audio devices. Browser coverage exercises dictation, audio upload,
preserved drafts, no transcription during recording, cancellation, and mutual
exclusion. The release-specific Channels source was tested separately from
the concurrently edited workspace. Icons and composer screenshots were inspected.

The frontend-only release inherits each live web baseline using guarded
copy-on-write replacement of 14 assets. The prior release on both nodes was
`358205080b54b9c540b5877e018b8b99504f572c`. Unrelated Channels/workspace edits
are excluded from this commit and remain in the canonical checkout.

Evidence: ignored `output/voice-icons-20260928/`, including live inventories,
per-node hash manifests, release receipt and public verification results.
Both `do-598520065` and `do-603124965` passed local readiness with development
isolation enforced and all 14 asset hashes verified. Six public readiness
requests passed; all 14 public asset hashes matched the committed release.
The isolated browser regression also passed using scripts and icon assets
fetched from `https://dev.1m8.ai` after activation. This tests actual deployed
frontend code with fake devices and API fixtures; it does not certify real
microphone hardware or live transcription-provider quality.
No database, environment, topology, worker or compatibility changes are needed.
Production is unchanged. The previously documented historical development
autoscale image limitation remains.

Rollback: check for intervening releases before restoring the prior release
through the existing atomic symlink/service workflow, one development web node
at a time. Confirm readiness and development outbound isolation afterward.
There are no migrations to reverse.
