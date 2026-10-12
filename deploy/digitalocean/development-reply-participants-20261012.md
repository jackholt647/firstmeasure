# Channels and Feed reply participants — October 12, 2026

Feature commit `b9359396`; cache versions `152862f7`.
Development source/runtime: `152862f7ee8b4411f8d5cba112143dc0972e4751`.

Channels replaces the reply icon with up to four distinct recent participants,
reply count, and the last active visible reply's date and time. Feed Posts shows
the same participant photos beside its comment count, without a timestamp.
Existing avatar fallbacks remain. Thread refresh and realtime changes update the
channel root summary; Feed polling includes participant changes.

Hydration reads only identity and visibility fields for active replies in a
page of roots, applies existing audience/resource authorization before counting
or selecting people, and orders by reply date with sequence as a tie breaker.
Archived or inaccessible replies cannot contribute photos, counts or timestamps.
Historical photo authors and verified external contributors retain their existing
identity rendering. No schema migration or discussion-data rewrite is required.

## Validation

Local TypeScript and JavaScript syntax checks pass. The complete channel API
suite, three Feed API tests, and two focused desktop/mobile browser tests passed.
The old channel UI contract suite has the same eight failures on the unchanged
baseline. The broader existing Feed browser test stops on an unrelated 15-versus-14
layout fixture assertion; the focused comment-summary browser regression passes.

Each role-specific Linux candidate compiled TypeScript and passed the new
reply-summary API regression using disposable SQLite organizations. Both browser
regressions passed again with JavaScript served from development and fixture APIs;
no customer replies or comments were posted.

## Development rollout

Every candidate clones its own live role baseline and applies only the reviewed
four source changes plus the owned Channels/Feed bundle cache-version changes.
Only the two changed backend modules are copied from the isolated Linux build.
Unrelated deployed code, manifest versions, environment configuration and data
are retained. Source and compiled hashes are recorded in
`reply-participants-release.json`; local evidence is under ignored
`output/reply-participants-deploy`.

Activation guards the previous symlink and runtime identity, switches the
immutable release atomically, restarts the development web or legacy service,
and reloads PHP-FPM. Readiness requires the expected release id, development data
environment, and enforced outbound safety. Failure restores the previous release
while the candidate remains current. Worker, production and topology are unchanged.

- web: `/opt/firstmeasure/releases/152862f7ee8b4411f8d5cba112143dc0972e4751-reply-participants`; previous `/opt/firstmeasure/releases/34fded39f41091fe326e6c72c7519ae253549ff0`.
- pool: `/opt/firstmeasure/releases/152862f7ee8b4411f8d5cba112143dc0972e4751-reply-participants`; previous `/opt/firstmeasure/releases/34fded39f41091fe326e6c72c7519ae253549ff0`.
- compat: `/mnt/firstmeasure_dev_releases/releases/152862f7ee8b4411f8d5cba112143dc0972e4751-reply-participants`; previous `/mnt/firstmeasure_dev_releases/releases/34fded39f41091fe326e6c72c7519ae253549ff0`.

All three roles activated successfully and passed exact runtime identity, source
and compiled hashes, readiness and development isolation. Public readiness and
the Channels, Feed and application manifest hashes matched the reviewed payload.
Rollback targets are the previous paths recorded above; preserve any intervening
changes when reversing this patch.
