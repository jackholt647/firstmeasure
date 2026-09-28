# Assistant composer and voice waveform — development, September 25, 2026

Source commit `158e583729eb725f344d052d4a45806df2075790` is pushed to
`codex/consolidated-firstmeasure-20260923`. Both development web nodes
(`do-598520065`, `do-603124965`) run release
`bc987eaa1dcc17218213981e33787766ddc25e74`. Production is unchanged.

The assistant textarea now starts at one vertically centered line, measures
wrapped lines and explicit newlines, animates height changes, and caps its
height at ten lines before scrolling. The recording waveform uses timed canvas
samples that fade in at the right edge and travel left without reversing.
It uses the company theme color and keeps the sample history bounded to the
visible width.

The release changed only
`public/libraries/platform-assistant/platform-assistant.js` over the verified
development baseline `9444330e959b1efdceb60d7bc4264ee512a35552`.
Both immutable web releases passed JavaScript syntax and source checksum
verification before sequential activation. Local readiness and public readiness
reported the expected release, development data, and enforced outbound safety.
The public asset SHA-256 is
`77a5b0e3f240f0f402bc3b38aa0c1b5a0308b2113ccc90434156c067db1f3907`.

`npm run test:assistant:frontend` and `npm run check` passed locally. Live
Chrome checks measured 40 px at one line, 62 px at two lines, and 238 px at
twelve lines with scrolling; the textarea shrank to 40 px when shortened and
remained usable in the full-screen assistant. The recording animation was not
tested with an actual microphone in the browser.

The development autoscale image remains historical. Rollback on each web node:
restore `/opt/firstmeasure/current` to
`9444330e959b1efdceb60d7bc4264ee512a35552`, restart
`firstmeasure-development-web.service` and `php8.3-fpm.service`, then verify
local readiness. Reconcile any later concurrent release before rollback.
