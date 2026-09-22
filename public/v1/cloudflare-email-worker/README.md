# FirstMate Cloudflare Email Worker

Email Routing sends all `@firstmatemail.com` mail to this Worker. The email
handler stores the raw MIME message in private R2 and enqueues only its object
key. The queue consumer parses MIME and posts the normalized payload to the V1
inbound endpoint. Successful deliveries delete the R2 object; repeated failures
land in `firstmate-inbound-email-dlq`.

The same Worker exposes a token-guarded `POST /outbound` endpoint. V1 sends a
Cloudflare Email Service payload there, and the native `EMAIL` binding performs
the delivery without giving the application a Cloudflare account API token.

`FIRSTMATE_INBOUND_WEBHOOK_TOKEN` is a Wrangler secret and must match the V1
host's `EMAIL_INBOUND_WEBHOOK_TOKEN`. Never place it in `wrangler.jsonc`.
`FIRSTMATE_OUTBOUND_API_TOKEN` must match the V1 host's
`CLOUDFLARE_EMAIL_WORKER_TOKEN` and is also a Wrangler secret.
