# Meta ad signups lost the bonus offer: dev fix, October 24, 2026

Jack: "for some reason, nobody has taken the bonus offer in almost 24 hours, and they usually take it quite often."

## What happened in production

Production `62119658` (the embeddable signup form, activated about 02:40 UTC Oct 24) added `acquisition_code` to the
campaign lookup that the landing-page signup widget sends (`POST /v1/platform/acquisition/public/track`). The widget
fills it with the page's campaign value. On the app's Meta pages (`/portal/landing/variants/meta-619b/` and `meta-619c/`)
that value comes from PHP's `cid ?? campaign ?? campaign_code ?? utm_campaign`, and Meta's ads carry no `cid`. So it is
Meta's numeric `utm_campaign`, `52513030142937`.

`publicAcquisitionLookup` treats `acquisition_code` as explicit. It looks the code up before it matches the landing
page's own campaign. An auto-created campaign named `52513030142937` exists: a June 29 visit made it, and it has no
landing page and no bonus offer sets. Every Meta visitor resolved to it, so no bonus was assigned. Before the release,
the widget sent only `campaign`, which the lookup uses only as a fallback, after the landing page match (Meta 6/19 B,
`meta-6-19-1`, with its bonus sets).

Evidence, production, read-only:

| Check | Result |
| --- | --- |
| Last Meta 619b view resolved to `meta-6-19-1` | 02:36:38 UTC |
| First view resolved to `52513030142937` | 02:42:54 UTC |
| Signups on the stray campaign | 28, from 03:07 UTC to 19:51 UTC; none with a bonus offer |
| Same campaign before the release | 4 views in the previous week |
| Last bonus purchase | Oct 23 21:35 UTC |
| Bonus purchases on Oct 24 | 0, against 6–18 a day from Oct 16 to Oct 23 |

Pages not affected: main-site-page (`?cid=main`) and the websites. Their `data-campaign` is hard-coded
(`meta-6-19-a`), so they still got bonuses: 16 assigned on Oct 24. None of those accounts paid $100 or more, which is
the lowest bonus tier.

Checkout is not broken. From Oct 16 to Oct 23, nearly every purchase of $100 or more by an account holding a bonus
offer was a bonus purchase (79 of 94).

Of the 28 affected accounts:

- 16 paid, 17 purchases;
- one paid $140, which would have qualified for a bonus;
- the rest paid under $100 (mostly $7);
- none had the offer.

No backfill was done.

The known noise is not involved. The 503s on `/v1/platform/acquisition/event` and the `trackAcquisitionEvent` 500s are on the
analytics event path. The lookup that assigns the bonus answered successfully; it resolved to the wrong campaign.

## Fix

Commit `b9f89a1d` on `claude/bonus-utm-campaign-20261024`, cut from `codex/hotfix-20261023s`, touches
`public/portal/landing/shared/signup-widget.js` only.

The widget sends `acquisition_code` only for a code that the page or link names:

- `cid`, `campaign` or `campaign_code`;
- a `data-campaign` that is not just `utm_campaign`;
- the code the lookup resolved.

`utm_campaign` stays a hint and is still recorded. The hidden `acquisition_code` input and the signup form follow the
same rule.

The test is `tests/signup-embed-browser.test.mjs`. It has two cases:

- **A Meta ad link on `meta-619b`, with the stray campaign present.** The visitor gets `meta-6-19-1` and its bonus,
  through signup, and the organization has the bonus offer.
- **A link with `?cid=52513030142937`.** It still gets that campaign.

The new case fails on `62119658`'s widget. The tests pass: signup-embed-browser, signup-widget-auth and
referral-cluster, 18 of 18.

## Dev rollout

`output/bonus-utm-campaign-20261024/ship.sh` deployed to legacy and web. Both had been on `11e969cc`; the widget was
3-way merged onto their live copies. The worker serves no portal files, and the pool node is gone. Verify exited 0.

### Checked on dev

- `https://dev.1m8.ai/portal/landing/variants/meta-619b/?utm_source=fb&utm_campaign=52513030142937&utm_id=52513030142937&fbclid=x`
  shows `data-bonus-ready="true"`, campaign `meta-6-19-1`, and `xid` in the URL.
- The lookup reproduces the failure, run by hand. The old payload (`acquisition_code: "52513030142937"`) returns link
  `52513030142937` with no bonus. The new payload returns `meta-6-19-1` with a bonus.
- **Real signup.** The signup was made from that page as `bonus-utm-check-20261024@signup-check.example.test`. It
  landed in onboarding with `cid=meta-6-19-1`. `portal_acquisition_bonus_offer_status` returns Meta 6/19 B with tiers
  100→+50, 250→+125 and 500→+250.

## Production

Production is not released. The release is widget-only: legacy and web. Its file is
`public/portal/landing/shared/signup-widget.js`. The Meta pages version the script by file mtime, so browsers pick it up
on the next page load. The website droplets need no change.

## Production data stopgap (20:36 UTC)

Jack: "If you have a quick data change that you can do before fixing the code, let's do that."

The stray campaign was disabled in production `referrals.sqlite` on the compatibility host (144.126.222.110), in one
transaction at 2026-10-24T20:36:30Z:

- `referral_partners` `acq_52513030142937`: `status` `active` → `inactive`;
- `referral_codes` `acqlink_mqyi5ft5_bm3jj68n` (code `52513030142937`): `status` `active` → `inactive`, `active` 1 → 0.

Nothing else changed. The lookup only matches an active code, so a Meta visit now falls through to the landing page's
campaign. A read-only replay of the lookup on production data gives `meta-6-19-1` for `meta-619b` and `meta-6-19-c` for
`meta-619c`, each with 2 active bonus sets.

The code fix is still needed. Any other `utm_campaign` that happens to name an existing campaign would do the same.

To roll back, set both rows back to `active` (and `active = 1`).
