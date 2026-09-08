# FirstMeasure Remote API

Read-only, aggregate-only access to FirstMeasure production metrics.

## Routes

- `GET /v1/firstmeasure-remote/ping`
- `GET /v1/firstmeasure-remote/summary?timezone=America/Los_Angeles`
- `POST /v1/firstmeasure-remote/query`

Every route requires `Authorization: Bearer <key>`. The API returns no project IDs, addresses, customer information, employee names, files, or arbitrary database rows. The query endpoint uses allowlisted filters and groupings and never accepts SQL.

The metrics implementation supports both SQLite and PostgreSQL through the
configured application database. Summary days use the requested timezone;
historical `group_by: "day"` uses UTC on both backends. Queries return at most 500
groups and `total` sums those returned rows. Narrow the range before treating a
500-group result as exhaustive.

The portable co-founder client and command reference are in
`tools/firstmeasure-remote-share/` at the repository root. It reads the existing
shared bearer key from a private local credential file and never needs a customer
API account or server SSH key.

## Configuration

Generate a key and hash using the `Generate-Remote-Key.ps1` script in the separate **FirstMeasure Remote** client folder. Put only the hash in the v1 service environment:

```text
FIRSTMEASURE_REMOTE_API_KEY_SHA256=<64-character SHA-256 hash>
```

Optional hardening:

```text
FIRSTMEASURE_REMOTE_ALLOWED_IPS=203.0.113.10,198.51.100.4
FIRSTMEASURE_REMOTE_ALLOWED_ORIGINS=https://trusted-app.example.com
FIRSTMEASURE_REMOTE_REQUIRE_HTTPS=true
```

Browser-origin requests are rejected unless explicitly allowlisted. The supplied local client uses a loopback proxy and therefore does not need an allowed browser origin. HTTPS is required for external traffic by default.

## Deployment

Include the reviewed Remote API code in the environment's curated release.
Do not deploy the entire dirty working tree. Keep its existing route registration
in `public/v1/src/app.ts`, preserve the shared key hash on every serving web node,
and use the normal verified release activation procedure.

When migrating from SQLite to PostgreSQL, include the metrics compatibility
change: older Remote API code calls the direct SQLite accessor and fails under
PostgreSQL. Verify authenticated ping, summary and a bounded query before and
after cutover through the stable production hostname. No dependency installation
or database migration is required for this compatibility change. A `service_locked`
503 means the key hash is missing or invalid; it is not a successful auth check.
