# Mobile report address separator — October 5, 2026

Runtime source: `0bd7bad0707b17b8a3a355c412c9ca9d900e7a6a`.

The mobile report location step hides contact fields but inherited the address section's contact/address separator. One scoped CSS rule removes that top border and its 14px padding only in this step. The shell header border and normal contact/address separation are preserved.

Validation: JavaScript syntax passed. A Chrome computed-style check using the candidate stylesheet confirmed zero border/padding in mobile report location and the existing 1px border/14px padding in the normal form. No new behavior test was added for this CSS-only change.

Development deployment was authorized in the ongoing conversation. All three development roles passed final running-release, asset-hash, readiness and isolation verification. The public asset hash and public release also match. During rolling activation, public requests repeatedly reached an older peer; final verification waited for all role restarts to complete. One frontend file is overlaid on each existing immutable development release, preserving unrelated live and workspace changes. Production and worker are unchanged.

Evidence: `output/mobile-address-divider-20261005/`. Prior release on web, compatibility and pool roles: `a9673d074ec3c17957b0f7303d0a30809e05ae0a`. Rollback uses each manifest's previous release path and development service.
