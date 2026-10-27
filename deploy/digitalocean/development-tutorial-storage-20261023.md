# Tutorial project storage takeover on dev - October 23, 2026

Branch `claude/gracious-goldberg-157f74`, commit `865ee7bf8330b512d2ece97d5eb282327229137a`, built on production `6e8093f7`. Rolled out to the dev worker, compatibility and web roles with `output/tutorial-storage-20261023/` (three-way merged onto release `97553a98`; the retired pool role was skipped). `rollout.py verify` passed.

## Production symptom
`POST /v1/internal/tutorial-projects/tutorial_c6d771f66032248562f721aa/artifacts` returned 500 for one student 15 times from 04:32 UTC (releases 242fba6c, 51e9d84f and 6e8093f7). The journal shows `EACCES` from the artifact `writeFile`.

## Cause
PHP-FPM (`www-data`) still creates some tutorial projects (the next practice project, test attempts, draft/reject rounds). The tutorials ACL grants `www-data` rwx and inherits it, but the service account `firstmeasure` only matches the owning-group entry `group::r-x` of a `www-data:www-data` folder, so it can read but never write PHP-created projects. Production has about 1,650 such entries.

## Change
`internal/tutorial_project_storage.ts` takes such a project over before the artifact upload, editor save and score-repair writes: it copies the folder into a service-owned sibling (which inherits the `www-data` ACL), renames the original to `.php-owned-<id>-<timestamp>` and renames the copy into place. Remaining permission failures return `tutorial_storage_not_writable` with a readable message.

## Verification
On the dev compatibility host, a scratch folder with production's ACL: `www-data` created a project, `firstmeasure` was denied a write, the deployed module took the project over, `firstmeasure` wrote an artifact, and `www-data` could still write the project afterwards. Scratch folder removed. Unit test: `public/v1/tests/tutorial-project-storage.test.ts`.

## Production follow-up
Not released to production. An ACL alternative needing Jack's approval: `setfacl -R -m u:firstmeasure:rwx,d:u:firstmeasure:rwx` on the production `tutorials/users` tree (same class as the September 23 `tutorials/master` repair).
