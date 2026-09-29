# Global presence and Channels controls — September 29

Authorized for push and development activation; production remains unchanged.

Every authenticated FirstMate portal tab maintains an organization-scoped presence connection, including hidden tabs and tabs outside Channels. Mouse, pointer, touch, keyboard and wheel activity updates the authenticated session's activity time. Any active tab makes the user active; open but inactive tabs make them away; closing the last connection removes their presence. The server's `PLATFORM_PRESENCE_IDLE_MS` controls the idle threshold (default 300000 milliseconds). Lost connections expire after the existing 30-second lease. Project-viewing presence remains separately scoped to visible project surfaces.

Green/gray status dots appear at the corner of individual DM avatars and in profile popups, not beside every message. Message reaction tooltips list the reacting people and emoji. Dictation and recording buttons become colored active toggles; a second click invokes the same finish action as Stop. Scheduling mounts the shared date/time picker directly inside one modal with Schedule send.

Validation: 34 targeted backend/client tests passed, including multi-tab aggregation, idle transition, offline cleanup and session ownership. An additional API check verifies activity authentication and CSRF. Browser checks cover status placement, named reaction tooltips, recording toggle/finish/cancel, one-modal scheduling, and the shared picker's existing keyboard/mobile/form behavior. TypeScript check and build passed.

The existing presence store advances to schema version 2 with an additive per-session activity table. This uses the shared SQL store migration lock and registry; no existing table columns or user data are removed. Deployment inherits each role's complete current runtime and verifies source hashes before applying the reviewed overlay. Activation and rollback records follow after verification.
