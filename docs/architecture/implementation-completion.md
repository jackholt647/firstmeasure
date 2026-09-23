# Publication architecture completion

## Accepted requirements (September 23, 2026)

The user authorized completing the architecture and deploying it to dev.1m8.ai.
Production is outside this authorization. The physical canonical checkout remains
FirstMeasure on codex/consolidated-firstmeasure-20260923; the folder rename is deferred.
Preserve concurrent editor changes and do not contact or interrupt other tasks.

The three layers are published domain data, customizable consumer code, and
published domain actions. Shared consumer-owned live/frozen bindings apply across
them. Documents and document workflows are independent instances of one module
contract. Scopes orchestrate modules and actions and may run custom code.
Generic project datasets support specialized measurement/inventory schemas.
Publication must cover existing relevant apps/services, retain domain permissions
and invariants, and be discoverable with typed contracts. Future contributors must
extend the same architecture.

Latest explicit clarifications:

- Integrate authoring and use into the existing document/workflow and scope builders.
- Executable historical frozen functions are not required. Retain accepted results
  and provenance; never silently substitute a changed implementation or replay effects.
- The moving-company workflow was a thought experiment, not a product deliverable.
- Live draft dependencies should recalculate; effects remain explicit commands or
  configured triggers. Frozen accepted artifacts remain unchanged.
- Make routine implementation decisions autonomously; the user is unavailable overnight.

## Completion evidence to establish

1. Review the inherited implementation, repair contract/authorization/lifecycle defects.
2. Inventory actual domain operations and data exports; expand incomplete adapters
   and schemas, explicitly classify operations that retain specialized entry points.
3. Integrate data/action discovery, binding selection, code and exports with existing
   document and workflow builders, and scope automation authoring/execution.
4. Implement dependency-aware live draft evaluation with cycle/error handling and
   immutable frozen artifacts; verify instance linkage and authorized output writes.
5. Complete supported measurement publication from current report types without
   changing the independent measure/internal editor or mutating historical reports.
6. Verify representative cross-app behavior, denial paths, effect idempotency,
   SQL concurrency, authoring UX and existing affected domain regressions.
7. Update architecture/contributor documentation and CI against the actual contracts.
8. Commit only owned changes, push the canonical branch, stage immutable verified
   source over the latest verified development baseline, activate all development
   roles and verify authenticated workflows, runtime identity and public assets.

## Starting checkpoint

Inherited architecture commit: 4a3c46c (not deployed at task start).
Canonical HEAD at implementation start: 27209ad.
Latest documented development runtime: ccc45af (editor-only deployment).
Reverify these identities before packaging; commit ancestry does not establish
deployed architecture content. No uncommitted changes at initial inspection.

This checklist is a work record, not a declaration of completion. Each item needs
source and behavior evidence before the final report.


## Implemented and verified locally

- Native document/workflow and scope builders share capability discovery and
  program authoring. Published visual layouts retain an immutable program version.
- Independent project instances support typed inputs, instance bindings, pinned
  or live code, dependency-aware refresh, explicit commands and frozen artifacts.
- Module lifecycle actions allow scopes to create, refresh, freeze, compose and
  materialize modules without a privileged HTTP proxy.
- Source permission revocation follows retained transitive data/read-action
  evidence. Scope authority is stamped server-side, matched against the immutable
  definition, and refreshed from current author membership and permissions.
- Uncertain module commands retain evidence, block repeats and expose an
  administrator review flow. Stats reads no longer synchronize domain data.
- Measurement publication uses roof XML, saved exterior quantities and instant
  roof-area estimates, preserving explicit units and original provenance.
- TypeScript check/build; 44 publication tests plus the separate PostgreSQL test;
  71 affected existing-domain regressions; browser authoring/instance/scope checks.
  Further verification is run whenever later changes affect these results.

Publication inventory boundaries remain explicit in the architecture guides:
existing specialized HTTP workflows are supported and are not exposed as generic
collection writes. Foreground live refresh and configured execution boundaries
are implemented; no always-running organization-wide invalidation worker is added.
The moving-company thought experiment is not a deliverable.

## Development release preparation

The latest inspected runtime is `974f20e6639bbe4a4a1011bd69d67cd20edf0ef6` on all
three development roles. Its newer editor changes supersede the starting runtime.
Package the inherited architecture plus this completion from an immutable commit,
overlaying only reviewed owned source on that runtime. Confirm source hashes,
Linux dependency installation/build, development isolation and readiness before
activation. Runtime identity and authenticated smoke results are recorded in the
release record once verified; preparation alone is not deployment completion.
