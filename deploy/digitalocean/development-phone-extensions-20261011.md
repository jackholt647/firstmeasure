# Phone settings extensions — October 11, 2026

Development activation remains blocked. No current symlink, service, or production
configuration was changed by this task.

Source: feature `fc3e01cd`, termination/reporting follow-up `5ead8527`, pushed to
`codex/consolidated-firstmeasure-20260923` and `codex/phone-settings-20261010`.
This includes the previously prepared unified Phone Settings, Call Lists labels,
routing, voicemail inbox, messaging policies, 10DLC, number purchase/porting,
billing links, and static tracking-number attribution. The additions are outgoing
voicemail drop, personal power-dial number balancing, and real Telnyx reputation
monitoring controls. See [phone architecture](../../docs/architecture/phone-settings.md)
for behavior, provider prerequisites and environment setup.

Validation: 111 backend tests passed across phone settings, customer calls,
messaging API and Telnyx webhook state; eight browser tests passed across phone
settings, the phone tray and call assistance/power dialing. TypeScript passes.
The final termination adjustment passed the complete 16-test phone-settings
suite. Carrier calls and reputation mutations were mocked. Live audio, paid
reputation enrollment and a real number transfer were not exercised. The separate
pre-existing email notification regression remains documented in the October 10
phone settings record.

Current role baselines were captured again and integrated without discarding live
conference participant calling, group MMS, SMS registration mode, Feed settings,
or updated bundle versions. The baseline guard caught a concurrent manifest
update and refused staging; recapture proved the other task files unchanged.
The integration patches in `phone-settings-20261011/` show the complete feature
against those captured role baselines. New phone modules are in the source commit.
Local archives, source hashes and scripts are in ignored
`output/phone-settings-20261011/`.

Final candidate source: `5ead8527daf911a91a3aefb5f5129404e6acb602`.

| Role | Baseline |
| --- | --- |
| web | `/opt/firstmeasure/releases/7cd0e1268caee2b35f6b70698d9fbfe76950cee2` |
| pool | `/opt/firstmeasure/releases/7cd0e1268caee2b35f6b70698d9fbfe76950cee2` |
| compatibility | `/mnt/firstmeasure_dev_releases/releases/07b7a6c748a678941cc1b7e8bfdf9e4f0e3216fc` |
| worker | `/opt/firstmeasure/releases/38cf7fe47f1fbea31f7a0bfd06185219d1a10942` |

The worker's approved SSH alias connects as `ben`. Noninteractive sudo remains
unavailable; the configured deployment key is rejected for root. Its validation
candidate is under `/home/ben/phone-settings-candidate/`; a privileged deployer
must place it in the service's normal release store. Home is not an activation
path. Web/pool/compatibility candidates use `/opt/firstmeasure/releases-phone-settings/`.
Candidate directory suffixes are `<source commit>-<role>`.

Activation requires approved worker deployment access. Recheck current baselines
before proceeding, restage any changed files, stamp release identity in a detached
`release.env`, and deploy the coordinated web/worker release with the existing
rollback procedure. New voicemail jobs must not reach an old worker. Verify role
readiness, source/runtime hashes and the development destination restrictions.
Do not activate only the UI while the worker remains unable to consume these jobs.
The captured paths are historical evidence, not permission to replace newer work.


A second concurrent compatibility bundle change was preserved using the separate
`compat-manifest-integration.patch`. Other captured task files were unchanged.
Public development readiness returned HTTP 200 while this release remained
inactive. The explicit worker service sudo check also still requires a password;
no restart was attempted against an incomplete coordinated release.


All four final candidates passed Linux TypeScript checks, changed-module
compilation in the package's native module format, JavaScript syntax checks,
source SHA-256 verification, and compiled Phone Settings API import. Web, pool
and compatibility each contain 27 overlaid source files; the worker contains 20
backend source files. The candidate release identity still requires stamping at
activation as described above. This record does not claim the staged release is
serving development traffic.
