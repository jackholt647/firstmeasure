# Development organization divisions and departments — October 7, 2026

Requested target: `https://dev.1m8.ai`. Production activation is not authorized by this change.

Source release: `57ab1bb4ad14c5d45cd9f9bbce7ca68323d9348e`, following implementation commit `9ef89b76734b5d88b072dfaa577042befdd537c9` on `codex/consolidated-firstmeasure-20260923`.
Task baseline: `e9ac08fd027327b73060324b648781efdfba4e21`.

Status: activated on all four development roles. Each activation passed readiness and development outbound/session isolation checks. Public readiness returned the release repeatedly, and the six checked browser assets matched their staged hashes. A final independent per-role hash/readiness verification is recorded alongside the activation logs.

The change adds arbitrary organization division ancestry, configurable departments, flat group membership inheritance, scoped role grants, app defaults/restrictions and domain integrations. Projects remain cross-department. Ordinary single-department users retain the simple UI; controls appear only for multiple relevant options. See [architecture](../../docs/architecture/organization-structure.md) and [coverage](../../docs/architecture/department-coverage.md).

The release uses a reviewed 95-file runtime overlay from the immutable source commit, reconciled against each development role's actual source. Unrelated live code is preserved. Web/pool/compatibility previously ran `26ff3b3d51f5e7004fb1bf3df1c8978111601b01`; the worker previously ran `c2b67c0233bb93dbe5b50d51828e0dc7b6363fbe`. The compatibility release volume has no free inodes, so its new immutable release is staged under the existing `/opt/firstmeasure/releases-root-archive` workflow with changed hardlinks detached before writing. Prior releases remain available for rollback. No topology or provider configuration is changed.

Validation before staging:

- Full TypeScript check on the isolated HEAD plus task-only source.
- Isolated publication suite: 65 passed, one existing PostgreSQL skip.
- Isolated focused department/core suite: 35 passed, two existing skips.
- Latest calls, department communications and call publication tests: 46 passed, including count/pagination isolation, division/department deny precedence and frozen recording permission revocation.
- Work/crew/checklist/notification suite: 34 passed; Work/automation contracts: 28 passed.
- Browser checks cover department settings, custom terminology, documents, workflows, boards, checklists, Feed and call controls at desktop/mobile sizes. Single-option controls remain hidden.
- Existing equipment browser text-matching failures were reproduced against the task baseline; department settings and department-specific backend regressions passed.

Local release evidence is in `output/organization-structure-20261007/`: source patch manifests, live code inventory, per-role reconciliation, compiled payload hashes, Linux staging logs, browser screenshots and public verification. No secrets or customer records are included in this record.

For acceptance testing, use Company Settings → Users → Departments to configure two departments and optional divisions, assign a flat resource group and a department-scoped role, then compare an ordinary member with an administrator. Test Feed, Calls, equipment, boards, document defaults/restrictions and checklist views. No example departments are automatically inserted into customer organizations.
