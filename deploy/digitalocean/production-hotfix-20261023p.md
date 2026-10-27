# Production hotfix 8ee3c3b1: checkout total fix (1M8-241, second bounce), October 23, 2026

Released under Jack's standing approval. Built on production `aa66cd9b` from `claude/vat-total-two-line-20261023` (`5d388d2c`).

## Problem

Ben reported "Broken". Since `aa66cd9b`, the checkout total for VAT-inclusive accounts read the literal text "{amount} VAT included".

That release used a new language key, `billing.checkout_total_vat_included`, with a placeholder fallback. The compiled catalog did not contain the key yet, and the language runtime returns a missing key's fallback unchanged, so the placeholder was never filled in. The browser test did not load the language runtime, so it missed the problem.

The window lasted from about 16:10 UTC until this release.

## Fix

- **Total:** the amount, with "VAT included" on a smaller grey line beneath it, as Ben asked. The new key has no placeholder.
- **Test:** it now asserts the two-line layout.

## Checks

vat-label-credits, the three billing suites and portal-regressions: 34 of 34 pass. No stale cache keys.

**Build:** archive `f8cd6cf7…`, verified.

## Rollout

- **First attempt:** the connection to the jump host dropped while the archive was copying. Nothing was installed or activated. Compatibility kept a partial tarball in `/var/tmp`, which the rerun overwrote.
- **Rerun:**
  - compatibility activated, with 0 errors and 0 crashes in the next 20 s;
  - the worker activated;
  - the signed channel was published against `4f318641…` (`aa66cd9b`);
  - all six web nodes activated.
- **Verification:** public readiness returned `8ee3c3b1` 10 out of 10 times. The billing app served at production carries the new markup (`bTotalVat`) and no longer contains the placeholder key.

## Lesson

A new language key with a `{placeholder}` fallback must be added to the compiled catalogs in the same release. Otherwise, use a key without placeholders and format the value in code.

## Rollback

Every role keeps `aa66cd9b`. Republish it (`4f318641…`) to the channel before rolling back a web node. Rolling back brings the "{amount}" bug back.
