# My Contacts window — October 9, 2026

The My Contacts window changes are active at `https://dev.1m8.ai`. Production was not changed. The feature commit is `62ae7d72308f13d8c1df0c87d021edc5c9ebc37c`; the relationship guard and cache-token follow-up is `deef9df7eff6ad23fd1dd62a4cbb6b1519ea4099`. Both were pushed to `codex/consolidated-firstmeasure-20260923`.

The contact modal now uses the shared project window header and tabs, separate first and last names, collapsed Add employer and Add spouse flows with search or new-contact creation, and Call, Text, and Email actions. A new related contact cannot be created until the main contact has a name. Organization contact preferences can enable or disable per-contact time zones. Customer, Vendor, and Referral Partner are starter tags; organizations can add and remove tags. The prior Primary Phone and Secondary Phone behavior remains in place.

## Verification

- Local TypeScript check and build passed for the feature release.
- Contact browser fixture passed locally and again using JavaScript fetched from the public dev site. The follow-up fixture also verifies that an unnamed main contact cannot create an orphan related contact.
- Contact import and publication custom-field tests passed (14 cases); publication suite passed (65 cases, one existing skip); window shell, manager, and project tray browser tests passed (11 cases).
- Publicly served `contacts/modal.js` has SHA-256 `768dac26ea113abad651940c935b732ec42d9df198b6a61aa9feb81c8d0a996b`. The public app manifest references `20261009-contact-window-v2` and `20261009-contact-settings-v1`.
- Each active web role passed local readiness with its release ID, `data_environment=development`, and enforced outbound isolation. Repeated public readiness requests also passed. A brief 502 occurred during a concurrent web restart and cleared after that role became ready.

## Deployment topology

The initial contact release was staged as an overlay on verified development role baselines and activated sequentially. Another development deployment then advanced the main and pool web roles to `a780223ba3955d224bc78111aef666e49bd5c657`, carrying the current contact files but retaining older contact bundle references in its app manifest. The manifest was corrected as a second immutable overlay, preserving that release's other changes.

The contact overlay was activated as `/opt/firstmeasure/releases/deef9df7eff6ad23fd1dd62a4cbb6b1519ea4099-a780223` on the main and pool roles and `/opt/firstmeasure/releases-root-archive-group-mms-final/deef9df7eff6ad23fd1dd62a4cbb6b1519ea4099` on compatibility. A later, separate development rollout advanced all three web roles to `b5dff594442d6695458813120e0bd8b9bda72d42`. That release retained the contact modal hash and current app manifest references on every role. All three returned ready with development isolation; the public browser fixture passed against that release. This contact deployment did not change the background worker, which does not serve the contact UI or contact API.

## Rollback

The earlier contact overlay directories contain `.contact-followup-manifest.json` with their preceding paths and file checksums. The main and pool overlay's preceding `a780223...` release has older contact bundle references. Those manifests apply only if a role still points at that exact contact overlay; they are not rollback instructions for the later `b5dff594...` release. For any rollback, first verify the role's current symlink and use the current release's own deployment record. Restart that role's development service and `php8.3-fpm`, then confirm local and public readiness plus development isolation. Preserve all release directories.
