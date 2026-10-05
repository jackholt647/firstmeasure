# Settings search dropdown — October 5, 2026

Search results now open in an anchored, opaque top-layer dropdown over the Settings navigation. The navigation retains its layout. Results scroll inside the dropdown, support click and arrow/Enter selection, and close on Escape, outside interaction or category navigation. A text input with one custom clear button prevents the duplicate native search X.

Source: `119be99265394a06e7013cb6bbf0d64a69f6f719` on the canonical branch. The release overlays only `public/libraries/apps/settings/company.js` onto audited development baseline `585ea6f8e90a1b4fee883b6bd0154430fde183a2`. Department work and unrelated working changes are excluded. Backend, worker, production, data and configuration are unchanged.

The browser regression passed against the isolated release source at desktop and mobile sizes, including clipping beneath transformed overflow-hidden containers, result selection, keyboard behavior, scrolling, dismissal, empty results and the single clear control. Five focused local tests passed before release preparation.

Release staging manifests, per-role source hashes, previous absolute paths and rollback evidence are in `output/settings-search-dropdown-20261005/`. Rollback restores each recorded previous symlink, restarts the corresponding development service, reloads PHP-FPM and verifies readiness and development isolation.

Deployment completed on all three development roles with readiness and isolation checks. Public source SHA-256 matched the release payload, and the browser regression passed against the downloaded hosted JavaScript. One asset request returned 503 during the final rolling activation; the subsequent request and public readiness passed.

A concurrent later release `f590528965536bf351231c866dca59ce83a867cf` superseded the web role during final verification. A fresh audit verified the exact search source hash on that release and on both remaining roles at `119be99265394a06e7013cb6bbf0d64a69f6f719`. The newer release preserves this fix. Evidence is recorded in `final-source-verification.json`; rollback must account for any later rollout rather than reverting its unrelated changes.
