# FirstMeasure customer portal mobile acceptance

Date: 2026-09-19. Local fictional preview on ports 8011/3101. No dev or production deployment.

This is a broad mobile browser-emulation pass, not a complete physical-device/provider certification. Primary functional viewport: 390x844. Layout checks: 320x740, 430x932 and 844x390 landscape. All data and payments used isolated preview fixtures; outbound email and production workers were disabled.

## Verified workflows

| Area | Result and scope |
| --- | --- |
| Projects | Ready filter, address sort, list/tile view, address and customer-email search. Restored FirstMeasure search because the platform global search is disabled for these customers. |
| Order map | Empty Next disabled; address selection; residential, commercial, multifamily; type-change confirmation; multiple pins, add/remove, reload retaining type/pins. Removed empty header and footer gap; measured zero map gaps at 320/390/430 widths. |
| Order details | Customer name/phone/email, technician notes, CC and internal notes retained through navigation and reload. Fixed draft saving with Proposals disabled and repeated hydration undoing pin edits. |
| Submission | Residential $9 with gutters, multifamily two-pin $24, commercial two-pin $24. Delivery options/prices displayed and selected. Local order created successfully. |
| Insufficient balance | Commercial order triggered local $35 checkout and resumed submission for the same platform project after simulated payment. |
| Cancellation/reorder | Residential cancel refunded $9 and reorder succeeded. Rejected incorrect-structure fixture correctly reordered as Commercial for $12. Invalid-pin rejection message inspected. |
| Processing | Processing status/estimate and post-order expedited delivery exercised; successful $3.55 local upgrade changed the estimate and showed Expedited. |
| Internal notes | Fixed ordering-step placement, ordered-project drawer placement, and autosave when drawer is outside the form. Ordered-project note visibly survived reload. |
| Delivered report | Measurement summary values and Standard/Customer/XML routes inspected. PDF rendering/download completion is NOT a pass; see limitations. |
| Company | Restricted fields only; name autosave/restoration, primary/secondary palette controls, actual fictional SVG logo upload and reload persistence. |
| Users | Required-email validation, fictional user creation, name edit, Manager preset, suspend/unsuspend. Own permission controls disabled. Invite delivery intentionally disabled. |
| Reports settings | Customer Notes Page toggled off, persisted across reload, restored on. |
| Billing | History/refund, $35 simulated credit ($12 to $47), auto-top-up controls/minimum clamp. Statements corrected for timezone month label and narrow-screen row overflow. |
| Navigation | Settings drawer closes; Company/Users/Reports/Billing only; account menu, logout, and subsequent login passed. |
| Authentication | Existing fictional email/password login; Google button visible; registration layout; email/phone recovery selection and empty-field validation. |
| Responsive settings | All four settings pages had zero document overflow at 320/430 portrait and 844 landscape. Add User dialog keeps header/footer accessible with scrollable body. Statements tested at 320/390/430/844 widths. |

## Fixes and regression evidence

- Map/header/footer sizing; restored inline maps and Next state; edited-pin hydration protection.
- Platform-independent FirstMeasure draft autosave, technician notes/CC persistence, mobile notes placement and save handler.
- Settings navigation; modal stacking; landscape user dialog; statement row sizing and UTC month formatting.
- FirstMeasure search restored; SQLite FTS literal quoting corrected for emails containing punctuation. PostgreSQL search path unchanged.
- Local PHP preview multipart forwarding repaired so actual logo upload can be tested.
- TypeScript build passed. Changed frontend JavaScript syntax checks, PHP lint and git diff whitespace check passed.
- Focused order/billing/reorder tests passed (9 entries before final note-handler addition). Three mobile regression tests now pass: disabled-Proposals autosave, stale-pin hydration, notes outside the form. Historical-search SQLite regression passed including punctuation email search.
- This does not supersede previously documented pre-existing failures in the broader platform suites.

## Still not certified

- Actual iOS Safari / Android Chrome, touch keyboard interaction, physical safe areas and native downloads. Viewport emulation cannot establish these.
- Embedded PDF stayed blank in the in-app browser; download-event wait timed out. PDF/customer PDF/XML/CSV download completion needs a normal-browser/physical-phone pass.
- Real Google OAuth, SMS/email OTP, account registration/password reset, email invitations and resend, real Stripe checkout/card setup/auto-top-up. Local fixtures do not prove provider behavior.
- User avatar upload, destructive user removal, multiple-account switching, and a full member-role permission matrix were not exercised end to end in this mobile pass.
- Expanded-platform features are outside this FirstMeasure-only pass.

Preview remains running. Review account: preview-owner@example.test (local fixture). User-created organizations were not reset. No code was pushed.

## Mobile Users spacing correction (2026-09-19)

Fixed a desktop `flex-basis:220px` becoming vertical space in the mobile permission hint. Mobile row highlighting now belongs to the complete card; removed the cell inset stripe that overlapped the avatar. Avatar, identity and You badge use a grid; long permission labels wrap and read-only controls retain readable contrast. Removed the `display:block!important` rule that defeated the hidden permission row. Toggle label now reflects Show/Hide state.

Browser verification: 320/390 phone widths and 844x390 landscape have zero page horizontal overflow; permission hint is 14px high, separation to permission grid is 14px, avatar cell has no inset stripe, and collapsed permissions have zero visible rows. JavaScript syntax and diff checks passed. Local only.

### Report modal header consolidation (2026-09-19)
- FirstMeasure-only report tabs now occupy the modal header alongside fullscreen and close; removed the empty extra header row and the report body's former tab inset.
- Moved report type and ordered timestamp into Summary, preserving the original timestamp formatting.
- Kept platform app navigation separate when multiple apps are enabled; report tab nodes return to their panel during teardown.
- Browser verified completed Flow Roofing projects at desktop, 390px, 320px, and 844x390 landscape: one report tab strip, no horizontal document overflow, working Summary/Map switching and fullscreen/restore. Closed and opened a second project: one tab strip, correct new summary data.
- JavaScript syntax and diff checks passed. Seven existing mobile draft/promo tests passed. Local only; no deployment.
