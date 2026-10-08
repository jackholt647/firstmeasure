# Development full-house access - October 8, 2026

The editor returned plain `Not found` for an authorized full-house project.
Unauthenticated routing still reached the staff login, so route health alone
missed the failure. The pooled web process on do-603124965 lacked both
`FIRSTMEASURE_FULL_HOUSE_ENABLED` and `FIRSTMEASURE_FULL_HOUSE_EMAILS`; the
fixed web process had the existing enabled setting and allowlist.

Restored exactly those two settings from the fixed development web server to
`/etc/firstmeasure/development-runtime.env` on the pool server and restarted
only its development web service. Existing file permissions were retained;
the prior configuration is backed up on that host as
`development-runtime.env.before-full-house-20261008`. No code, project data,
production configuration or user permissions were modified.

Verification: signed capability and project GET requests returned 200 on both
web servers. Reloading the user's authenticated error tab opened the editor.
Read-only checks and the scoped repair script are under
`output/full-house-access-repair-20261008/`; no signing secrets were printed.

Future replacement-node validation must include both full-house settings and
an authorized capability request, as required by INTERNAL_EXTERIORS.md.
This repair persists on the current pool node; replacement-image provisioning
was not changed or tested during this incident.
