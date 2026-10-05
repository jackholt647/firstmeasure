# Unordered FirstMeasure project overview — October 5, 2026

Runtime commit: `8605432e1cfda86f977a9f240f5271c80de8381b`.

Overview actions now follow the address, property type and any custom property fields in both expanded and FirstMeasure form layouts. Previously the insertion point was the contact section, which preceded the address in the FirstMeasure layout.

For FirstMeasure-only organizations, an unordered project opened in normal project mode shows the address, property type and Order report action. Contact, notes and supplemental details are hidden from that main form. The header dropdown retains contact editing, including an empty editable placeholder without creating a saved contact. Entering the report flow restores its existing steps and contact page; ordered projects retain their normal details.

Verification: all 10 project-overview browser tests passed, including 390px and 1280px layouts, expanded-platform behavior, action placement, dropdown contact preservation, entry into ordering, ordered-project restoration and empty-contact initialization. JavaScript syntax checks passed for the three deployment payloads.

Deployment uses a single-file immutable development overlay for `public/libraries/apps/project-request/app.js`, preserving concurrent source and role-specific differences. No production activation or native app rebuild is involved. Evidence is in `output/unordered-project-overview-20261005/`.

Verified activation on web, compatibility and web-pool roles at the runtime commit above. Exact payload hashes and public readiness passed, with development isolation and outbound safety enforced. The public asset SHA-256 is `80a75e66b5135e98c7e8e1b240a4013c0e0ae62e7bfaf71eb18852bcb11e0737`. A concurrent web release was allowed to finish before inventory was refreshed; no baseline guard was bypassed.
