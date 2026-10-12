# SMS consent and number selection — October 11, 2026

Development-only update. Combines message types with consent in a six-step
workflow, adds multiple opt-in methods and reviewer-linked PDF/PNG/JPEG evidence,
normalizes links, provides adaptable examples and policy guidance, and removes
redundant attestations and save hints. New drafts default to all three message
types; saved selections are preserved. Marketing retains its provider mapping.

Number cards show locality/state when supplied and omit pricing/capabilities.
Selection is a preview until the user confirms reservation. Replacement requires
explicit confirmation, retains the previous purchased number, and reconciles
ambiguous provider responses without duplicate purchases.

Evidence uploads require organization management access and CSRF. Review links
use random 256-bit bearer tokens, with only hashes in metadata, restricted file
signatures, 5 MB maximum, sandbox/nosniff headers, and no search indexing.
Links are included in Telnyx messageFlow; they are intentionally accessible to
anyone with the link. No real provider transactions are performed by tests.

Validation: TypeScript checking; existing 39 API regressions plus focused new
multi-method, evidence authorization/content, and replacement reconciliation
checks; four browser tests covering consent, upload, number previews/reservation,
identity, responsiveness and automatic status updates. Merged live browser tests
also pass. Deployment preserves each host's concurrent source using guarded
three-way overlays; organization-specific live registration routing is retained.

Provider references:
- https://support.telnyx.com/en/articles/10684260-10dlc-opt-in-form
- https://support-v2.telnyx.com/en/articles/10562019-guide-to-10dlc-message-flow-field

Activation verification will be recorded after rollout.
