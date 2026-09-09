# Historical referral ledger recovery (1M8-154 / 1M8-170)

Prepared September 9, 2026. This is a reviewed dry-run-first tool, not an instruction to activate or merge automatically.

## Confirmed problem

The compatibility CRM database contains the staff-managed campaign configuration. Public platform routes previously read and wrote a separate SQLite referral ledger on each web node. Consequently, post-cutover signups were missing from staff reports, and web nodes did not know the advertised bonus offers. Separately, reports selected only the oldest 20,000 visits; the production cutoff was August 24.

Deploy the referral service/report repair first: compatibility before every web node. Verify every active web node (and replacement-node bootstrap) runs the corrected release, so future referral writes reach the authoritative compatibility service.

## Snapshot and inspect before merging

1. Verify the live fleet, not only the historical six IPs in DEPLOYMENT.md. Inspect each service's effective `CRM_STORAGE_ROOT` without printing secrets. The inspected web node used `/var/cache/firstmeasure/crm/databases/referrals.sqlite`; compatibility used `/var/lib/firstmeasure-legacy-production/current/v1/crm/databases/referrals.sqlite`. Resolve symlinks before choosing the target.
2. Capture an online SQLite backup of each web-node referral database into a private recovery directory. Use SQLite's backup API or `VACUUM INTO`; **do not copy only the main database file while WAL writers may still exist**. Include every node that accepted post-cutover traffic, including retained/replaced nodes if any. Keep source snapshots unchanged.
3. Transfer these snapshots through the existing SSH access into a private compatibility recovery directory. These are customer records; do not place them in a release, repository, public artifact, or log.
4. Run the script in dry-run mode against the canonical target and all immutable source snapshots together. Its output contains counts, a plan digest, and conflict IDs, not customer emails or metadata.

```text
node --experimental-sqlite dist/src/scripts/referral_ledger_reconcile.js \
  --target /RESOLVED/CANONICAL/referrals.sqlite \
  --source /PRIVATE/RECOVERY/web-1.sqlite \
  --source /PRIVATE/RECOVERY/web-2.sqlite
```

Those are placeholders; supply all verified sources. Dry-run is the default and opens every database read-only.

## Merge behavior and safeguards

- Preserves authoritative campaign/bonus configuration. It never overwrites compatibility partners or codes with empty auto-created node copies.
- Matches equivalent code strings case-insensitively, remapping node-specific code IDs in attributions/events/rewards to the canonical code ID.
- Preserves attribution IDs, campaign partner IDs, public bonus tokens, and original signup times. An exact existing viewed attribution can be upgraded to its completed signup; completed records never revert to views.
- Retains unknown metadata and existing advertised tokens. Preserves reward attribution relationships but does not fulfill rewards, grant credit, send email, charge customers, or alter PostgreSQL organizations.
- Existing IDs are not added twice. A second dry-run after successful application should have zero inserts/updates.
- `--scope attributions` restricts recovery to attribution rows (both original visits and completed signups). It refuses missing partner/code mappings instead of creating configuration, and never inserts or updates events or rewards. Review its precise count/digest separately from an all-table plan.
- Conflicting organization identities, different partner IDs for the same code, divergent overlapping event counters, duplicate completed-signup attribution IDs for one organization, and conflicting or duplicate logical rewards **block the entire merge**. Review those records; do not silently discard them or add financial totals together.
- Apply requires the exact reviewed digest and a new backup path. It backs up the canonical database, obtains an immediate write transaction, replans under that lock, and aborts if the plan changed. Changes are atomic; SQLite quick-check failure rolls them back. Existing backups cannot be overwritten.

## Apply only the reviewed conflict-free plan

Within the authorized maintenance workflow, append:

```text
--apply --confirm-plan REVIEWED_SHA256_DIGEST --backup /PRIVATE/RECOVERY/canonical-before-merge.sqlite
```

Briefly acquiring the SQLite write lock can queue concurrent referral writes. Run only after routing repair and snapshot inventory are verified. If the tool reports conflicts or a changed plan, no rows are applied; review a fresh dry-run. Preserve source snapshots and the backup. Do not roll back the whole database over new live writes; use the backup for targeted recovery if needed.

## Verification

- Rerun dry-run with the same snapshots: zero mutations and zero conflicts.
- Verify the authenticated Campaigns report now includes post-cutover signup dates and expected counts, using the same campaign/date/timezone filters as the report. Compare the actual merged unique attribution IDs, not a sum of node counters.
- Verify the affected main-campaign customer's bonus status and displayed offer using an authorized session. Do not create a real checkout/charge to test the quote.
- The numeric ad campaign in the second 1M8-170 URL is a separate unresolved assignment: two active configured campaigns share its landing page. Ben must identify the intended campaign. This recovery deliberately does not invent or change that assignment.

Local tests: `tests/referral-ledger-reconcile.test.ts` exercises dry-run immutability, code-ID remapping, shared attribution upgrade, event/reward overlap, backup preservation, idempotence, and full abort on conflicts. `tests/referral-cluster.test.ts` exercises the runtime repair with SQLite and embedded PostgreSQL.

## Actual legacy-index finding

The first all-table recovery attempt was atomically rolled back: the compatibility database retains `idx_referral_events_unique`, a unique index on `(partner_id, actor_email, actor_org_id, event_type)` absent from newly created web ledgers. Distinct source event IDs can collide with this logical key. All 109 candidate completed-signup IDs remained absent after rollback, and the pre-attempt backup passed quick-check. Do not reuse that backup filename.

The tool now detects those unique event-key collisions during dry-run. Attribution-only recovery can proceed with its own reviewed digest; historical events remain unresolved. Do not sum event counters, discard events, or drop the legacy index as part of that scoped recovery. Attribution preflight also covers the actual legacy partial unique index `idx_referral_attr_org_unique ON referral_attributions(referred_org_id) WHERE referred_org_id <> ''`, including noncompleted rows that already occupy an organization ID. Regression fixtures retain both indexes.
