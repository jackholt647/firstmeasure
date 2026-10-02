# Development project headers and contact shortcuts — October 2, 2026

Initial source: `0cdcdedb22d404f4895135738af3ba6c0a44efde`; final source: `c70a1d4b9dffa0f913934c9d26d06046d23c0621`. Development-only frontend delta; production and worker are unchanged.

The loading window previously rendered a raw saved title/address while the child rendered its configured title, contact identity and pills. Both now use the request module's title/identity/pill builders. The project read, branch title configuration and board metadata begin alongside window startup; the authoritative header receives a paint opportunity before form hydration and active-tab mounting. Header pills, including configured custom fields, use the same renderer in both shells. This does not eliminate genuine network latency or changes between stale cached records and fresh server data.

Title options are All Contacts (new default when unconfigured), Primary Contact (`customer_name`, preserving explicit existing choices), Address, and Manual. Shared surnames are grouped in the display title without changing stored contact names. The header title and supporting address use matching styling during loading. Title rules are reflected in Photos and Scheduling too.

Pill icons inherit pill colors; the identity chevron sits next to its text. Details and stage selectors have no modal-style header or close button. The details dropdown temporarily holds existing editable contact, address and custom-field controls, restores them on dismissal, and separates contacts with rules instead of cards. Call prepares the parent phone in its right-side tray when enabled, otherwise uses a `tel:` URL; it never dials automatically. Message/email open the project Comms composer with the selected recipient; they never send automatically.

## Validation

- 13 focused browser/behavior checks passed: opening chrome, pre-content header paint, restoration, dropdown preservation and dismissal, recipient routing, call preparation/fallback and four distinct title modes.
- The changed Scheduling title contract passes. Its broader suite has 14 existing failures also reproduced against the pre-change Scheduling sources.
- All 11 runtime files passed JavaScript syntax checks on every staged role; title/contact behavior tests passed against each exact role payload.
- Final live readiness, public asset verification and browser smoke results are recorded after activation below.

## Baselines and rollback

| Role | Previous release |
| --- | --- |
| web | `47a309bef4b3626e58dac73732883ab13ce17530` |
| legacy | `1ae9b783ad8a08af8a645580108e93765c64114c` |
| pool | `47a309bef4b3626e58dac73732883ab13ce17530` |

Each role clones its own immutable current release, then applies only this task's reviewed source delta. Existing role-specific code and backend implementations are preserved. Web/pool preserve backend digest `37a2b964289df2d585fa391224299bf987aba61830b860a2a8f29c6aabac6b1d`; compatibility preserves `1db63aa7d38e5f15607f2bb8ffd491282995f1ce2c513060e038480f7b31a549`. The compatibility manifest retains its previous Money bundle version while updating the edited Photos/Comms bundles.

Rollback must restore the applicable previous release symlink, restart that role's development service, reload PHP-FPM and verify local/public development readiness. Re-audit later concurrent releases before rollback; do not overwrite newer work.

The live smoke caught inherited column direction on contact fields. The final revision uses full-width stacked name/phone/email rows, places shortcuts beside their input, and aligns the existing contact controls beside the section label. A browser alignment assertion covers this inheritance. The early project read retains queued local edits instead of replacing their cached record. Asset versions were advanced for both the window host and request app.

The final overlay is three frontend files on top of the initial rollout; it preserves concurrent roof-viewer release `68427767fcdd194317dc027a1375cb726f5669c9` on all three roles. A baseline guard caught its in-progress rollout; the final payload was rebuilt after all roles reached that baseline.

## Final verification

All three serving development roles activated `c70a1d4b9dffa0f913934c9d26d06046d23c0621` and passed local readiness, development isolation and exact payload hash checks. Public readiness converged on the release, and all 11 initial/final runtime asset hashes passed through `dev.1m8.ai`.

The live browser showed the initial title, app tabs, window controls and Notes/Activity/Agent row while the child was still opening. The final dropdown has no header/X or contact-card border, uses full-width fields with adjacent call/message/email icons, and dismisses with Escape. The unsaved verification project was closed without editing or saving it. No calls or messages were sent. The test account has no saved projects, so multi-contact naming and pre-content authoritative header behavior were verified with the focused tests rather than production-like saved records in that account.
