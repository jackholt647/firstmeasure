# E-signature review — September 26, 2026

> Historical, pre-remediation assessment. The subsequently authorized local implementation and its validation are documented in [document signing architecture](architecture/document-signing.md). The findings below describe the original behavior, not the current implementation. No production activation or blanket legal certification is implied.

**Decision: not ready for general-purpose U.S. contract signing.** The widget can capture an electronic mark, but the surrounding system has reproducible integrity, attribution, concurrency, and final-record defects. This does not establish that every existing agreement is invalid. It does mean the product cannot reliably demonstrate who accepted which terms and preserve that acceptance under the tested conditions.

## Scope and confidence

Reviewed the canonical physical checkout at `C:/Users/jackh/Code/2026/FirstMeasure`, HEAD `49c7b486d9d7a47c9cb136b14747c761bfbacf49`, including its existing uncommitted changes. Scope includes the injectable `doc.signature` widget, workflow adapter, customer portal, document APIs and services, output gating, snapshot storage, PDF generation, upload/import path, and adjacent legacy proposal signatures. Read the publication, permissions, and data/action continuity architecture records.

This is a source and local integration review, not a production penetration test, deployed-release verification, backup-restoration audit, 50-state legal opinion, or browser visual/accessibility audit. No production records or application implementation were changed. Only this report and an isolated reproduction script were added. Legal analysis is a product-readiness assessment; counsel should approve supported document categories and state-specific formalities before a broad enforceability claim.

## What U.S. law supports

