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
- `POST /organizations/:orgId/domains/:domain/email-records/check`

Resources take `website: { mode: "none" }` for an email address with no website: the Communications setup
(FM-513) connects or buys a domain for the company's email this way (`FirstMateDomainsSettings.openForEmail`).

## Email on a customer's domain (FM-516)

`email-records.ts` lists the records a domain serves for FirstMate email, all through Cloudflare:

- receive (Email Routing): root MX `route1-3.mx.cloudflare.net` and SPF `v=spf1 include:_spf.mx.cloudflare.net ~all`;
  a catch-all rule sends every address at the domain to the Email Worker (`CLOUDFLARE_EMAIL_WORKER_NAME`).
- send (Email Sending): MX and SPF on `cf-bounce.<domain>` and the DKIM key Cloudflare issues.
- policy: DMARC `v=DMARC1; p=none;` unless the domain already has a policy (never replaced).

Both services need the domain to be a Cloudflare zone, so a domain that stays at its registrar is pointed at the
zone's nameservers there; Cloudflare then serves the records. Live provisioning (`provisioning.ts`) enables Email
Routing, sets the catch-all, creates the Email Sending domain, folds what Cloudflare issued into `email_records` and
adds DMARC; a failure leaves `email_configuration_status: cloudflare_onboarding_pending` with `email_provider_error`
and the website records in place. Capture mode creates nothing and stores the expected records.

`checkDomainEmail` (`email-records/check`, also run once when an address is attached) looks the records, and the
zone's nameservers when there is a zone, up in public DNS. It never calls Cloudflare, so it runs in capture mode too.
All found: `email_configuration_status` becomes `active` and the domain's address becomes the default sender
(`setOrgDomainEmailSending`). Records missing later: back to `records_pending`, and FirstMate Mail sends until they
return. A simulated domain (registry test mode) has nothing in DNS; its records are taken as found, as its verification
is. Statuses: `pending_provider_setup` (address chosen) → `records_pending` → `active`. Disconnecting a domain disables
its identity. Settings › Domains › Manage shows the records, the nameservers to set at the registrar, and a check.
