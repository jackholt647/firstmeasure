# My Projects sticky stage headers — September 29, 2026

Development-only follow-up to the Projects/Contacts Feed parity release. Immutable candidate: `6feed5449d4536cef99d145672e8effa3501350f`.

Stage-grouped list rows omit their redundant stage pills. Board-grouped lists retain stage information. List section headers stick within their own section, so the next section replaces the previous header; collapse and stage movement controls are preserved.

Validation: JavaScript syntax check and Projects Playwright fixture passed, including duplicate pill suppression, retained board-group stage information, sticky position and next-section takeover, sorting, columns, view switching and mobile layout.

Deployment overlays only `public/libraries/apps/projects/viewer.js` and its bundle token in each role's live app manifest. Audited development web, pool and compatibility baselines were `4dac5e2e3a06026500ece6b5851b3524fc69b890`; compatibility manifest differences are preserved. Role-specific hashes, runtime development environment and baseline guards prevent deployment on drift. Production and worker roles are outside this rollout.

Rollback: on each role restore `/opt/firstmeasure/current` to its recorded prior release `4dac5e2e3a06026500ece6b5851b3524fc69b890`, restart that role's development service and PHP-FPM, then verify development readiness and environment isolation.

Activated and directly verified on all three development roles. Each returned the candidate release with development environment isolation and outbound safety enforced. Both public frontend asset hashes matched the payload; six public readiness responses passed. The Projects browser fixture also passed using the hosted viewer, including sticky takeover and pill suppression.
