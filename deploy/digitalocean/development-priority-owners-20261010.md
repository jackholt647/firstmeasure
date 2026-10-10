# Priority field owners — development rollout, October 10, 2026

Development artifact/cache commit: `0b68c71aa41102805a464d52f8141f3c3db5ad02` on `codex/consolidated-firstmeasure-20260923`.
Implementation commit: `aaa9d0d168ef83249663fcbf7e56a253e72668a5`.

Continuation of the authorized GitHub/development Priority fields architecture.

## Shared owner model

Priority fields now follow the existing `FIELD_OWNERS` catalog. Projects retain
`priority-fields.contract`/`values`; contacts, users and organizational resources
use owner-specific contract/value exports in the same provider. Each export
uses its field owner's read permission and existing resource reader. Contact
values support both organization contact records and project-embedded contacts.
User/shared-owner configuration and calculated definitions live in `default`;
project/contact configuration remains branch-specific.

The `priority_fields` module stores `entities[entity]` as separate ordered lists.
New models default to no priorities. An explicit project list supersedes the
legacy project setting, which remains a read-only fallback until saved through
the updated editor. Calculated values remain declared fields. `$record` binds
source identity to the current owner, including embedded contact context.

The browser exposes a generic resolver, renderer and `mountOwnerEditor` with
`save()`. It preserves sibling model lists, filters custom fields by owner and
uses correct shared definition placement. Empty strings, whitespace and empty
arrays/objects hide by default; zero/false remain displayable. Denied, pending
and error results remain hidden. Existing explicit unset-placeholder behavior
is retained. Adding pills to a particular contact/user window is a consumer
integration using this shared API; this release does not add those window mounts.

See [the updated architecture guide](../../docs/architecture/priority-fields.md).

## Validation

- Isolated commit TypeScript check passed.
- Five backend tests passed with file storage and embedded PostgreSQL.
- Two priority browser tests and the custom-fields browser regression passed.
- Isolated publication suite: 69 passed, 1 PostgreSQL-only skip, no failures.
- The dirty working-tree publication run encountered two shared-fixture state
  failures (preexisting organization and an unissued fixture phone). The fresh
  isolated run passed both tests; no domain fixture state was cleaned or reset.

## Deployment

Development overlay retains each role's audited running source, compiled files
and dependencies. Only this feature's delta is detached and applied to a new
immutable same-filesystem release clone. Type checks, fixture tests, hashes,
owner/provider bootstrap, readiness and development/outbound isolation are
verified before/after activation. No data backfill, schema migration, production
activation or topology change is included.

All four roles passed Linux TypeScript and JavaScript checks. The five owner
backend tests passed on each staged role in temporary isolated fixture storage.
Active source/compiled hashes match the reviewed per-role overlay. Every role
registers contact/user/project priority exports, passes runtime readiness, and
retains development data, session-cookie isolation and enforced outbound safety.
Public readiness and five hosted frontend assets were verified. Both browser
regressions passed using downloaded hosted scripts with fixture APIs; no live
organization records were changed by the tests.

Concurrent development deployments superseded several earlier baselines.
Activation guards stopped those attempts. The final overlay preserves each
role's audited source baseline recorded in the rollback paths below,
including any picker and selection action menu changes present on that role.
The second web node returned to `5759f2ee` during another rollout; its final
overlay was re-audited and checked against that active baseline. The artifact/cache
commit identifies the Priority fields delta; the role manifests and receipts
identify the preserved baseline and exact overlaid payload. The custom-field
editor bundle cache version also advances for the entity-aware source picker.

A subsequent GIF-loading release activated on the first web node during final
verification. Its Priority fields source and compiled payload hashes all match
this rollout's approved hashes. The table records the verified runtime releases,
including that preserved overlay.

| Role | Active release | Verified payload files |
| --- | --- | --- |
| web | `d108c3e19050485efa8dd641b45691cb6492db76` | 21 |
| worker | `0b68c71aa41102805a464d52f8141f3c3db5ad02` | 15 |
| legacy | `0b68c71aa41102805a464d52f8141f3c3db5ad02` | 21 |
| pool | `0b68c71aa41102805a464d52f8141f3c3db5ad02` | 21 |

## Rollback

Check for newer releases first. Restore the role's prior current symlink,
restart its development service and reload PHP-FPM for frontend roles. Verify
readiness/isolation. Retain owner configuration and definitions; older project
readers can use the retained legacy project list. Contact/user priorities need
the new reader and remain safely stored for a later retry.

- web: `/opt/firstmeasure/releases/e30e45c9b436624fab2e90d43e8887b2b92bfe35`.
- worker: `/opt/firstmeasure/releases/e30e45c9b436624fab2e90d43e8887b2b92bfe35`.
- legacy: `/mnt/firstmeasure_dev_releases/releases/e30e45c9b436624fab2e90d43e8887b2b92bfe35`.
- pool: `/opt/firstmeasure/releases/5759f2eecff3fe9bd08c1b17ce05516bd84a489c`.
