# Phone tray Call, Text, and Contacts - October 7, 2026

Source commit `eba427aaaf5f86c6be4e686663e32d2ec62c28b8` on
`codex/pioneer-puffin-feed-photos`. Development only; production was not changed.

The tray now has Call, Text, and Contacts. It removes call lists, follow-ups,
pre-call name and reason fields, and the old ready-to-call header. The dialer
matches contacts by name, offers a country-code selector, and lists contacts
alphabetically before searching. Text threads open and reply in the tray. Call
and Text selectors offer an eligible company main or assigned line; each user
can save a default in Phone setup. Managers can assign a connected line to a
teammate. A line is offered for Text only when it has an active SMS sender
identity. Phone setup now names the existing required post-call disposition
setting explicitly.

Validation: TypeScript check and build passed; the phone browser test passed
with name search, tabs, line selectors, texting, call controls, and responsive
layout. Phone development tests passed, including contact loading, saved
defaults, and assignment restrictions. The broader communications suite had
one repeatable outbound-email notification assertion failure unrelated to this
change; its SMS tests passed. No live call or text was sent. Development's SMS
outbound policy remains blocked, so the tray can compose and submit through the
messaging service but cannot deliver a real text there.

All three active development roles were at `cb106be0e79839e0e27547047f63d64f9f808cce`
before activation. Guarded copies retained each role's other code and manifest
entries, replacing only phone assets and compiled communications files. Web and
pool activated from `/opt/firstmeasure/releases`; compatibility activated from
`/opt/firstmeasure/releases-root-archive` because its release volume had no free
inodes. All roles passed local readiness and reported release `eba427aa`; the
public `https://dev.1m8.ai/v1/health/ready` returned 200 with development
outbound safety enforced. The public phone script hash matched the tested file.

Rollback: inspect any later release first, then restore each role's previous
`current` symlink to `cb106be0...`, restart its development service, and verify
readiness and the served asset. There was no schema migration or data rewrite.

Follow-up release `bacae7582ea1936d0a38053d8b1e746402e8e570` removed the
remaining Create follow-up option from the phone outcome panel and clarified
the external-phone copy. The phone browser test passed again. A guarded
frontend-only overlay activated on web, pool, and compatibility from `eba427aa`;
all three passed local readiness. Public readiness returned 200 for `bacae758`
and the served calling runtime matched the tested SHA-256 hash. For this final
release, rollback first to `eba427aa` if no later release has superseded it.
