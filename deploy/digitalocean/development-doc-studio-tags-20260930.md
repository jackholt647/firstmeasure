# Doc Studio Tags loading — development

Source commit: `aad93679ad9512672be397e6e7142cf0db3a1d98`.

This follows the verified Brand Kit palette-label and shape-choice release
`e1ca0429f616c1a0017fedb7a80c41834627de88`. Brand Kit was deployed first.

Studio's lazy module URLs now inherit the bundle query/version and fall back to
the canonical document-app directory when no external currentScript URL exists.
The tag manager uses the configured Documents API client; its compatibility
fallback resolves relative API bases to absolute URLs. Its loading/error dialog
has a persistent title, accessible close control and Retry, and ignores results
after the dialog closes.

The original inert click was not reproduced with the currently served external
Studio bundle: it opened a dialog in a synthetic development session. That
session was denied document API access, and no permissions were expanded. The
new browser regressions cover external and inline loading, module version
propagation, relative API bases, configured Documents API requests, opening,
rename, archive, close and failed-load retry. The shared Brand Kit browser
regression also passes. Data mutations in these checks use browser fixtures.

The guarded two-file frontend deployment clones each verified active release
and patches only Studio and tag-manager source. It preserves unrelated deployed
features, configuration and data. Evidence is in the ignored
`output/document-tags-deploy/` and `output/document-tags-check/` directories.
Several activations were stopped before pointer changes because concurrent
development rollouts advanced the baseline. Staged trees were retained. The
final rollout refreshed, staged and activated one role at a time, retaining
baseline, file-hash, readiness, development isolation and outbound safety guards.
Rollback refuses to overwrite an intervening newer release. Verification checks
the active feature hashes even when a subsequent release advances its ID.

Activated and verified on both development web nodes and compatibility. The
hosted browser suite passes all three Brand Kit/Tags cases, including opening
Tags from Brand Kit, shape choices, exact palette labels, autosave, rename,
archive, close and failed-load retry. A separate live Studio smoke verifies the
versioned module loads and the named dialog opens and closes. Temporary synthetic
sessions were revoked. Public checks verify both changed assets and six healthy
development readiness responses.

Per-role predecessors for this overlay:

| Role | Prior release |
| --- | --- |
| Web | `fd4e70334953b66ea1362925b10f516b552b51c8` |
| Pool | `d4caa24f08abff96b3da647226c2f393b999ff17` |
| Compatibility | `d4caa24f08abff96b3da647226c2f393b999ff17` |

For rollback, first inspect current releases and preserve any newer work. Restore
the relevant predecessor pointer only when it is still the intended baseline,
restart that role's development service and PHP-FPM, and verify readiness,
isolation, outbound safety and public traffic. There are no migrations to reverse.
Production, worker, configuration and customer data were not changed by this rollout.
