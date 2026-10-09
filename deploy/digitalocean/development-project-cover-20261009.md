# Typed project cover photos — October 9, 2026

Feature commit: `c7d9d4e28e65ba37973a47e2673fabc2d22a70d3` (with its two feature ancestors).

Projects use the existing Photo custom-field reference type for the built-in
optional, single-value `cover_photo`. Other Photo/Media/Video fields continue
to use the same reference contracts. Overview offers the library selector;
the Photos viewer offers Set as project cover, Remove project cover and a
Cover badge. Selecting another image replaces the reference. Trashing/removing
the cover clears it in storage and the mounted editor. Field writes use existing
publication permissions and expected revisions. No upload is duplicated.
Both storage backends validate reference ownership against the authoritative
record ID, including legacy records without an ID repeated in their data.

Validation:

- Local TypeScript check passes; each staged Linux role passes its TypeScript
  check and compiled-source hash validation.
- Publication suite: 83 pass, one PostgreSQL-only skip in the default run.
- Six focused cover/service tests, five custom-field runtime contracts, and
  two browser tests pass.
- Embedded PostgreSQL: four cover/publication tests pass.
- Two cover tests pass in the staged Linux runtime with isolated temporary
  filesystem storage.
- The existing contact-handoff source-contract assertion reproduces unchanged
  against the pre-task test/source baseline; it is outside this feature.

The release overlays only reviewed task changes on each role's immutable
baseline. Unrelated local/staged changes, environment files, runtime assets,
data and production services are preserved. Concurrent development rollouts
were detected before activation. A later release retained every feature source
and compiled file on web; remaining roles were rebased on that newer baseline.
Exact hashes and per-role evidence are in `output/project-cover-20261009/`.

Final verification: every task payload hash matches the live source and
compiled output. Public readiness returned 200 for development with outbound
safety enforced. Both hosted browser assets match the verified payload, and
the cover/editor browser regression passes using those downloaded hosted
scripts with isolated fixture APIs (it does not edit customer projects).

| Role | Active release | Verified payload files |
| --- | --- | --- |
| web | `19b0cf9eee974520775c34fc8564a4e35b8cce7e` | 16 |
| worker | `c7d9d4e28e65ba37973a47e2673fabc2d22a70d3` | 13 |
| legacy | `c7d9d4e28e65ba37973a47e2673fabc2d22a70d3` | 16 |
| pool | `c7d9d4e28e65ba37973a47e2673fabc2d22a70d3` | 16 |

Rollback requires checking for newer releases first. Web's later release already
retains this feature; do not replace it with an older feature-only baseline.
For worker, compatibility and pool, the audited preceding paths below are
available: restore the applicable `current` symlink, restart its development
service, reload PHP-FPM for browser asset roles, and verify readiness and
isolation. Review dependent field use before removing the built-in contract;
stored custom values must be preserved. Production was not changed.

- worker: `/opt/firstmeasure/releases/797e7ecfec6d6d182d2af7a6a79fb84864fb915a`.
- legacy: `/opt/firstmeasure/releases-root-archive/19b0cf9eee974520775c34fc8564a4e35b8cce7e`.
- pool: `/opt/firstmeasure/releases/19b0cf9eee974520775c34fc8564a4e35b8cce7e`.
