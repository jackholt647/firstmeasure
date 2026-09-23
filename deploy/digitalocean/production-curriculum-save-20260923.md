# Production curriculum save repair — September 23, 2026

The production compatibility service runs release `3d424a69a869c2ba0b2b8897481af1b0e63c4b68` as `firstmeasure`. Its effective `MEASURE_INTERNAL_TUTORIALS_ROOT` is `/var/lib/firstmeasure-legacy-production/current/tutorials`.

The default curriculum was read through the retained `public-storage/measure/internal/tutorials/master/curriculum.json` fallback because `tutorials/master/curriculum.json` did not exist. `save_curriculum` writes to `tutorials/master/curriculum.json`, but the `tutorials/master` directory had no write permission for `firstmeasure`. The editor's `saveCurriculum` handler suppressed request failures and displayed “Curriculum Saved” unconditionally.

Applied `setfacl -m u:firstmeasure:rwx` only to `/var/lib/firstmeasure-legacy-production/current/tutorials/master` on the production compatibility host. The service account then created, read and removed a temporary probe file in that directory. The retained curriculum remained intact, no primary curriculum file was created by the probe, the parent course root was writable, and `firstmeasure-legacy` remained active. No service restart, curriculum data edit, code release or topology change was required.

Verification covers the storage operation under the actual service account. An authenticated browser save and refresh was not run because that would modify a live curriculum. The UI's false success behavior remains in the deployed release and should be corrected in a later code release.
