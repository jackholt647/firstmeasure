# V1 public links API

Public links provide a reusable, non-customer-portal credential for sending an
organization's customer to one specific backend resource. Feedback is the first
consumer, but the API is deliberately resource-agnostic.

## Security model

- A link is a 256-bit bearer credential. Possession authorizes only the actions
  recorded on that link; it does not create a platform or customer-portal session.
- Every record belongs to exactly one organization and points to one resource.
- The token contains an encoded organization lookup hint so resolution reads one
  tenant instead of scanning all tenants. The hint is not trusted for authentication.
  The SHA-256 token hash stored in that tenant is compared in constant time.
- Public-link records store only the token hash and a short diagnostic fingerprint.
  The clear token is returned once when created. A feature that must resend the
  same URL is responsible for keeping that credential in its own private record.
- Links can expire, be revoked, and restrict actions. Redirect targets must be
  local absolute paths, preventing an open-redirect primitive.
- Administrative mutations use normal platform authentication, organization
  permission checks, and CSRF validation. Public consumers do not use cookies.

## Canonical URLs

- Local development: `http://127.0.0.1:8011/l/{token}`
- Production: `https://app.1m8.ai/l/{token}`

Set `PUBLIC_BASE_URL` to override the deployment origin. Delivery URLs are never
derived from `Host` or forwarding headers on the request that initiated a send.

## Administrative endpoints

All organization endpoints require `manage_company_settings`.

### Create a link

`POST /v1/public-links/organizations/:orgId/links`

```json
{
  "kind": "feedback",
  "resource_type": "feedback_request",
  "resource_id": "feedback_123",
  "destination_path": "/v1/feedback/public/{token}/app",
  "allowed_actions": ["view", "rate", "review_click"],
  "expires_at": "2027-01-01T00:00:00.000Z",
  "metadata": { "source": "feedback_system" }
}
```

The response contains the clear `token` and canonical `url`. They are not returned
by later list calls.

### List links

`GET /v1/public-links/organizations/:orgId/links`

Returns safe link metadata, status, expiry, access count, and fingerprint. Token
hashes are omitted.

### Revoke a link

`POST /v1/public-links/organizations/:orgId/links/:linkId/revoke`

Revocation is immediate. A subsequent public open receives `public_link_revoked`.

## Public endpoint

`GET /l/:token` validates the link, records access, substitutes the encoded token
for `{token}` in the local destination, and responds with a no-store redirect.

Feature APIs must also resolve the token with their expected `kind` and action on
every read or mutation. The redirect is convenience, not the authorization check.

## Feedback integration

New feedback requests mint a `kind: feedback` public link and store its link id and
credential on the private feedback request so SMS and email can reuse it. Feedback
view, rating, and review-click calls independently validate `view`, `rate`, and
`review_click`. Pre-existing UUID feedback links remain readable for compatibility;
the next ensure/send operation upgrades the request to a public link.
