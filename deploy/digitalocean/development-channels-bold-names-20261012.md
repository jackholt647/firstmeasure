# Channels profile names — October 12, 2026

Source and development release: `174eae1b041beec229cddeaeb28a0e960d4c8add`, pushed on `codex/consolidated-firstmeasure-20260923`.

Message-author names already requested font weight 850, but the later profile-summary trigger rule used `font:inherit` and reset it to regular weight. The author selector now includes both classes so its bold weight survives that reset. The same renderer covers DMs, group DMs, public channels and thread replies. Channels bundle versions are updated to refresh cached assets.

Validation: the new browser regression verifies actual computed author weight 850 and regular message-body weight in a DM, five-person group DM and 60-person public channel, including each thread reply. The existing profile-summary hover and Message-action regression passes. Both tests pass locally and against public development assets after activation. JavaScript syntax and diff checks pass. The older Channels contract suite passes 11/19 with the same eight failures using both the original selector and the changed selector; failures are unrelated inherited expectations and its missing document shim.

Only the author selector and Channels bundle references were patched onto each audited current development frontend baseline. All three live Channels sources matched the reviewed baseline. Existing manifest differences and unrelated source were preserved. Staging used immutable hardlink copies with atomic replacement of owned files, source hashes and syntax checks. Activation required exact previous-release identity and a development release lock, restarted each role sequentially and verified release identity, readiness and enforced development isolation, with rollback on failure.

Verified current paths:

- Web and pool: `/opt/firstmeasure/releases/174eae1b041beec229cddeaeb28a0e960d4c8add-channels-bold`
- Compatibility: `/mnt/firstmeasure_dev_releases/releases/174eae1b041beec229cddeaeb28a0e960d4c8add-channels-bold`

Previous paths:

- Web and pool: `/opt/firstmeasure/releases/c2eb5c33c42082fdc00ad6903667694161427f2d-channels-polish`
- Compatibility: `/mnt/firstmeasure_dev_releases/releases/c2eb5c33c42082fdc00ad6903667694161427f2d-channels-polish`

All three role asset hashes and the public Channels source matched SHA-256 `45acc438526671f8957e18d980f0dfc1bd7c028e91fdeb5b955ea4bfd16cd9a1`. Public hosted browser checks passed again after all three activations. Worker, backend, data and production were unchanged.

Rollback: inspect the current role identity for intervening releases. If unchanged, atomically restore its previous symlink, restart the development web or legacy service and PHP-FPM, and verify readiness and isolation. After intervening releases, revert only this selector and refresh the Channels bundle version on the latest baseline. Scripts, audited baselines and verification receipts are retained in the project workspace's ignored `output/channels-bold-20261012/`.
