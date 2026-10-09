# Primary project images — October 9, 2026

Feature commit: `f99e06caad15894bb3764cbd13370bbe43d41361`.

The built-in single Photo reference `cover_photo` chooses the primary project
image. Leaving it empty uses the existing satellite image. Clearing a cover
ignores stale thumbnail aliases and returns tiles to satellite imagery.
Project tiles, derived photo-display aliases, and proposal photo defaults use
the selection. Photos synchronizes the mounted Overview field, aliases, and
project-viewer cache after a cover change. Measurement maps remain satellite.

Customer portal primary imagery and nearby project thumbnails select the cover
only from already explicitly shared media. Choosing a cover does not publish a
private photo, and the public satellite reference remains separately available.

Validation completed before activation:

- Local TypeScript check passes.
- Four primary-resolution/display/privacy tests and the browser cover/editor
  integration pass, including clear-to-satellite behavior.
- Customer portal API regression passes with private-cover fallback, shared
  cover selection, and shared markup preservation.
- Publication suite: 83 pass, one PostgreSQL-only skip.

Each role overlays only the task's reviewed delta on its own immutable current
release. Source reconciliation preserves unrelated local/staged work and live
development changes. Runtime identity, development cookie/environment, payload
hashes, Linux TypeScript checks, and compiled-source equivalence are checked
before activation. Evidence is in `output/project-primary-20261009/`.

All four development roles passed their staged Linux TypeScript checks. The four
primary tests also pass in the staged Linux runtime. After activation, every
payload source/compiled hash matches the active releases, and each role passes
readiness with development data and cookie isolation and outbound safety enforced.
All four hosted frontend assets match the release. The browser cover/editor
regression passes with those downloaded hosted scripts and isolated fixture APIs;
it does not mutate customer projects. Public readiness returned the verified release.

| Role | Active release | Verified files |
| --- | --- | --- |

| web | `f99e06caad15894bb3764cbd13370bbe43d41361` | 13 |
| worker | `f99e06caad15894bb3764cbd13370bbe43d41361` | 8 |
| legacy | `f99e06caad15894bb3764cbd13370bbe43d41361` | 13 |
| pool | `f99e06caad15894bb3764cbd13370bbe43d41361` | 13 |

Rollback requires checking for newer releases before replacing the applicable
current symlink. Restore its audited prior path below, restart only its development
service, reload PHP-FPM for web assets, and verify readiness/isolation. Keep stored
cover references. Production was not changed.

- web: `/opt/firstmeasure/releases/a28ddbc60535e5644fa0562c18d3e20c77472578`.
- worker: `/opt/firstmeasure/releases/c7d9d4e28e65ba37973a47e2673fabc2d22a70d3`.
- legacy: `/opt/firstmeasure/releases-root-archive/a28ddbc60535e5644fa0562c18d3e20c77472578`.
- pool: `/opt/firstmeasure/releases/a28ddbc60535e5644fa0562c18d3e20c77472578`.
