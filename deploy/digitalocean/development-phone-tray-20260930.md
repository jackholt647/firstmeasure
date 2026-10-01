# Global phone tray and development onboarding

User-authorized development target: https://dev.1m8.ai. Production is unchanged.

Main implementation: `3c963b7c4158959562ca8c9c80707076fc3fcae8`.
Outcome restore and inline keypad: `fb692b6b8f7afb2a9006cbdb9e2f0dc27482d77c`.
Minimized Dock control: `2e553bf6256c9ef2c55a78447f5c5e43f0201103`.

Call Center defaults to a standalone app. The global Phone button sits between
Messages and Assistant once voice is enabled. The tray supports dock, float,
minimize, contact search, call-list tabs, follow-ups, live input/output traces,
mute, hold, end and inline DTMF. It has no fullscreen mode. Ended calls remain
available for outcomes; a phone setting can require dispositions server-side.

All signup sandbox instances receive development defaults. Managers can use
Development tools in Call Center, Phone Setup or SMS/10DLC setup to jump to mock
onboarding completion. The shortcut does not submit real registrations or buy
numbers. Per-organization development aliases reuse the verified test transport
without transferring provider ownership or inbound routing. Every development
PSTN dial/transfer is rerouted to the designated allowlisted recipient at the
carrier adapter boundary. See [architecture](../../docs/architecture/global-phone-tray.md).

Verification: local TypeScript and JavaScript checks; 36 existing customer-call
backend tests; six development/provider tests; four browser tests covering app
placement, phone readiness, optional/mandatory outcomes and window behavior.
Linux staging validates syntax, compiled output and TypeScript on each backend
role. Immutable overlays preserve each role's existing source; the older
compatibility manifest was merged without replacing its unrelated entries.

A real hosted Instant full org named **Phone tray release test**
(`org_b58fee5964283048`, sandbox `sbi_2846d597495eadf6`) was created. Authenticated
API checks confirmed pending setup, standalone placement, successful mock
onboarding, mock 10DLC approval and an active test transport. No phone call was
placed and no carrier registration or purchase was submitted.

Final activation: web, pool and compatibility are on
`2e553bf6256c9ef2c55a78447f5c5e43f0201103`; the worker remains on
`fb692b6b8f7afb2a9006cbdb9e2f0dc27482d77c` with the same backend implementation.
All services passed development readiness and outbound-safety checks. Eight
public frontend assets matched expected hashes on four requests each. Call
status and contacts rejected unauthenticated requests with HTTP 401. The browser
lifecycle test passed again using downloaded served assets (mocked call APIs;
no live call), including minimized Dock, float placement and outcome restore.

Rollback: the main implementation's predecessor on all four roles was
`7515ac2bc321ae3e103ea538fe9f9cdeec400cbe`. Each follow-up's role manifest records
its immediate predecessor. Before rollback, check for later deployments, restore
the intended immutable release symlink and restart only that development service
and PHP-FPM as appropriate. Verify release identity and enforced outbound safety.
Development onboarding records can remain stored: the original provider-owned
transport remains intact and real SMS registration records were not replaced.

Evidence: ignored `output/phone-tray-20260930/`,
`output/phone-tray-followup-20260930/`, and `output/phone-tray-final-20260930/`.
