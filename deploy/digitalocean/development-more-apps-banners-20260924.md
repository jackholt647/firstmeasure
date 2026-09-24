# More Apps banner and top-bar interaction — September 24, 2026

Development web release `05a5d0488b416d9e08a52ea2a9cfc1b21ca678d1` applies the three-file portal change from the source commit with the same ID. The advanced More Apps overlay begins below the active top attention banner (and the support impersonation banner), while the sidebar retains expanded content styling until the menu closes. Opening the AI assistant closes open messages and notifications menus, including the mobile assistant entry.

Both serving web nodes were staged from their exact live `0068a9616c31d82ad74f3f3d1e58771a49ad308c` baseline. The update preserved other live files and applied only the intended selectors, overlay CSS, and top-bar handlers. Node and PHP syntax checks passed before activation. Both nodes passed local development readiness, and public readiness returned the new release from both instance IDs.

In Chrome, the Forward application banner ended at 49.96 px and the More Apps overlay began at 50 px. With the pointer outside the sidebar, its width remained 250 px, link text stayed visible, and the Apps/To Do/Channels tabs remained visible. Clicking AI Assistant closed each open dropdown in turn.

Rollback target on both development web nodes: `0068a9616c31d82ad74f3f3d1e58771a49ad308c`. Production was not changed. The development autoscale image remains historical and needs this release before a replacement node can preserve the behavior.
