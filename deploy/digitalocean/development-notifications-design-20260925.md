# Development Notifications redesign — September 25, 2026

The Notifications settings page now uses accessible toggle switches, branded states,
event descriptions, clearly explained In app/Push channels, and responsive cards.
On narrow phones, each event has its own labeled pair of switches. Keyboard focus,
44px targets, reduced motion, and the existing preference/autosave contracts are preserved.
Only `renderNotificationSettings()` in `public/libraries/apps/settings/company.js` changed.

Source commit: `b2b29d51ff02d52e187d8d0092aac791c5d802e7`.

Development activation preserves each complete live `f517e59d39ae19b4b158dc3556dead3013d01f8b`
predecessor, including language catalogs, Exteriors and the FirstMate mobile download.

- Web: `85174c5296db43ff46022d9c5c679a4dd7cf44b5`.
- Pool: `93c0a6460f1c173c8523e4170615e9d7b0571a91`.
- Expected company.js SHA-256: `47a56af768a95cc3e4557704cd0ac0ce226fa21f044bc67828d295358d28fdef`.

Verification: JavaScript syntax check, authenticated Chrome desktop and 320/390px
phone layouts, ten accessible switches, keyboard activation and correct autosave
payload using an intercepted save API (no tester preference changes). Deployment
requires predecessor/hash checks and development readiness, with rollback on failure.
Production and native push provider configuration are unchanged.
