# Development software layers — October 6, 2026

Runtime source commit: `8dd70617b282cbb146886ab7eb7713057bfd5166`.

The Development control now has a viewport-filling version and Synthetic data / Software layers views. Software layers inventories scoped data exports, actions, widget declarations, artifact types/categories, dataset types and current published document/workflow modules. Entries group by declaration scope, distinguish supported target scopes, search nested schemas and expand lazily. Custom fields are in Data; project selection adds project declarations. Connection contracts use actual source/action authorization, excluding foreign tenants and inactive versions. Private module exports are excluded.

Deployment uses an eight-file immutable overlay (six source files and two compiled files) on the three development serving roles. Each role retains its audited source baseline, dependencies, environment, runtime assets and data. Concurrent activation of the mobile camera release changed compatibility/pool baselines; staging refused those stale baselines and they were re-audited before proceeding. The final baseline on each role was `f08f6b61c48d3b6e75473c7e5756d65d2c24b663`. The background worker does not host this development UI/API and is not part of this rollout.

Validation: local TypeScript check; publication suite (50 passed, one PostgreSQL-specific test skipped); development isolation, foreign-contract exclusion, private module export and read-only discovery checks; desktop/mobile browser regression. Every staged Linux serving payload passes syntax, compiled/source equivalence and full TypeScript checks. Deployment evidence, baseline hashes, role manifests and hosted screenshots are under `output/development-layers-20261006/`.

No database migration, provider configuration, production activation or native binary change is included. The existing historical development autoscale-image limitation remains; this rollout updates current serving roles without replacing infrastructure.

Rollback: inspect intervening activations, then restore the relevant role's recorded previous symlink, restart its development service and reload PHP-FPM. Verify readiness, development environment, outbound enforcement and retained source hashes before touching another role. No business-data rollback is needed.

Verified activation and exact source/runtime hashes on web, compatibility and web-pool roles. Each reports release `8dd70617b282cbb146886ab7eb7713057bfd5166`, ready development data and enforced outbound safety. The hosted API exposed 258 declarations in the isolated verification organization. Hosted browser checks passed nested expansion, scope filtering, full-screen/restore controls, desktop/mobile bounds, preserved Synthetic data controls and Escape dismissal. The temporary company was removed. Compatibility reported pre-existing systemd unit-file changes on disk; services activated and verified without changing those unit files.
