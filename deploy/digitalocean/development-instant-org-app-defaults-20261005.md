# Instant Full Org optional app defaults — October 5, 2026

Source commit `e38288238b5bf7c60d69702d0baa19b53182fae2` disables Training
(`apps.training`), Training Studio (`training.studio`), and Canvassing
(`canvassing.app`) in the Instant Full Org signup sandbox preset. Saved preset
defaults are refreshed when the sandbox loads. New test organizations receive
these defaults; existing test organizations retain their settings.

The scoped commit excludes concurrent personal navigation preference changes.
The regression covers new seeds, saved seed refresh, unrelated preset choices,
and the actual flags written when a test organization is created.

## Development release

Immutable overlays contain only `signup-sandbox/service.ts` and its verified
compiled JavaScript. All four audited development roles began on
`d5990751e31cf70eddb0c387c5e82692fc222b64`. Their existing source is retained
through hardlink staging with changed files detached before writing. Each
staged artifact passed its Linux TypeScript check and compiled payload check.
The local regression passed; the earlier local TypeScript failure concerned
unrelated imports during concurrent Forms work.

All four roles activated and verified release
`e38288238b5bf7c60d69702d0baa19b53182fae2`, including development isolation,
enforced outbound safety, and matching source/compiled hashes. Public readiness
returned the new release. A fresh hosted Instant Full Org verified all three
flags in saved workflow defaults, organization global data, and the authenticated
public capabilities API. Its disposable organization and identity were removed.

Activation and hosted verification results are recorded under
`output/instant-org-app-defaults-20261005/`. Rollback uses each retained prior
release path in `manifest.json` with the normal sequential development
activation and readiness checks. Production activation is outside this rollout.
