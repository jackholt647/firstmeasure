# FirstMeasure Remote API

Read-only, aggregate-only access to FirstMeasure production metrics.

## Routes

- `GET /v1/firstmeasure-remote/ping`
- `GET /v1/firstmeasure-remote/summary?timezone=America/Los_Angeles`
- `POST /v1/firstmeasure-remote/query`

Every route requires `Authorization: Bearer <key>`. The API returns no project IDs, addresses, customer information, employee names, files, or arbitrary database rows. The query endpoint uses allowlisted filters and groupings and never accepts SQL.

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

Upload this entire folder to `public/v1/firstmeasure-remote/` and upload the modified `public/v1/src/app.ts`. Then, from `public/v1` on the server:

```bash
npm run check
npm run build
# restart the existing v1 service using its normal service manager
```

No dependency installation or database migration is required.
