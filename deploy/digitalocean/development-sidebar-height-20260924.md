# Stable compact sidebar height — September 24, 2026

Development web release `1d995eb7bff07ac6bda83d1ce94f2e9d1debd980` keeps the compact sidebar's logo row, New button row, tab-header space, and app-link spacing aligned with the expanded layout. Hover expansion now changes width without moving the app icons vertically. The tabs remain hidden and inactive while compact.

The source commit is based on the then-current development release `a827676fbbf9c865d606f68767711e0412a2141c`. The deployed `public/portal/index.php` also preserves the external-app registry fallback already present on both serving nodes; only the sidebar CSS differs from their live file. Deployed PHP file SHA-256: `62785a9c70795af4cd71ddef7e644a0ad05a4cc8df3d0d28a6c2571d14923093`.

PHP lint and `git diff --check` passed. Both web nodes passed local development readiness, and public readiness returned the new release ID from both instances. In Chrome, the first six app links had identical vertical positions in collapsed and hover-expanded states. Production was not changed. The development autoscale image remains historical and needs this release before a replacement node can preserve the behavior.

Rollback target on both development web nodes: `a827676fbbf9c865d606f68767711e0412a2141c`.
