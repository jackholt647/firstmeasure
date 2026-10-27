# Release candidate, October 22, 2026 (dev only)

Branch `codex/release-candidate-20261022`, built on production `8c908166`. Not
on production; production needs Jack's authorization.

## Contents

| Source | Linear | How it was brought in |
| --- | --- | --- |
| `claude/musing-perlman-70af85` | 198, 200, 218 (billing) | merged |
| `claude/optimistic-tharp-76908f` | 197, 202, 205, 206, 208, 210, 211 (portal) | merged |
| `claude/nifty-wright-f19096` | 201, 203, 204, 207, 209, 212, 213, 221, 223, 227 (accounts) | merged |
| `claude/lucid-yonath-777e5b` | 214–220, Europe pricing, 228 (country of record) | cherry-picked: its own 10 commits |
| `claude/upbeat-almeida-37f1dd` | 191, 226 (editor) | cherry-picked: its own 4 commits |

**Left out on purpose:** the October 21 FirstMeasure editor work carried on the
Europe and editor branches. That covers Resoffit, pane-resize, sticker-snapping,
3D-resize and exterior-report commits from the local canonical checkout. It has
not been reviewed for production.

### Conflicts resolved

- `DEPLOYMENT.md`: kept both sides.
- App manifest: cache keys changed in both branches became `20261022-rc1-v1`.
- `login.php` and `signup-widget.js`: kept both the password toggle and the
  region picker.
- `billing/app.js`: kept the payments branch's `profileBasePrice`, which gives
  the same prices as the Europe branch's version.

Language catalogs were regenerated once on Linux for the merged source
(`7e782475`).

## Tests (dev worker, Linux, `rc-test.sh`)

The type check, PHP lint and build pass.

**Server tests (`*.test.ts`)**

| Run | Tests | Pass | Fail |
| --- | --- | --- | --- |
| Release candidate | 1,698 | 1,546 | 115 |
| Production `8c908166` | 1,672 | 1,517 | 118 |

Compared by test name, the candidate has **0 failures that production does not
have**.

**Browser and contract tests (`*.test.mjs`)**

The candidate fails 420 and production 413. The 7 extra failures are:

- six new browser tests that need Chrome, which the server lacks, in the same
  way as about 210 existing ones;
- `customer-email-search`, a brittle source-slice test, fixed in `49d27e7d`.

The 36 new and changed browser tests pass on Windows with Chrome.

**Catalog lint**

`localization-catalogs --check` still fails on unconverted literal strings in
more than a hundred platform files. Production fails it the same way.

## Dev rollout

`bc74cedf` is live on all four dev roles (web, worker, legacy, pool), 3-way
merged onto the live files. Seven files where dev already carried the same
changes in a different arrangement keep dev's live copy:

- `login.php`
- `signup-widget.js`
- the app manifest
- the generated catalogs
- one test file

## Before production

- Team click-through on dev:
  [October 22 Release Checks](https://claude.ai/artifact/1afaBpdzC7RZbVJ7aSMMwN).
- Run the organization-country backfill on production: a dry run, then
  `--write`. See the 1M8-228 record `cd4f768e`.
