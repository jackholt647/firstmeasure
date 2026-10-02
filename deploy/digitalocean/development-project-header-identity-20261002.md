# Project header identity and restore motion — October 2, 2026

Source release `4ae69418523989bc8f25c1d2fcb9ef184a85575c` changes four frontend files on development web, compatibility and pool roles. No worker, production, data model or permission changes are included.

Projects opt into transform-based window transitions: geometry is set once, then a 320 ms transform animates from the previous visible bounds. This avoids relaying every animation-frame resize into the project iframe. Reduced-motion preference skips motion. Other window types retain their existing motion implementation.

Project titles no longer open window placement menus. Right-click Dock retains its placement choices. The header identity has a bold primary title followed by distinct contact and address values in normal weight. A dedicated identity button opens existing contact/address controls in an anchored dropdown; dismissal restores the original nodes to Overview. Edit event delegation covers the dropdown and the form. A manual-title input appears when the project uses manual titles. No duplicated fields or shared content rail is introduced.

Configured tags and property type move beside identity. The existing stage operation is presented in an anchored dropdown, retaining board selection, authorization, error handling and stage effects. Existing tag and contact operations are reused.

Validation: nine opening/header browser tests pass, plus shared shell/tray checks and window-manager regressions. Nine tests against the exact three role payloads pass. Three-way reconciliation preserves role-specific mobile behavior absent from the source baseline. Deployment artifacts, hashes and rollback receipts are in ignored `output/project-header-identity-20261002`.

Activation and final verification completed. Web first received `4ae69418`; concurrent partner release `8f3bc492` retained all four frontend hashes, verified directly. Compatibility and pool run `4ae69418` cloned from `8f3bc492`, preserving its backend digest `1db63aa7d38e5f15607f2bb8ffd491282995f1ce2c513060e038480f7b31a549`. Baseline guards stopped outdated candidates before activation; the refreshed frontend overlays were byte-identical to tested payloads. All role readiness/isolation checks and four public asset hashes passed.

Live browser verification opened the identity dropdown in Overview and after switching to Photos, observed the original contact/address controls in the anchored panel, dismissed it and restored the fields, and exercised minimize/restore. The form was closed without saving. Stage placement and title variants were checked in browser fixtures because this sandbox account has no saved projects. Exact rollback paths are in the installed channels-release receipts; re-audit later releases before rollback.
