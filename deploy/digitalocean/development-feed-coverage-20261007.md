# Development Feed coverage, October 7, 2026

The newest `Pioneer Puffin Test Co 6277ef` full sandbox organization is `org_983c8e17cd313149` on `dev.1m8.ai`.

The Feed bundle from `cb106be0e79839e0e27547047f63d64f9f808cce` was installed as a guarded overlay on the web, pool, and compatibility development frontend roles. All three passed `/v1/health/ready` with that release ID. The overlay changed only `public/libraries/apps/photos/feed.js` and the Feed cache version in each role's current manifest; unrelated role-specific code remained on its existing release.

The Feed now names scheduled sales appointments and their titles, hides old synthetic signature rows that lack a document, clips note previews to one rendered line at the available width, excludes uploaded documents from the photo gallery, and shows document type and title in list rows. The old activity seed no longer emits invented note or signature events.

The `seed-pioneer-puffin-feed-coverage.mjs` script created five real project document uploads (receipt, invoice document, roof report, contract, other document), one draft invoice, and one supplemental material expense. Each is a project record; the invoice was not sent and the expense did not make a payment. The four existing scheduled events are real sales appointments, scheduled for October 9–12. Their Feed activity was recorded October 7.

Verification: `node --test public/v1/tests/feed-browser.test.mjs` passed. A signed-in browser on the served dev Feed found the five document rows, invoice, expense, four appointments, the grouped photo upload and notes. No orphan signature, generic “scheduled an event,” or document-as-photo row appeared. The long-note preview measured one line at 1440px and 390px viewport widths. The unrelated SMS setup request returned HTTP 500 in the same page session; the Feed had no JavaScript errors.

The activity registry includes many other event types. Do not add bare work-event rows to represent calls, customer messages, payments, views, or signatures. Those examples need their underlying domain records and safe development workflows before they can truthfully appear in the Feed.
