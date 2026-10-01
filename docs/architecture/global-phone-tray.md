# Global phone tray and development onboarding

Call Center defaults to a standalone Communications group member. An explicit
organization App Layout setting can return it to the group or show both placements.
The Phone header button sits between Messages and Assistant and appears when the
authenticated organization has Communications access and voice is enabled.

`phone-tray.js` supplies a persistent shell around the existing CustomerPhone
runtime. One call, SDK connection and note draft survive dock, float, minimize
and app navigation. The initial placement is docked; the first floating placement
is at the lower right above existing minimized windows. Compact phone windows
cannot enter full, fullscreen or modal modes. Closing an active call minimizes it;
ending the call requires the explicit End control. An ended call stays available
for its outcome. The minimized title restores the previous expanded placement.

Opening an enabled phone starts browser registration automatically. Starting a
browser call waits for that same connection and shows Connecting; disconnected
state never silently selects an external phone. Closing an idle phone tears down
the SDK immediately and releases the endpoint lease. Closing during registration
cancels the pending start; late token, readiness and presence responses cannot
reopen it. A reopen waits for the previous lease cleanup. Minimize, dock and float
retain the connection. The first-device microphone/network readiness check and
incoming-call availability remain separate from automatic registration.

Dialer, Contacts, Call lists and Follow-ups share the call session. Contact lookup
uses the existing organization/branch calling authorization. Live input/output
traces use the SDK peer's existing audio tracks through Web Audio analysers;
they do not acquire a second microphone or generate simulated activity.

`require_disposition` defaults false. When enabled, the server blocks new calls
and inbound agent selection while that caller has an unfinished outcome. Notes
continue to autosave. Optional outcomes can be skipped without inventing a result.

## Development setup

The server's `dataEnvironment`, never a browser flag, enables the development
shortcut. New signup sandbox organizations carry development setup defaults and
standalone Call Center placement. Setup remains pending until a manager chooses
**Development tools → Skip to fully onboarded** in Call Center, Phone Setup, or
the SMS/10DLC setup screen.

The shortcut stores organization-specific mock brand/campaign approval and phone
settings. It does not purchase a number, submit a carrier registration, create a
billing commitment, or overwrite a real SMS compliance profile. The SMS wizard
shows a separate completed development summary and stops saving registration
drafts in that mode.

The existing verified development business line supplies real test transport.
Organizations reference its application/connection/outbound profile through
development-only aliases; provider ownership remains unique and inbound routing
remains with the original owner. Signed outbound events resolve the call's tenant
and verify its effective application. Aliases cannot resolve outside development.
Shared line routing and provider policy cannot be edited through mock onboarding.
Ambiguous or missing test transport fails explicitly rather than choosing a line.

At the Telnyx adapter boundary, all development PSTN dials and transfers redirect
to the designated test recipient and still require that recipient in the server
allowlist. Internal Telnyx SIP legs remain internal. Production destinations are
unchanged. No real test call is placed by the automated tests.

Tests: `phone-tray-browser.test.mjs`, `phone-development.test.ts`,
`customer-call-workspace-browser.test.mjs`, `customer-calls.test.ts`,
`telnyx-voice-provider.test.ts`, and `app-groups-browser.test.mjs`.
