# SMS registration final review: development verification

The October 11 SMS registration follow-up removes the Business type, Brand Name / DBA, and Industry helper text, changes sole proprietor verification copy to “We will send a one-time verification code,” and removes the step 6 description and final acknowledgement checkbox. Both browser and API submission validation no longer require the removed checkbox. The existing checks for consent disclosure, opt-in flow, policy links, and message samples remain.

Source commit: `07074caa1c301bb795ecce8e488a8b6803089bf2` on `codex/sms-number-availability-20261009`.

Verification before rollout:

- `npm run check` in `public/v1`: passed.
- `node --test public/v1/tests/sms-setup-browser.test.mjs`: 4 passed, including submission without the final checkbox.
- The browser suite against the merged development asset: 4 passed.
- Focused 10DLC brand correction and campaign brand-readiness API tests without `consentAcknowledged`: 2 passed.
- `node --check` and `git diff --check`: passed.

Development rollout used guarded, host-specific overlays on the current immutable base. An initial staged build compiled the API as CommonJS and prevented the web service from starting; the web symlink was immediately restored to its previous healthy base. The corrected ES module build was staged under `07074cab-sms-final-ui` and activated on web, pool, compatibility, and worker roles. The final public `/v1/health/ready` endpoint reported `ready` and release `07074caa1c301bb795ecce8e488a8b6803089bf2`. The served `company.js` SHA-256 matched the staged asset: `3031d3aa274db7bc765c1b1dcd960c87c9e4991a17291ecf3babc214c8da7c5a`.

No production release was activated.
