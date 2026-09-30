# Channel dates and posting locks — September 29, 2026

Source/runtime release: `dddf305003fbdb170570f1f11e1d3a2615c1d36c`.

Channel messages now show prominent date labels centered between horizontal
rules at each local-calendar day boundary. Today/Yesterday include the date.
Thread replies also show a separator when their day changes. Existing message
ordering, day grouping and scroll behavior are preserved.

Individual channel settings have an autosaving Lock channel checkbox. The
existing channel owner/admin roles are managers; ordinary members cannot post
or reply in a locked channel. The server applies this restriction to messages,
forwards/GIFs/attachments through posting, edits, restores, scheduled-message
creation and scheduled delivery. Reactions remain available. A schedule created
before locking fails visibly at delivery instead of bypassing the lock.
Deleting one's own message and reading history remain available.

Channel responses expose can_post. The main and thread composers show a
read-only explanation for members, and permission changes refresh those
controls through channel updates. Managers retain the composer. Unlocking
restores member posting. No new organization role grants or migrations.

Validation: TypeScript and JavaScript checks passed. API tests verify member
posting/reply/GIF/edit/schedule denial, manager-only setting changes, reaction
add/remove, pre-lock scheduled delivery failure, manager promotion and unlock.
Real Chrome verifies one date label per day, lock autosave, a member's read-only
notice and successful thumbs-up reaction, manager composer and unlock. Rendered
date separators and the locked view were inspected. Evidence is in ignored
`output/channels-days-lock-20260929/`.

The development overlay contains two frontend assets and two backend modules
plus their compiled output on serving roles, and four backend files on worker.
Concurrent workspace and role-specific source are preserved. Production is
unchanged. All four roles' rollback predecessor is
`51fbfac96f02b3903cd08d1741510d44ed211148`. Check for newer releases before
restoring the immutable predecessor pointer and restarting the role's service
(and PHP-FPM on serving roles); verify development isolation, readiness and
public assets afterward.

Final verification: all four roles activated with matching file hashes,
readiness and development isolation. Both public frontend asset hashes and
six public readiness responses matched the release. The Chrome date/lock suite
passed again with dev-served scripts, including an actual member reaction.
