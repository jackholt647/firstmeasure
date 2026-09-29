# Channels Tab key and nested lists — September 29

Release `3e053cde2b68b83a27b6e46885ef241d27a450ed` is pushed and active on both development web nodes and compatibility. Worker and production are unchanged.

Tab indents list items and Shift+Tab outdents them in the shared Channels editor. Mention completion takes precedence when its suggestion menu is open. Table cell navigation allows normal focus traversal at the boundary instead of swallowing Tab indefinitely. Ordinary text keeps normal keyboard focus navigation. List serialization and rendering preserve nested bullet, numbered and mixed lists through sending, drafts and edits; nested parsing has bounded recursion.

JavaScript syntax and diff checks passed. A real-browser harness passed locally and using dev-served assets for indent/outdent, mixed nesting, three edit round trips, sent-message rendering, Tab mention completion, table navigation/boundaries and normal focus traversal. A screenshot was reviewed. The broader composer-only browser suite passed, including a maintained list indentation regression, quote fidelity, tables, attachments and message actions. These checks use fake APIs and do not send real messages.

The immutable release overlays only the shared Channels UI and bundle manifest. All three updated roles passed source hashes, readiness and development-isolation checks; two public asset hashes and six public readiness responses matched. No backend or database change was needed.

Rollback predecessor for all three updated roles is `72277b85f15f8ce8486029593149e8fda26c7563`. Check for intervening releases and use the existing atomic symlink/service workflow with public readiness verification. Evidence is under ignored `output/channels-tab-20260929/`. The existing autoscale replacement-image limitation remains.
