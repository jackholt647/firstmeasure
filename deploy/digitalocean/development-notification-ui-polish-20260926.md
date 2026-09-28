# Notification settings polish — September 26, 2026

Development-only source: `13c391d`.

- Combined Workflows & scopes tab; scopes without notification declarations are hidden.
- Settings humanize template placeholders without modifying delivery templates or preference keys.
- Wider mini FirstMate assistant tray, matching chat bubbles and rounded bottom composer; no history or docking controls.
- Consistent Add custom control and explicit separation between information buttons and notification switches.

Verified desktop and mobile browser behavior, category filtering, template labels, information-button spacing, keyboard sending, fixed toolbar, custom preference retention, and absence of browser errors. Authenticated development verification for the notifications test account confirmed the combined tabs, wider assistant, search and mobile chat. The temporary verification session was revoked.

Runtime releases preserve each serving node's prior tree and update only `public/libraries/apps/settings/company.js`:

| Role | Previous | Release |
| --- | --- | --- |
| Web | `42a8a41a2b14a498ee664a8a36750a1161dd2df8` | `3b7afcf91e8878226135c6a67de68fdd15454ff3` |
| Pool | `08df5f75a6820da33d4d1c27722b706368a37f02` | `ce2a4c9aa00d1f66636199fe692bee7c3ad3a705` |

No backend or production deployment is required for this presentation change.
