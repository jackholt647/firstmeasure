# Channels Enter-to-send — October 11, 2026

Feature commit `fbdeeb63f9cdfd35db43199d280df32b32918e49` changes the main Channels composer (including DMs, group DMs and project channels) and thread replies. Enter sends; Shift+Enter inserts a line. A small “Shift+Enter for a new line” hint appears below each composer. Existing modified-Enter preferences cannot override the shortcut. Settings now shows the fixed shortcut instead of offering an incompatible preference.

The send handler runs before rich-text list and quote handlers. Mention autocomplete and IME composition retain Enter; held Enter does not repeatedly submit. Existing empty-message, upload and in-flight-send guards remain in place.

Validation: the focused browser test covers multiline channel messages, lists, quotes, IME composition, held Enter, mention selection, thread replies and DMs, including an old modified-Enter preference. The existing mentions browser regression also passes. JavaScript syntax and diff checks pass.

Development release: three frontend roles receive only the Channels UI, Channels Settings and a surgical Channels bundle-version update on each current role baseline. Backend, worker and data are unchanged. Local staging/activation helpers and baseline copies are in `output/channels-enter-20261011/`. Staging verifies the owned baseline, retains previous immutable releases and checks syntax. Activation checks exact release identity, readiness and development isolation and restores the prior release on failure.

Owned source SHA-256 (LF-normalized):
- Channels UI: `7725655bfb0c6fbdc6c40894e8e6bbdeafbaf8dd5aec384f252fe9a7c2998ce6`
- Channels Settings: `031011f5a3252536e00f4c9b00f38f2471c7168abfd875a396c87b42c72bf682`

Previous releases:
- Web: `/opt/firstmeasure/releases-phone-second-pass/8495c45c0cd7ceb7cc5b04cd0ea9262807f3a229-activity-v2-r2`
- Pool: `/opt/firstmeasure/releases-phone-second-pass/0200f8b0-sms-copy`
- Compatibility: `/mnt/firstmeasure_dev_releases/releases-phone-second-pass/0200f8b0-sms-copy`

Rollback: verify no intervening release, restore each previous `current` symlink atomically, restart only its development web/legacy service and PHP-FPM, and recheck readiness and the asset. Production activation requires separate user authorization.
