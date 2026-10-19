# Development rollout: platform routes stay inside the caller's organizations, and credits are permission gated (October 19, 2026)

Release `65634240d4ec3ceefcb71584618abedb4f895833` (the merge of `claude/platform-route-gates`, also merged into
`codex/consolidated-firstmeasure-20260923`), activated on all four development roles (worker, legacy, web, pool) and
verified. Production is unchanged.

## What shipped

Design: [permissions and agents](../../docs/architecture/permissions-and-agents.md), "Organization boundary".

- `GET /v1/platform/organizations` lists only the caller's own memberships. Every organization on the platform is
  an internal-staff view.
- `POST /v1/platform/identities` is removed. Identities are created only by the routes that add a person to an
  organization.
- `GET`/`PATCH .../global` (the raw global document with billing, payment method and the credits ledger) needs
  `manage_billing`. `/me` and portal-state return only the global document's branding to members.
- `GET .../credits` (the balance) needs `order_reports` or `manage_billing`. The new `GET .../credits/ledger`
  needs `manage_billing`. Settings > Billing reads its history from the ledger route
  (`PlatformApi.credits.ledger()`), and the portal falls back to session permissions when the balance is refused.

Nine files changed between `43b2fa22` and the release: `platform/api.ts`, `platform-api.js`, `settings/company.js`,
`portal/scripts/core.js`, the access gates snapshot and four tests (including the new
`platform-organization-boundary.test.ts`).

## Checks before the rollout

- Typecheck, `platform-organization-boundary`, app experience, the app experience registry and the access gates
  snapshot passed on the merged canonical branch.
- Browser, in the local integration preview: the owner saw Settings > Billing with the balance and a credit
  adjustment row; a viewer saw only My Settings with no errors. API: the viewer got 403 on the balance, ledger and
  global; the orderer got 200 on the balance and 403 on the ledger and global; the owner got 200 on all.

## Rollout

- Tooling: `output/route-gates-20261019/` in the `fm-platform-route-gates` worktree, copied from
  `fm-crm-worktree/output/crm-20261016/`. `replay.py` is empty: no host-only edits needed replaying.
- The audit found all four roles on `998b3102` (the CRM release). That release is newer than this branch's base, so
  the payload is the nine files above, each merged three ways onto the role's live copy with `43b2fa22` as the base.
  Every merge was clean. The live tree is the CRM release plus the route changes, released under `65634240`.
- The first audit timed out on SSH to the pool host. The retry audited, built, staged worker, legacy, web and pool,
  activated them in that order, and verified `65634240` on all four. The platform worker was restarted and is
  active on the new release.
- Public checks: `/v1/platform/organizations` with no session returns 401, `GET` and `POST /v1/platform/identities`
  return 404, and the served `platform-api.js` and `settings/company.js` carry the ledger route.

## Checks on dev.1m8.ai

A throwaway organization, `org_3ce910639b678280` ("Route Gates Check d62c84e2"), was registered for this check.
It has an owner and a manager-level report orderer with `example.test` addresses and generated passwords, which are
kept only in the git-ignored rollout folder. The owner added a $25 credit adjustment.

- API (`dev-matrix.py`): the owner got 200 on the balance ($25), the ledger (1 entry) and global. The orderer got
  200 on the balance ($25) and 403 `permission_denied` on the ledger and on global. Both see only their own
  organization in `/organizations`, and `/me` returns only `branding` from the global document.
- Browser, signed in as the owner: Settings > Billing shows $25, the "Credit adjustment +$25" history row and the
  October statement.
- Browser, signed in as the orderer: the portal reads the balance (200) and never calls the ledger or global. The
  New Report order step offers "Order Roof Report - $7". No order was placed. Settings shows no company tabs
  (the orderer has no settings or billing permission).

## Seen on dev, not from this release

- In the new organization, the events stream and the departments list return 403 `capability_denied`
  (`platform.expanded_access` is off for a new signup organization), for the owner as well.
- The manager-level orderer cannot save a project: `PUT .../projects/<id>` returns 403 `permission_denied`. This
  release did not change the projects routes.
- The throwaway organization is still on dev.
