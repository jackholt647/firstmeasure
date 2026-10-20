# Full-house staff fixes — development, October 19-20, 2026

Release `c1240ed1f5ba5808f611fb4502de6e71b18148b1` (parent `41c43b98`) is on all four development roles: worker,
legacy (compatibility), web and pool. Each role verified the release, and the change was three-way merged onto each
role's live files. Production was not changed.

These fix the staff-side breaks found in the October 19 full-house dev pilot. Two of them had needed script
workarounds in the pilot.

## Browser API base pointed at a private address

The compatibility host's PHP pool sets `env[FIRSTMEASURE_API_BASE] = http://10.124.16.12/v1/firstmeasure`
(`/etc/php/8.3/fpm/pool.d/zz-firstmeasure-development-api.conf`, dated 2026-09-23). That address is the dev web
node's private IP. PHP used it for its calls to Node, which is correct. The portal also embedded it for the browser,
and the Node calls passed `Host: 10.124.16.12`. Node builds editor imagery and artifact URLs from that host, so they
pointed at the private IP too. The staff dashboard, the queue and the editor imagery were all blocked as mixed content.

- `firstmeasure_node.php`: the new `fm_browser_api_base_url()` is what reaches the browser. It uses
  `FIRSTMEASURE_BROWSER_API_BASE` if set, otherwise the request's public origin. The portal embed (`index.php`) and
  PHP-built artifact, PDF and pdf-state URLs use it. `fm_api_base_url()` still serves PHP-to-Node calls.
- When PHP reaches Node at a different address from the one the browser used, it sends `X-Forwarded-Host` and
  `X-Forwarded-Proto` with the public origin. Web nginx passes those through, so Node builds public URLs. This is
  applied in `fm_api_request`, the streamed editor bundle (`_editor_transport.php`), the full-house proxy and the
  portal's internal requests. Local (`127.0.0.1`/`localhost`) behaviour is unchanged.
- Production: compatibility (`144.126.222.110`) has no `FIRSTMEASURE_API_BASE`, so both bases are the request origin
  and no extra headers are sent. The behaviour is identical. Production was checked read-only and not changed.
- The dev pool config was left in place; it is still correct for PHP-to-Node calls.

## Full-house checks in embedded QA and manager sign-off

In embedded QA the portal's `#qaFullHouseReview` sits in the hidden action area. The approve button is the editor's
`#qaPdfApproveBtn`, so reviewers could not tick anything, and Approve failed with "Complete the full-house review checks".
- `report.js`: the QA PDF page renders the seven confirmations (the server's `FULL_HOUSE_REVIEW_FIELDS`). Approve
  and Correct-and-Approve are disabled until all seven are ticked. Each tick posts
  `firstmeasure:qa_full_house_review` to the portal, and the decision request carries `full_house_review`.
- `qa.js`: the checks from the embedded editor count in `fullHouseReviewPayload()`, which both the QA decision and
  the manager decision send.

## Approval after a late PDF render (`stale_pdf_sync_reference`)

Opening a review starts two PDF renders: the inspector's persisted render and the editor PDF page's render. Each
synchronizes a server revision. Approving before the later one landed named the earlier revision, and the server
returned 409.
- The editor's Approve waits for its renders in flight and then posts the newest reviewed revision.
- Before posting, `qa.js` waits for its own renders and the editor's (up to 2 minutes). If the server's latest
  revision was made in this review session, approval adopts it; any other revision is left alone.

## Smaller staff fixes

- A Full House badge now shows in the project window, the drafter's Your Active Work card and Manager Sign-off rows.
- For full-house projects, the drafter reservation dropdown lists only `can_draft_full_house` users and the QA
  reservation dropdown lists only `can_qa_full_house` users. `POST /qa/reservation/users` now returns
  `can_qa_full_house`.
- A failed reserve shows the server's message instead of `full_house_qualification_required`.
- With every gutter story filled and the PDF still syncing, the requirement line no longer says
  "Set stories for [nothing] before submission".

## Verification

- Rollout: `output/fh-staff-fixes-20261019/ship.sh`. All four roles were staged, activated and verified on
  `c1240ed1`.
- Portal embed, 12 loads as the pilot drafter: every one is `https://dev.1m8.ai/v1/firstmeasure`.
- New pilot order `exteriors_b8255224a5549d3ed60eb3e05055db4e`, driven by `output/fh-staff-fixes-20261019/pilot/`
  with no API-base rewrite. Each run counts mixed-content console errors and private-address requests, and both were
  0 for the customer order, manager, drafter and QA runs.
  - Manager: the project window shows the badge, and each dropdown lists only the qualified pilot drafter or pilot QA.
    Both reservations saved through the UI.
  - Drafter: the Your Active Work card shows FULL HOUSE. Claim, editor imagery and submit all worked.
  - QA (`fh-pilot-qa@example.com`): the PDF page showed 7 checks, and Approve stayed disabled until they were ticked.
    Approve was clicked while the PDF was still generating. It waited, then `qa/decision` returned 200 with the seven
    checks and the project completed. No 409 occurred.
- Tests: `dev/full-house-embedded-qa.browser.cjs` (new) and `dev/full-house-review-ui.browser.cjs` pass. The QA,
  full-house and portal suites ran 77 tests: 71 pass, and the same 6 fail identically on a clean HEAD tree. Those
  failures are property-country checks, `report_language` fields and a Windows file lock. `tsc --noEmit` is clean on
  the release tree.

## Not covered

- Manager sign-off was not exercised live, because the pilot QA's approval did not need a manager. Its badge and
  checks are covered by the browser test (the same page and payload).
- Already present and unrelated: a 500 from `top_view_reroll_proxy.php` and a 404 for
  `internal-markup-overlay-active.json` when the QA editor opens.
- Rollback: re-activate the previous release `41c43b98` on each role with the same tooling.
