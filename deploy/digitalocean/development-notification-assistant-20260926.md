# Development notification assistant — September 26, 2026

Source commits: `d117a37` (focused assistant and workspace), `f2b3842` (search/focus),
`bad3ceb` (retain disabled existing triggers), and `0b529d9` (editable channels), all
pushed to `codex/consolidated-firstmeasure-20260923`.

## Behavior

- All, General, Workflows, Scopes and Custom views, cross-view search and sorting.
- Toolbar and right-hand chat remain fixed while only the notification list scrolls.
  On narrow screens Add custom switches between the list and assistant conversation.
- General retains standard notification controls. Uncommon event subscriptions are
  available to the assistant as potential triggers; selected/previously enabled
  triggers appear under Custom and remain visible when switched off.
- FirstMate's shared assistant runtime inspects authorized choices and declarations
  before configuration, discusses likely matches, reuses existing choices and rejects
  exact event/filter/recipient duplicates. Filtered custom notifications use durable
  Work rules, revision-checked writes, personal recipients, current delivery access
  checks, and regular in-app/push preferences. No live event is fired for testing.
- A notification-only assistant entry point supports FirstMeasure-only accounts;
  it cannot invoke global platform tools or enable other applications. Existing
  company assistant settings, membership, CSRF and thread ownership remain enforced.

## Immutable development releases

The concurrent custom-field rollout changed all four role baselines while this
release was being prepared. Staging rejected the changed predecessor. The final
builds preserve the completed custom-field releases and all other inventoried code.
Each role was built against its own immutable source baseline; a final single-module
channel correction was compiled with the same TypeScript compiler/options.

| Role | Previous | New |
|---|---|---|
| web | `e5b4ed935875663c3e4e64c119a3848808e19ec5` | `42a8a41a2b14a498ee664a8a36750a1161dd2df8` |
| worker | `529dea1c5ebabcd2c06d598f9d2a15ccbf55b4ca` | `d16c102ddb535ed83221b1757127a17ede205460` |
| legacy | `6991a9a733e8270ba419b8e60c269fbc2b405427` | `74b8965e1d7c7121dfda1b84e9531b36e00bc522` |
| pool | `a7d72ff58d673f10a58f040b1a266d16b9d2cee5` | `08df5f75a6820da33d4d1c27722b706368a37f02` |

## Verification

TypeScript checks and all four role builds passed. All 14 assistant integration
tests passed both in the canonical source fixture and the captured development web
baseline. Focused tests passed again after the channel correction, including creating
an alert with in-app delivery off and subsequently enabling it. Tests cover initial
inspection, stable custom preferences, exact duplicate rejection, filter validation,
durable filtered delivery/replay deduplication, action settings, FirstMeasure-only
access, personal threads and exclusion of cross-app tools. Six shared client CSRF
checks passed. Browser fixtures verified thin General, disabled Custom entries,
separate scopes, sorting, conversation replies, fixed toolbar, mobile chat and no
page errors.

The publication suite retains its existing app ownership inventory failure
(Assistant directory versus coverage inventory); 46 pass, one fails, one PostgreSQL
case is skipped. No unrelated inventory change was included.

Staging verifies baseline identity, payload/source/compiled hashes, development
safety and catalog import. Activation checks worker job activity, readiness and
hashes, with guarded rollback. Production, native APKs and Firebase/APNs credentials
are outside this deployment. Evidence and scripts: `output/notification-assistant/`.

## Live result

All four roles activated and passed final development readiness, outbound safety,
catalog import and source/compiled hash verification. Authenticated browser checks
passed using notifications@1m8.ai with its existing FirstMeasure-only flags. The
actual assistant called `inspect_notifications` and `report_result`, recognized
Report delivered as an existing notification, and made no configuration call.
The user's notification preferences were byte-for-byte equal before and after.

Desktop verification confirmed a fixed toolbar/right assistant, two notification
columns at the tested 1440px viewport, and no scroll on the outer settings card.
The column count remains responsive to the list's available width. Mobile checks
passed for Add custom / Back to notifications, the chat conversation and list.
Search passed and no browser page errors occurred. The test session was revoked.
The scripted test login needed its normal readable CSRF cookie restored from the
authenticated session endpoint; no authentication or CSRF protection was changed.
