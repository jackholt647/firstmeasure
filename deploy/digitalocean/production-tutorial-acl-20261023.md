# Tutorial folder permissions on production and dev, October 23, 2026 (06:02 UTC)

Jack approved this one-off permission change in place of a code release.

## Cause

Tutorial artifact uploads failed with HTTP 500 (`EACCES`) for projects PHP-FPM (`www-data`) created. The tutorials ACL gave `www-data` rwx, but the API account `firstmeasure` only matched `group::r-x` on `www-data:www-data` folders. It could read those projects but never write them.

- One student's editor-history upload had failed 15 times since 04:00.
- About 1,650 production entries were affected.

## Change

```bash
setfacl -R -m u:firstmeasure:rwx,d:u:firstmeasure:rwx tutorials/users
```

| Host | Tree | Entries | Took |
| --- | --- | --- | --- |
| Production compatibility (144.126.222.110) | `/var/lib/firstmeasure-legacy-production/releases/final-20260908/tutorials/users` | 49,231 | about 1 s |
| Dev legacy (137.184.229.145) | `/mnt/firstmeasure_development_legacy_data/firstmeasure-legacy-development/releases/initial-20260829-222222/tutorials/users` | | |

The default ACL entry means folders and files PHP creates later inherit the same access.

## Verification

- **Production:** after the change, 0 entries under `tutorials/users` are unwritable by `firstmeasure`, and `www-data` keeps rwx. In every folder of the affected project (`tutorial_c6d771f6…`), `firstmeasure` created and removed a probe file; nothing was left behind and the project files were not touched.
- **Dev:** `www-data` created a folder and a file with umask 022. `firstmeasure` wrote into both (inherited `user:firstmeasure:rwx`, mask `rw-` on the file). The probe was removed afterwards.
- **Student:** has not retried since 05:30. Their next save or upload of the project should succeed without them doing anything.

## Rollback

Each host keeps the previous ACLs in `/root/tutorials-users-acl-before-20261023.txt`. Restore from inside the `tutorials` directory:

```bash
setfacl --restore=/root/tutorials-users-acl-before-20261023.txt
```

## Not released

The code take-over fix (`claude/gracious-goldberg-157f74`, `865ee7bf`) stays unreleased. Its readable `tutorial_storage_not_writable` error could still ship later.
