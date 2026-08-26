# FirstMeasure password-reset SMS

This directory contains the small portion of the FirstMate Telnyx integration that FirstMeasure needs for password-reset OTPs. It deliberately uses the Telnyx Verify API instead of copying the general-purpose `v1/messaging` subsystem.

## Configuration

Create a Telnyx Verify Profile with SMS enabled, a six-digit code, a five-to-ten-minute timeout, and only the destination countries FirstMeasure supports. Then configure these deployment secrets:

```dotenv
TELNYX_API_KEY=...
TELNYX_VERIFY_PROFILE_ID=...
TELNYX_BASE_URL=https://api.telnyx.com/v2
TELNYX_REQUEST_TIMEOUT_MS=10000
```

The API key may be from the existing Telnyx account, but it must be installed through the deployment secret store. Do not copy FirstMate's `.env`, local configuration, or credentials into this repository.

The portal's forgot-password request explicitly asks for SMS delivery. Activation and signup verification continue to use email.

## Telnyx sender registration

An OTP is message content, not a short code. If FirstMeasure instead sends through Telnyx's ordinary `/messages` endpoint from a US local ten-digit number, that sender needs an approved 10DLC brand, campaign, and number assignment. Toll-free and dedicated short-code senders have their own verification/provisioning paths.

Telnyx Verify is the recommended path here because it generates, sends, expires, rate-limits attempts, and validates the OTP through a Verify Profile without bringing FirstMate's number purchasing, campaign management, inbound webhooks, message queues, and organization ownership model into FirstMeasure.
