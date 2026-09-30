# My Contacts search removal - September 30, 2026

Feature commit: `0d3f064715641f07131a4492336e6006712b6799`.

Removed the redundant local search input, filtering state/handlers and search-only CSS from My Contacts. Global search is unchanged. Sort, Tiles/List, Import and contact/project opening remain available. The contact bundle token is updated.

Validation: frontend syntax check and the existing Contacts browser checks for view switching, sorting, contact/project links, Feed typography/padding parity and 390px/320px layouts. Desktop/mobile screenshots inspected. The browser fixtures use actual app code with isolated contact data.

Deployment overlays only `public/libraries/apps/contacts/app.js` and its exact manifest bundle token on audited role-specific live baselines, preserving unrelated assets and manifest changes. Development runtime, source hashes and readiness guard staging and activation, with rollback on failure. No production changes.

Audited prior baseline on all three roles: `e1ca0429f616c1a0017fedb7a80c41834627de88`. Rollback restores that role release pointer, restarts its development service and PHP-FPM, and verifies development isolation/readiness; inspect for intervening releases first.

Two public asset hashes and six public readiness responses passed. The Contacts browser check passed again with the hosted app script, including absence of local search, sorting, view controls, contact/project links and mobile layouts.

Activated and directly verified on development web, pool and compatibility with exact asset hashes and development safety checks.