An ordinary electronic signature can be enforceable. E-SIGN prevents rejection solely because a signature or agreement is electronic; ordinary contractual requirements still apply. Its definition focuses on an intentional act associated with the record. A typed name or drawing can qualify; handwriting realism is not the decisive safeguard. [15 USC 7001(a)–(b)](https://www.law.cornell.edu/uscode/text/15/7001), [15 USC 7006(5)](https://www.law.cornell.edu/uscode/text/15/7006).

Attribution matters: Illinois's UETA, as one state example rather than a nationwide substitute, asks whether the electronic signature was the person's act and permits security procedures and surrounding circumstances as proof. [815 ILCS 333/9](https://www.ilga.gov/documents/legislation/ilcs/documents/081503330K9.htm). The product should retain evidence of identity, intent, representative capacity, and the exact record presented.

Where legally required consumer writings are supplied electronically, an appropriate electronic-record consent process needs disclosures about paper copies, withdrawal, scope, contact updates, and access requirements, plus the applicable access demonstration. This is conditional on the transaction; it is not a universal checkbox rule for every contract. [NCUA E-SIGN guide](https://ncua.gov/regulation-supervision/manuals-guides/federal-consumer-financial-protection-guide/compliance-management/deposit-regulations/electronic-signatures-global-and-national-commerce-act-e-sign-act).

Retention must preserve an accurate, accessible, reproducible record where applicable. Notarization still requires the authorized official and applicable formalities. Failure of the particular access-confirmation requirement does not, by itself, invalidate every consumer contract. [15 USC 7001(c)(3), (d), (e), (g)](https://www.law.cornell.edu/uscode/text/15/7001).

“Any U.S. contract” cannot be an unconditional product promise. E-SIGN has exclusions for specified estate/family-law records, much of the UCC, court records, certain consumer notices, and hazardous-material documents. An exclusion does not necessarily prohibit electronic execution under other law, but it requires separate analysis. Witnessed/notarized documents and regulated transactions need appropriate specialized workflows. [15 USC 7003](https://www.law.cornell.edu/uscode/text/15/7003).

## Findings

Severity P1 means release-blocking for the requested general-purpose use. “Reproduced” means an isolated local integration test confirmed the behavior. “Source” means the control flow was inspected but the scenario was not independently exercised end-to-end.

### 1. P1 — signatures remain replaceable after completion (reproduced)

`recordDocumentOutput` rejects void/declined/expired records, but accepts writes on signed/completed ones. It replaces `outputs[key]` and the corresponding snapshot value. There is no write-once guard, signature receipt precondition, or append-only supersession record. Reposting another name replaced the signer; posting an empty object then removed the name while status stayed `completed`, because status only advances.

The event records the output key/type and snapshot ID, not the replaced signature payload. An event saying a write occurred cannot reconstruct the erased acceptance.

Evidence: [output entry point](../public/v1/documents/service.ts#L2234), [replacement and lifecycle](../public/v1/documents/service.ts#L2381), [event storage](../public/v1/documents/storage.ts#L750).

Required fix: immutable individual signature receipts, idempotent retries, explicit amendment/void/supersession workflows, and transactional state transitions. Freeze contract-affecting selections as well as text. The option/selection branches in this same endpoint can still change scope parameters after signing; the ordinary PATCH lock does not protect this path.

### 2. P1 — acceptance is not restricted to the exact current document revision (reproduced)

Sending creates another token/snapshot without retiring earlier signing links. A public write resolves the token's snapshot but validates and completes the current document instance. In the test, the original link showed “Original terms”; after editing and resending, that link successfully marked the instance with “Changed terms” completed. The newer snapshot remained unsigned.

There is also no partial-signature lock: editing parameters after signer one, before signer two, succeeds. This was reproduced with two required customer fields.

Evidence: [snapshot creation](../public/v1/documents/service.ts#L1728), [public write](../public/v1/documents/api.ts#L965), [PATCH lock](../public/v1/documents/service.ts#L783).

Required fix: issue an immutable signing envelope containing the exact rendered content, relevant data, attachments, terms, and signer plan. Bind every signature to its envelope revision/content digest. Reject superseded signing requests while retaining historical read access. Changing substantive terms requires a new envelope and renewed signatures.

### 3. P1 — fields do not represent independently authorized signers (reproduced)

All recipients receive the same snapshot portal link. The server has no per-recipient binding on public output submission. The same unauthenticated bearer successfully completed two required customer slots using the same name. A bearer can also supply different names; names are assertions, not verified identities.

The normal public/internal distinction is useful, but only checks `def.signer === "internal"`. The requirements projection separately understands `party: "company"`; such a definition was writable publicly in the test. This is a schema/authorization mismatch.

Evidence: [shared recipient URL](../public/v1/documents/service.ts#L1832), [party enforcement](../public/v1/documents/service.ts#L2254), [requirement party](../public/v1/documents/presentation.ts#L99), [widget configuration](../public/libraries/doc-widgets/firstmate-doc-widgets.js#L1694).

Required fix: explicit signer IDs and roles, authorized fields, individual invitations/sessions, configurable authentication assurance, representative capacity, and distinct-person rules where required. Use one normalized party schema everywhere. Email/SMS challenges can strengthen evidence; neither is a universal statutory requirement or absolute identity proof.

### 4. P1 — simultaneous signers lose accepted signatures (reproduced)

Both requests read the same document, merge one output, and replace the whole record without an expected revision. Two simultaneous writes returned successfully, but the final instance contained only `sig_second` and remained `sent`. Snapshot writes have the same overwrite pattern. Instance, snapshot, audit event, and workflow emission are also separate operations.

Evidence: [read/modify/write](../public/v1/documents/service.ts#L2381), [instance storage](../public/v1/documents/storage.ts#L669), [snapshot storage](../public/v1/documents/storage.ts#L704).

Required fix: atomic signature insertion with unique envelope/signer/field constraints, transactional completion, concurrency control, and a durable event outbox. Retry tests must prove one accepted signature and one business transition per intended act.

### 5. P1 — signing validation and evidence trust are inadequate (reproduced)

A drawn signature with `image_data: "not-an-image"`, no name, and `signed_at: "1900-01-01"` completed a contract. Validation accepts arbitrary signature type/data and trusts a client timestamp; the satisfaction predicate accepts any nonempty name OR image string. Client-supplied witness IDs also survive as evidence.

An empty signature is not sufficient to complete a previously unsigned contract, which is a positive existing check. However, empty submissions are persisted and can confuse pending/signature UI, and do not undo a previously completed status.

Evidence: [request schema](../public/v1/documents/schemas.ts#L329), [normalization](../public/v1/documents/service.ts#L2076), [satisfaction predicate](../public/libraries/doc-model/firstmate-doc-model.js#L1853).

Required fix: a strict typed/drawn/imported contract, bounded and validated image data, server acceptance time, explicit intent/consent receipt where applicable, and server-derived witness/actor identity. Separate historical wet-ink signing dates from capture time. Request headers and browser location are contextual claims; verify trusted-proxy handling before treating forwarded IP/geolocation as authoritative. IP alone is not identity.

### 6. P1 — feature configuration can bypass signing requirements (reproduced)

Turning `documents.esign` off marks signature definitions disabled; the completion evaluator removes them. Submitting an unrelated value output then completed a contract with no customer signature. A public caller could also set `evidence.capture_mode: "imported"` to bypass the disabled e-sign capability and record a signature.

Evidence: [import bypass](../public/v1/documents/service.ts#L2260), [effective completion definitions](../public/v1/documents/service.ts#L2383), [capability annotation](../public/v1/documents/capability_policy.ts#L159).

Required fix: unavailable required capabilities must block acceptance, not waive contractual obligations. Imported wet signatures must be an authenticated, permissioned operation linked to retained source media, with provenance set by the server.

### 7. P1 — downloaded PDF can remain unsigned; fallback omits contract elements (reproduced/source)

Fetching the PDF before signing stores it. After signing, the public PDF route returns that same stored media. The before/after responses were byte-identical in the reproduction. Signing updates snapshot outputs but does not invalidate/finalize its PDF.

Separately, the renderer catches failures and emits a text-only fallback built from text nodes. It does not faithfully reproduce signature widgets, pricing widgets, or image content, yet is delivered as a successful PDF. A final signed record cannot silently substitute that degraded artifact.

Evidence: [PDF retrieval](../public/v1/documents/service.ts#L2058), [fallback extraction](../public/v1/documents/service.ts#L1899), [render fallback](../public/v1/documents/service.ts#L1920).

Required fix: reliably generate and retain a final executed artifact, bind it to signature receipts, preserve originals, and block finalization if faithful rendering fails. Deliver or make the final copy durably available to each entitled party. Do not reuse a pre-sign PDF as the executed copy.

### 8. P1 — general-purpose consent and evidence package are incomplete (source)

The reusable modal provides a full-name field, type/draw controls, and “Adopt & sign,” which is useful evidence of intent. It does not supply a versioned electronic-record disclosure/consent process, paper-copy/withdrawal procedure, or an applicable access demonstration. No reusable consent record is required by the signing API. Template authors could insert text, but that is not a reliable platform-wide compliance control.

Snapshots freeze a substantial amount of document context and there are timestamped audit events. However, signed snapshots/outputs remain mutable, and this path lacks a sealed evidence export binding signer identity, consent version, signature, exact accepted content, and final artifact. No signature-specific retention/legal-hold/offboarding-access control was established by this review. Infrastructure backups and retention policies remain unverified.

Evidence: [modal](../public/libraries/doc-widgets/firstmate-doc-widgets.js#L1535), [snapshot data](../public/v1/documents/service.ts#L1750), [audit records](../public/v1/documents/storage.ts#L750).

A cryptographic seal, content digest, trusted timestamp, or completion certificate is an engineering recommendation for stronger evidence, not a claim that every U.S. agreement legally requires that exact technology. A certificate cannot repair incorrect underlying attribution or content.

### 9. P1 — internal signing permission is too broad for authorized representation (source)

The internal output route requires app access, CSRF, and `view_projects`. It can record either customer's or company's signature with an arbitrary supplied name. No explicit signing authority, individual signer assignment, or customer-present attestation is enforced there. Being entitled to view a project does not establish authority to execute its agreements.

Evidence: [internal output endpoint](../public/v1/documents/api.ts#L817).

Required fix: dedicated execute/import/witness permissions, resource checks, signer-role assignments, recorded representative capacity, and separate assisted-signing controls. Preserve the existing production permission flags; add appropriate platform permissions rather than repurposing them.

### 10. P2 — public evidence exposure and optimistic UI undermine reliability (reproduced/source)

Public snapshot serialization returns full `outputs`, including nested signature evidence. The test confirmed a witness claim is visible there; the same projection can expose collected IP, device, and location details to everyone holding the shared link. The adjacent portal signature helper already has a safer public-summary convention.

The widget updates local output state before the asynchronous submission finishes and does not await success. The portal also updates its caches optimistically; its error handler shows an error but does not roll those values back. A failed save can therefore leave a displayed signature or satisfied local workflow step. This UI failure was source-reviewed, not browser-reproduced.

Evidence: [public projection](../public/v1/documents/service.ts#L2601), [widget submit](../public/libraries/doc-widgets/firstmate-doc-widgets.js#L1719), [portal save/error path](../public/customer_portal/customer_portal.js#L471).

Required fix: a minimal authorized public projection; pending/success/failure signing states; rollback on failure; and workflow progression based on server receipts.

### 11. P1 — adjacent legacy proposal paths must not bypass the repaired engine (source)

There is a separate proposal implementation; the shared shape is not a shared enforcement service. Its completion route accepts an open object schema, can synthesize a default customer slot, and finalizes without a mandatory nonempty signer check in the inspected path. Slot writes accept caller-selected slot IDs and replace prior entries. The legacy `/sign` endpoint passes no request audit into finalization.

That path does attempt to generate a signed PDF, unlike the document output path, but swallows rendering/storage failure. It must be retired or reconciled with the same signing invariants. These legacy findings were source-reviewed; the new reproduction script exercises the injectable document engine only.

Evidence: [legacy endpoints](../public/v1/proposals/api.ts#L239), [legacy finalizer](../public/v1/proposals/storage.ts#L1876), [legacy sign wrapper](../public/v1/proposals/storage.ts#L2026). Portal punch/completion helpers also normalize signatures separately; do not infer universal guarantees from the common artifact shape.

## Multi-signer readiness

| Capability | Current finding |
| --- | --- |
| Several signature fields with different output keys | Supported structurally |
| Require more than one field | Supported via `required: true` |
| Company versus customer | Partial; normal `signer: internal` blocked publicly, alias mismatch exists |
| Require company countersignature by default | No; standard contract defines company signature as optional |
| Named recipients restricted to assigned fields | Missing in public submission path |
| Separate authenticated identities | Missing in public submission path |
| Ordered or parallel signing with durable per-person progress | No signing-envelope model; concurrency loses data |
| Same immutable terms for every signer | Not enforced |
| Witness/notary or representative-authority workflow | Not established |
| Final executed copy/evidence for every party | Not reliable |

Evidence for default contract requirements: [type registry](../public/v1/documents/types/registry.ts#L121). Do not make every company signature universally mandatory: the necessary parties must be explicitly configured according to the particular agreement. Multiple fields for one person and multiple people are different requirements.

Recommended contract: envelope revision + frozen signer plan; each signer has a stable ID, legal name, delivery destination, role/capacity, authentication policy, assigned fields, required/optional status, and routing stage. Multiple fields may belong to one signer. Completion requires all required signers and fields on that same revision. Payments and downstream workflow gates remain separate from legal execution status.

## Verification and release criteria

Existing suites: `documents-api`, `documents-versions`, `paper-upload`, and `workflow-sections`: **35 passed, 0 failed**. The combined run emitted background FirstMeasure SQLite worker errors (`no such table: firstmeasure_jobs`) but exited successfully; that noise does not establish production worker health.

Added [isolated audit reproduction](../public/v1/tests/esign-audit-reproduction.audit.ts): **1 scenario test passed**, confirming all documented reproduced defects. A passing audit reproduction means the defects exist, not that the product is correct. It deliberately uses `.audit.ts` so it is not included by the ordinary `*.test.ts` glob. The extra signer definitions are installed through the local storage fixture; public signing requests use the actual HTTP endpoint. The concurrent-write case invokes the shared service directly. Temporary stores and disabled email prevent customer mutations or messages.

Run from `public/v1`:

```powershell
node --experimental-sqlite --import tsx --test --test-force-exit tests/esign-audit-reproduction.audit.ts
```

Before general-purpose release:

1. Correct immutable-envelope binding, write-once signatures, stale-link handling, partial-signature content locking, and atomic concurrency.
2. Add signer assignments, proper signing/import permissions, strict payload/evidence validation, and authoritative completion gates unaffected by feature flags.
3. Implement reusable intent/consumer-consent policies, durable evidence export, faithful executed PDFs, and per-party access/delivery.
4. Reconcile all legacy signing endpoints; add negative API and browser tests, including retries, network failures, revocation, malformed evidence, and failed rendering.
5. Verify deployed release identity, PostgreSQL concurrency/transactions, trusted proxy headers, storage access controls, backup restoration, retention, account closure, and legal holds.
6. Have U.S. counsel define supported/excluded document categories, state-dependent requirements, disclosures, retention schedules, and witnessed/notarized handling. A generic widget cannot validate the substantive legality of arbitrary contract text.

The existing widget and document engine provide a useful starting point. The signature transaction and evidence layer need substantial hardening before the requested general-purpose claim is justified.
