# Development Feed list previews and long notes — October 7, 2026

Source commit: `9609d398a459f4debf62afc252ffc6990e8f810e` on `codex/pioneer-puffin-feed-photos`.

The list view now places the note chevron immediately after the note text. The Feed content scrolls in its own panel beneath the header. Grouped media uploads display one row of previews between the activity title and project link: up to six on desktop or four on mobile. Each preview and the **See more** control opens the existing Feed photo viewer, which has next/previous navigation and photo comments.

The newest Pioneer Puffin Test Co org (`org_983c8e17cd313149`) received two paragraph-length project notes. The seed added only those two notes; it added no photos, checklists, sold jobs, appointments, or activity events. Its verification confirmed the existing 20-photo and eight-photo groups, three completed checklists, three sold projects, and four appointments.

At the start of this rollout, all three development frontend roles were serving `d585c2f85e4eb122ea723417a231cc050dc33804`. Their served Feed file matched the prior Feed release. A guarded release overlay changed only `public/libraries/apps/photos/feed.js` and the Feed bundle version in `public/libraries/apps/firstmate-apps-manifest.js`; the compatibility frontend kept its role-specific manifest content. Web, pool, and compatibility roles were staged and activated in sequence to `9609d398a459f4debf62afc252ffc6990e8f810e`. The previous release remains available for rollback.

Validation: the Feed browser test passed on desktop and mobile. All three roles reported ready, development data, and environment safety after activation; the public readiness endpoint reported the new release. Active Feed hashes matched the source on all roles and role-specific manifest hashes matched the staged receipts. In a signed-in sandbox browser, six project note cards appeared; a long note expanded; Chris Bennett's eight-photo row displayed six loaded thumbnails and **See more**; **See more** opened the photo viewer with navigation and a comment box; and no page errors occurred. Production was not changed.
