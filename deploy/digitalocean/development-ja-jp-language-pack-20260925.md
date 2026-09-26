# Japanese language pack — development rollout, September 26, 2026

The ja-JP interface pack is active on both serving development web nodes. It covers all 8,988 messages in the current development catalog with no English fallback. The handoff had 8,985 response slots: 8,983 translated entries and two deliberately unresolved ICU labels. Those labels were completed with placeholder-preserving Japanese text; four newer error messages were added for the live catalog.

## Release and verification

- Source release: `af9c9e726d8f211e1541d11382460e13789ae177`, based on active development release `26440daf1f29e011867d27a74ccf1aeb99581c1c`.
- Web `fm-dev-web-598520065`: activated `af9c9e726d8f211e1541d11382460e13789ae177`; 24,973 unchanged public files verified at staging.
- Web `fm-dev-web-603124965`: activated `af9c9e726d8f211e1541d11382460e13789ae177`; 24,833 unchanged public files verified at staging.
- Both local readiness checks passed with development data and outbound safety enforced after activation.
- Public catalog manifest lists `en-US`, `en-GB`, and `ja-JP`. The Japanese firstmeasure catalog is served with translated messages, and the runtime contains the Japanese locale.
- The backend language registry was rebuilt and loaded on both web nodes so saved interface preferences accept ja-JP. Worker and compatibility roles were unchanged.

No database, provider, or production changes were made. Previous web release `26440daf1f29e011867d27a74ccf1aeb99581c1c` remains available for rollback by atomically restoring each web node's `/opt/firstmeasure/current` symlink and restarting `firstmeasure-development-web.service`.
