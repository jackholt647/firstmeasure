# Refresh channel recaps after source changes — September 29, 2026

Source/runtime release: `51fbfac96f02b3903cd08d1741510d44ed211148`.

Previously, the recap action generated a summary only for an empty private
assistant conversation. Subsequent clicks reopened that conversation without
requesting a current summary. The conversation endpoint now returns a SHA-256
fingerprint of its current authorized source context. Each automatic recap
persists a server-computed fingerprint with its hidden request. The shared
assistant UI reuses a recap only when a successful reply follows a recap request
with the matching source fingerprint. Failed, legacy and stale recaps regenerate.

Refresh retains private conversation history, unsent text and attachments. The
automatic prompt remains hidden. The current snapshot explicitly supersedes
older summaries. Existing channel authorization and private-thread ownership
checks remain in force; client-supplied revisions do not establish freshness.
No schema change is needed: metadata uses the existing message data field.

The fingerprint follows the existing bounded context: up to 100 recent top-level
messages and 30 replies in each of 10 recent threads. It includes source text,
edit timestamps, reply counts, attachment metadata and the channel message
sequence. This does not expand the recap to unlimited history or read attachment
contents. The assistant can use authorized tools for further research.

Validation: TypeScript check passed. Targeted API tests verify stable revisions,
new messages, new replies, edited/deleted replies, stored recap provenance,
fresh follow-up context and cross-member access denial. Real-Chrome tests verify
regeneration after changes, no duplicate summary for unchanged source, retry
after failure, preserved draft/history, hidden prompts and the shared docked UI.
Evidence: ignored `output/channels-recap-refresh-20260929/`.

Development overlay: two frontend assets plus two backend modules and their
compiled output on serving roles; four backend files on the worker. Concurrent
and role-specific source is retained. Production is unchanged.

Several guarded staging/activation attempts stopped as concurrent call,
notification and Contacts rollouts advanced the baseline. Final predecessor
releases are web `c5d51c9298f4aedde93d489de74acf0b3a843ff9-contact-editor-1`,
worker `fd4e70334953b66ea1362925b10f516b552b51c8`, compatibility
`c5d51c9298f4aedde93d489de74acf0b3a843ff9-contact-editor-4`, and pool
`7ee54c8b9a34670fb64507513884f7299efd0a88`. For rollback, first check for later
releases, restore each role's own predecessor pointer, restart its development
service (and PHP-FPM on serving roles), and verify isolation/readiness and assets.

Final verification: all four roles activated with file hashes, readiness and
development isolation checked. Two public frontend hashes and six public
readiness responses matched this release. The Chrome recap regression passed
again using dev-served scripts, including changed/unchanged source, failure
retry, hidden automatic prompts and preserved unsent draft/history.
