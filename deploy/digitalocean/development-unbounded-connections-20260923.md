# Connections outside the base outline — September 23, 2026

Runtime commit: `28ac29fdb45ec96a7b3645e1777d041b9e3a7f62`.
Previous runtime: `03c76e5d5c4cb02f50940503691e7a640c353720`.

Straight sketch connections and their endpoints can extend beyond the existing footprint. The shared sketch resolver retains closed exterior regions and refreshes the outline; rebinding retains deliberate external wires and anchors while continuing to discard obsolete face boundaries. The base editor places exterior endpoints on the selected supporting plane and permits selecting them afterward. Existing wall-bottom following is covered by a regression proving the footprint expands and connected external wires stay attached.

Validation: the expanded 949-test run passed948 tests; its sole failure was the new controls test using the reference-only `canHit` API instead of `canPick`. After correcting that assertion, all14 controls tests passed. New geometry tests cover concave base and local wall sketches, exterior open wires through commit/reload/movement, and base-following wall-bottom displacement. Existing placement-error tests now inject an error rather than treating an outside point as invalid.

The five changed source/test files were baseline-checked and copied into the primary workspace. The two-file runtime delta was staged against matching hashes and over24,000 unchanged files per role, then activated on all three development roles. Each role passed local readiness and development outbound-isolation checks. Public HTTP verification returned503 twice; do not treat public verification as complete.

During activation, the platform consolidation task requested a single coordinated rollout. It was notified of this finished commit, successful role activations, and public503. Further activation and final public verification belong to task `01a0cca7-497b-7313-83e2-72e897117846`, which must include this commit in its combined release. Primary-directory renaming is safe from this task's side. Production and saved user models were not modified.
