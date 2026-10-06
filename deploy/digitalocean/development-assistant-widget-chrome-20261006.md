# Development assistant widget presentation — October 6, 2026

Source: `f722fd6579fe567583fe3d7232195990683543e6`.

The assistant panel host previously added a card, heading, timestamp and close button around registered widgets that already supplied their own card and heading. It now provides layout only. A small accessible close button floats outside the content by default in side and inline views. Inline dismissal leaves a chip that reopens the widget; dashboard dismissal retains the existing remove behavior. The close gutter fits narrow screens. Charts, tables and text visualizations retain their own presentation card and title. Registered widget panel markup has an accessible label instead of a second visible heading. Short inline widgets no longer show an unnecessary Expand control; tall widgets retain expansion.

Verification: `node --test tests/assistant-widget-chrome-browser.test.mjs` and `node --test tests/assistant-widgets-browser.test.mjs` passed in `public/v1`. Actual Chrome checks cover the to-do header, borderless host, external close position, close/reopen, 390px viewport, larger widgets, resizing and mixed widget/visualization panels. Screenshots are in the ignored `output/assistant-widget-chrome-20261006` folder.

The development payload contains only `public/libraries/platform-assistant/platform-assistant.js` and `public/libraries/platform-widgets/runtime.js`. Each serving role is staged from its actual live baseline, preserving unrelated files. The compatibility role retains its older widget runtime, with the owned heading and spacing changes applied to that implementation. No backend, worker, publication or production changes are required.

Development activation completed on primary web, compatibility and web pool with release identity `f722fd6579fe567583fe3d7232195990683543e6`. All three passed owned-file hashes, local readiness and development session/outbound isolation checks. Public `dev.1m8.ai` served both exact JavaScript hashes. The existing larger-widget Chrome test also passed against the publicly served assets after activation. Task overlays preserve the newer live lead-import baseline `fbb237f39b3dfac8d097acf580be3c9e0c624dbd`. The worker was not restarted.

The primary web host's staging reserve initially failed. A single unused temporary transfer archive `/tmp/exteriors-0ea9e7a.tar.gz`, older than 14 days and checked with `fuser`, was removed to recover staging space. Active and rollback release trees were preserved.

## Reopening follows panel view

Source `49d2345d118ecddb7822ba195a585faec7192751` fixes the message chip reopening a removed dashboard panel directly into chat. The presentation now remembers reopened panels independently of their persisted dashboard membership, clears dismissal on reopening, and follows the current panel-view preference. When enabled, reopening displays the widget beside chat; when disabled, it displays inline. Switching the preference moves a reopened widget between those surfaces. Closing a reopened panel removes its temporary presentation membership. Reopening does not republish or mutate domain data.

Both Chrome tests passed with new regression coverage for dashboard removal, chip reopen with panel view enabled, disabled reopen and toggling after reopening. The development payload contains only `platform-assistant.js`; it preserves each role's actual `f722fd65` live baseline, including role-specific widget runtime and backend versions.

The expanded close/reopen regression also passed against the actual JavaScript fetched from `https://dev.1m8.ai`, including reopening with panel view on/off and both subsequent toggles. The ignored live harness is `output/assistant-panel-reopen-20261006/live-regression.mjs`.

Release `49d2345d118ecddb7822ba195a585faec7192751` activated on primary web, compatibility and web pool. All three passed the owned JavaScript hash, local readiness and development isolation checks; public readiness and the served assistant file hash were also verified. Worker and production were unchanged.
