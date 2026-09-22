# Development deployment availability — September 18, 2026

Repeated development releases caused site-wide load-balancer 503 responses. Web HTTP workers entered drain (readiness false) and then waited ROLLING_DRAIN_MS=40000 before closing. The compatibility API used the default 25000 ms. With one serving instance per role, this removed the only backend during routine restarts; the balancer also needed time to mark it healthy again. Service NRestarts remained zero: these were requested deployments, not crashes.

Development-only correction on web 143.198.68.11 and compatibility 137.184.229.145:
- /etc/firstmeasure/development-drain.env sets ROLLING_DRAIN_MS=0.
- /etc/systemd/system/firstmeasure-development-{web,legacy}.service.d/99-development-drain.conf loads that EnvironmentFile last.
- The app still calls Fastify app.close() for graceful request shutdown. Only the fixed pre-close rolling-deployment wait is removed.
- Production, workers, geometry, project data and code release pointers are unchanged.

Preserve this override in future development deployments. It reduces restart outages; a single instance does not guarantee zero downtime. Full zero-downtime deployment would require overlapping ready serving instances and coordinated switching.

Rollback: remove the named drop-in on each development host, daemon-reload, and restart its corresponding development service. The original per-role environment then takes effect (40000 ms web, 25000 ms default compatibility).

Validation: both running service environments were checked and ROLLING_DRAIN_MS=0 confirmed. Fresh per-role readiness returned healthy development data and enforced outbound isolation. The concurrently deployed code release at validation was c7ad4a788c5dce86f62b1c10ff3ca52ff2d4d550; this operational fix did not change release pointers. The initial activation still drains using the previous process settings, then the new process uses zero delay.
