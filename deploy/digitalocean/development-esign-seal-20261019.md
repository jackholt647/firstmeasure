# Development rollout: sealed, timestamped executed agreements and the signing ledger (October 19, 2026)

Release `36b12df9a45eae4670893e45263390f45fe361b5` on `codex/consolidated-firstmeasure-20260923`, activated on all
four development roles (worker, legacy, web, pool) and verified. Production is unchanged.

## What shipped

Design: [document signing](../../docs/architecture/document-signing.md), "Seal, timestamp and signing ledger".

- Executed agreements get a PAdES certification seal (DocMDP no changes) and an RFC 3161 timestamp from DigiCert,
  with SSL.com as the fallback. Executed-copy emails wait for the seal.
- The append-only signing ledger (`document_signing_ledger`) records receipts, executed copies and seals, and is
  anchored about hourly with an outside timestamp.
- The public page `https://dev.1m8.ai/v1/documents/public/seal/verify` checks an executed PDF. The root certificate
  is at `.../seal/root` and the revocation list at `.../seal/crl`.
- Development seals with the "FirstMate Development" authority, created once in the dev signing store on first
  use. PDF readers show it as untrusted, which is expected.
- The signing store moved to schema version 3 (two new tables). It migrated on first use with no manual step.

## Checks

- Local: `npm run check`. Tests passed: `document-seal` (7), `document-signing` (with the new seal and ledger
  assertions), `document-signing-postgres` (embedded PostgreSQL, including concurrent ledger appends and rollback),
  `portal-signing-access`, `document-signing-ui` (3) and `materials-calculus` (10). Run from a clean export of the
  commit, the candidate passed the typecheck and the seal, signing and portal tests. Its `document-signing-ui` fails
  one case because HEAD's copy of that test still expects the old "open the PDF" consent step; another session holds
  the updated test, uncommitted.
- Independent validators: OpenSSL verified the CMS signature, certificate chain and CRL. pyHanko 0.29.1 judged a
  local sample VALID: trusted, entire-file coverage, no modifications, DocMDP no changes, timestamp sound.
- Real authorities: DigiCert and SSL.com both returned tokens that verified against the Mozilla roots.
- Hosted end to end (`output/esign-seal-20261019/dev-e2e.mjs`): in sandbox organization `org_28e881210cebff10`, a
  new quick proposal was signed by the sandbox account (no email). Its package was sealed with a DigiCert timestamp,
  and the ledger read receipt, executed, sealed, plus an anchor that verified. The outbox delivered every event on its
  first attempt. The public verify endpoint returned intact, trusted, on record, ledger ok. pyHanko judged the
  downloaded dev file VALID, with the DigiCert timestamp responder trusted.

## Notes

- The commit carries only this task's hunks of `documents/signing/service.ts`. Another session's uncommitted
  portal-owner check and signature-record character handling stay in the shared working copy and are not deployed.
- The development root key is stored in the dev signing store. That is acceptable only for development. Production
  needs `DOCUMENT_SEAL_KEY_FILE`, `DOCUMENT_SEAL_CHAIN_FILE` and `DOCUMENT_SEAL_CRL_FILE` from
  `scripts/document-seal-authority.ts` (root key kept offline), or a purchased certificate. Without them it refuses to
  seal.
- Rollback: activate the previous releases (worker `4f0e17a0`, others `ff9ad1c9`). The two new tables are additive.
