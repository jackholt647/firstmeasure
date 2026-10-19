# SMS evidence and copy refinement — October 11, 2026

Multiple supporting evidence files/links now appear in a named attachment list
with Upload files, Add a link, and Remove actions. Existing single URLs remain
compatible. Uploads retain wizard scroll position; links and filenames persist
in the draft, and every URL is included in Telnyx messageFlow. The existing
2048-character composite message-flow limit remains enforced. Public bearer
links and the existing 5 MB/file PDF/PNG/JPEG validation remain unchanged.

Example text uses smaller font/line spacing. Simplifies requested step 1, 3,
and 6 text. Step 5 has a compact Enter area code input. Telnyx's specific 400
no-numbers response becomes an empty inventory and friendly No numbers found.
Other provider failures remain errors rather than false empty results.

Validation: TypeScript check; API tests for multiple URLs in the provider payload
and empty inventory versus provider outage; all four browser tests including
multi-file uploads, scroll retention, adding/removing links, and compact search.
Merged current-live browser suite passes. Layout screenshots reviewed.

Review findings (reported, not automatically applied to business declarations):
- Verbal marketing flow should explicitly document follow-up text confirmation.
- Telnyx describes two samples for marketing; consider a second promotional sample
  for mixed campaigns selecting Marketing rather than assuming one is sufficient.
- Broader policy sharing clauses must explicitly exclude SMS consent data and
  not contradict the SMS section; the example is not a full privacy policy.

References:
https://support-v2.telnyx.com/en/articles/10562019-guide-to-10dlc-message-flow-field
https://support-v2.telnyx.com/en/articles/16256133-10dlc-campaign-compliance-guide
https://support.telnyx.com/en/articles/10684260-10dlc-opt-in-form

Development rollout uses guarded overlays of each host's live source and retains
organization-specific registration routing and concurrent releases. No provider
purchases, submissions, or real messages in tests.
- START confirmation copy could name the chosen purposes and include the
  marketing purchase disclaimer, matching Telnyx's template more closely:
  https://support.telnyx.com/en/articles/10645338-10dlc-keywords-and-confirmation-messages

## Development verified

Release `ad26138a1d89c257f6496537e18d0a28eaf6dba0` activated on web, pool,
compatibility and worker. Merged server TypeScript checking passed. HTTP roles
returned ready and worker is active. Public readiness returned ready; the served
settings asset matches staged SHA-256
`5f72b0c1a2e7f010c4835d38a393544c04f3573f2fae2322d33e8f9efa578a06`.
The readiness cache briefly retained a legacy-service restart warning while
compatibility had already recovered. No production changes were made.
