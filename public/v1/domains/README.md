# Domains service (`/v1/domains`)

Provider-neutral domain procurement boundary. The first provider is OpenSRS.

Cloudflare DNS and Email Service form the infrastructure layer behind the registrar boundary.
`DOMAIN_INFRASTRUCTURE_MODE=capture` records the exact DNS and email plan without
creating zones, changing nameservers, or onboarding Email Service resources. In
`live` mode, resource attachment creates or reuses a Cloudflare full zone and
delegates registrar-managed domains to the Cloudflare-assigned nameservers.
Email Sending onboarding supplies DKIM/SPF and bounce records; inbound domains
route to the shared Email Worker with private R2 storage and a retrying Queue.

## Safety contract

- Live/test is selected by `DOMAINS_DELIVERY_MODE`; quotes cannot cross environments.
- Registration is quote-first and checks availability and price again immediately before purchase.
- Premium names require explicit confirmation.
- Standard registrations above `OPENSRS_MAX_STANDARD_REGISTRATION_PRICE_USD` fail closed.
- Every registration forces auto-renew, registrar lock, and WHOIS privacy.
- Quotes include the configured annual Contact Privacy fee and apply
  `DOMAINS_RETAIL_MARKUP_MULTIPLIER` (1.5 by default). Provider costs remain
  server-only; API clients receive the retail total.
- Billing is intentionally deferred. Registrations and transfers persist
  `billing_status: deferred` and `billing_collected: false`.
- External domains are verified with a unique DNS TXT record and never create a
  provider order.
- The domain is the idempotency key. Ambiguous provider outcomes are reconciled
  with `BELONGS_TO_RSP` before another billable request is permitted.
- OpenSRS registrant passwords and legal contact data are encrypted with
  `DOMAINS_ENCRYPTION_KEY` and are never returned by the API.

## Configuration

See `.env.example`. Live and Horizon use separate credentials, so the mode switch
selects the matching credential pair. OpenSRS also requires the calling machine's
public IP in its API allowlist. Use the primary reseller username, not the login
email or a sub-user.

`DOMAINS_ORDER_TEST_MODE=true` keeps live lookup and pricing available but
disconnects registration and transfer orders before the billable OpenSRS command.
The service writes a verified simulated record so the rest of onboarding can be
tested. Set it back to `false` and restart the backend to restore live orders.

## Routes

- `GET /config`
- `GET /organizations/:orgId`
- `POST /organizations/:orgId/quotes`
- `POST /organizations/:orgId/registrations`
- `POST /organizations/:orgId/transfers`
- `POST /organizations/:orgId/connections`
- `POST /organizations/:orgId/domains/:domain/verification/check`
- `POST /organizations/:orgId/domains/:domain/verification/resend`
- `POST /organizations/:orgId/domains/:domain/resources`
