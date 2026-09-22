# FirstMate customer hosting deployment

This is the production contract for websites connected through Domains & Hosting. Customer DNS is managed in Cloudflare, but website ownership remains in the FirstMate backend. One shared origin serves every published website by resolving the request hostname to a website record.

## Architecture

1. OpenSRS registers or transfers the domain and enables WHOIS privacy.
2. OpenSRS delegates the nameservers to the Cloudflare zone created by FirstMate.
3. Cloudflare provisions email records and proxied `@` and `www` website records.
4. Those website records target `CLOUDFLARE_WEBSITE_TARGET` (the tunnel's `<uuid>.cfargotunnel.com` hostname).
5. The Cloudflare Tunnel sends every such hostname to the dedicated Nginx listener at `http://127.0.0.1:8081`. `sites.firstmatehosting.com` points to the same tunnel as a stable health-check hostname, but customer records do not depend on a CNAME chain through it.
6. Nginx runs only `public/sites/index.php`; the browser runtime asks `/v1/websites/public/host/:hostname/resolve` which published website owns that hostname.

No per-customer Nginx configuration, PHP directory, deployment, or origin TLS certificate is required.

## Required production variables

Set the normal platform variables plus the following in the v1 backend environment:

```dotenv
NODE_ENV=production
PLATFORM_STORAGE_ROOT=/var/lib/firstmate/platform

DOMAINS_DELIVERY_MODE=live
DOMAINS_ORDER_TEST_MODE=false
DOMAIN_INFRASTRUCTURE_MODE=live
OPENSRS_LIVE_USERNAME=...
OPENSRS_LIVE_API_KEY=...
DOMAINS_ENCRYPTION_KEY=...

CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_WEBSITE_TARGET=<tunnel-uuid>.cfargotunnel.com

HOSTING_ORIGIN_ZONE=firstmatehosting.com
HOSTING_ORIGIN_HOST=sites.firstmatehosting.com
HOSTING_ORIGIN_TYPE=CNAME
HOSTING_ORIGIN_VALUE=<tunnel-uuid>.cfargotunnel.com

FIRSTMATE_MAIL_DOMAIN=firstmatemail.com
EMAIL_DELIVERY_MODE=live
EMAIL_TEST_RECIPIENT_REWRITE=false
CLOUDFLARE_EMAIL_WORKER_URL=https://firstmate-email-router.<workers-subdomain>.workers.dev/outbound
CLOUDFLARE_EMAIL_WORKER_TOKEN=...
EMAIL_INBOUND_WEBHOOK_TOKEN=...
EMAIL_ORGANIZATION_HOURLY_LIMIT=500
EMAIL_ORGANIZATION_DAILY_LIMIT=2000
EMAIL_TENANT_MINIMUM_REPUTATION_SAMPLE=50
EMAIL_TENANT_BOUNCE_RATE_LIMIT=0.05
EMAIL_TENANT_COMPLAINT_RATE_LIMIT=0.001
```

Use an absolute, persistent `PLATFORM_STORAGE_ROOT`. The hostname registry is stored at `config/website_hosts.json` below that root and must be shared by every API worker. Keep `DOMAINS_ORDER_TEST_MODE=true`, `DOMAIN_INFRASTRUCTURE_MODE=capture`, and `EMAIL_DELIVERY_MODE=capture` in non-production environments.

Also set `MESSAGING_STORAGE_ROOT` to an absolute persistent directory shared by every API worker. It contains delivery attribution, tenant status, inbound idempotency, and reputation ledgers. The two shared email secrets must match `FIRSTMATE_OUTBOUND_API_TOKEN` and `FIRSTMATE_INBOUND_WEBHOOK_TOKEN` on the Cloudflare Worker respectively.

## Cloudflare email wiring

The application does not poll a mailbox. Cloudflare owns the durable inbound path and the provider-specific outbound transport:

1. Email Routing uses a catch-all rule for `firstmatemail.com` targeting `firstmate-email-router`.
2. The Worker stores raw MIME in the private `firstmate-raw-email` R2 bucket and enqueues its object key on `firstmate-inbound-email`.
3. The queue consumer parses the MIME and posts a normalized event to `/v1/email/inbound/events`. Failed jobs retry and eventually land on `firstmate-inbound-email-dlq`; successful jobs delete their R2 objects.
4. Outbound V1 requests call the Worker's token-guarded `/outbound` endpoint. Its native Email Sending binding sends through the enabled `firstmatemail.com` sending domain, so the V1 host does not hold a Cloudflare account API token for mail.
5. Configure an R2 lifecycle policy for stale failed-message objects after the desired investigation window.

The Worker project and its deployment instructions live in `public/v1/cloudflare-email-worker`.

## Cloudflare Tunnel

Create one tunnel for the droplet. Its ingress needs a catch-all hostname rule so the original customer `Host` header reaches FirstMate:

```yaml
tunnel: <tunnel-uuid>
credentials-file: /etc/cloudflared/<tunnel-uuid>.json
ingress:
  - service: http://127.0.0.1:8081
  - service: http_status:404
```

Run `cloudflared` as a system service. The Cloudflare API token used by FirstMate needs Zone Read, Zone DNS Edit, and Zone Edit for the account that will contain customer zones. Do not add individual tunnel ingress entries for customer domains; FirstMate creates their proxied DNS records and the catch-all preserves each hostname.

## Dedicated Nginx listener

Render `nginx/firstmate-hosting.conf.template` into `/etc/nginx/conf.d/firstmate-hosting.conf`. Restrict `envsubst` to this explicit variable list so it does not erase Nginx variables such as `$host`:

```bash
export FIRSTMATE_HOSTING_LISTEN=127.0.0.1:8081
export FIRSTMATE_PUBLIC_ROOT=/var/www/firstmate/public
export FIRSTMATE_API_UPSTREAM=127.0.0.1:3101
export FIRSTMATE_FASTCGI_PARAMS=/etc/nginx/fastcgi_params
export FIRSTMATE_PHP_FPM_UPSTREAM=unix:/run/php/php8.3-fpm.sock
export FIRSTMATE_HOSTING_ACCESS_LOG=/var/log/nginx/firstmate-hosting-access.log
export FIRSTMATE_HOSTING_ERROR_LOG=/var/log/nginx/firstmate-hosting-error.log

envsubst '${FIRSTMATE_HOSTING_LISTEN} ${FIRSTMATE_PUBLIC_ROOT} ${FIRSTMATE_API_UPSTREAM} ${FIRSTMATE_FASTCGI_PARAMS} ${FIRSTMATE_PHP_FPM_UPSTREAM} ${FIRSTMATE_HOSTING_ACCESS_LOG} ${FIRSTMATE_HOSTING_ERROR_LOG}' \
  < nginx/firstmate-hosting.conf.template \
  | sudo tee /etc/nginx/conf.d/firstmate-hosting.conf >/dev/null
sudo nginx -t
sudo systemctl reload nginx
```

Adjust the repo path and installed PHP-FPM socket if the droplet uses different values. Keep port 8081 bound to loopback; Cloudflare Tunnel is the only intended caller.

## First deployment and verification

From `public/v1`:

```bash
npm ci
npm run build
npm run hosting:rebuild-hosts
npm run hosting:provision-origin
npm run email:migrate-lead-inboxes
npm run hosting:check
```

Deploy the Cloudflare Worker before enabling the Email Routing catch-all:

```bash
cd cloudflare-email-worker
npm ci
npx wrangler secret put FIRSTMATE_INBOUND_WEBHOOK_TOKEN
npx wrangler secret put FIRSTMATE_OUTBOUND_API_TOKEN
npx wrangler deploy
cd ..
sudo systemctl restart firstmate-v1
```

Follow with these checks:

```bash
curl --fail http://127.0.0.1:8081/__firstmate/hosting-health
curl --fail --resolve example-customer.com:8081:127.0.0.1 http://example-customer.com:8081/
```

The second request should render the customer website shell; the browser resolves the hostname to the attached published site. An unattached hostname intentionally renders “Website not found.”

`npm run hosting:rebuild-hosts` migrates domains already attached before hostname routing was deployed and fails on duplicate ownership. `npm run hosting:provision-origin` is idempotent. `npm run hosting:check` is read-only and exits nonzero when a required production setting or the shared origin DNS is missing.

## Rollout order

1. Deploy/build the backend and public files.
2. Install/reload the dedicated Nginx listener.
3. Start the Cloudflare Tunnel.
4. Run `npm run hosting:provision-origin` and `npm run hosting:check`.
5. Run `npm run email:migrate-lead-inboxes` to backfill FirstMate Mail lead addresses and aliases.
6. Test one synthetic organization and non-customer domain end to end: send, reply, bounce, and complaint.
7. Switch domain infrastructure and email delivery from capture to live only after the checks pass.
