# SMS registration availability and approval notifications — October 11, 2026

Development-only change. Cedar Puffin Test Co 980037 is `org_99d6466374fe981a`.
The organization already has `platform.sms_settings`; add its ID to the existing
`SMS_LIVE_REGISTRATION_ORGANIZATION_IDS` deployment setting on the development
HTTP hosts to expose the live registration workflow instead of capture-mode setup.
This does not submit an application or buy a number.

Carrier campaign approval (`mno_provisioned`, produced by the VERIFIED webhook)
creates an SMS registration notification for active users with company-settings
management permission. Business verification alone is insufficient. Webhook and
provider-refresh paths share stable campaign/branch notification identities.
Notification methods default to in-app and email, respect personal opt-outs and
quiet hours, and recheck membership/permission at delivery. In-app clicks open the
SMS workflow. Email uses FirstMate account mail, not the customer's email sender.
Development email restrictions remain in force.

The existing durable notification lane handles recipients and delivery claims.
A marker saved with the provider-state event allows bounded background recovery
of a crash before notification creation. Recovery does not announce historical
approvals without that marker. Interrupted external email sends retain the lane's
uncertain state rather than being blindly resent. Approval copy does not claim
number activation is already complete.

Validation: TypeScript check; 24 approval/webhook tests; 72 messaging and notification
regressions (including the 38 messaging API cases); browser-script syntax checks.
The new approval tests use simulated provider events and a stub email transport.
No real test notification or registration was sent.

Deploy as guarded per-host overlays of current source and compiled modules;
web and worker baselines differ and must be merged independently. Preserve all
unrelated assets and production services.
