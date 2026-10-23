# Report order: reliable prices, address suggestions above the field, docked upload bar — development, October 23, 2026

Release `73978cf6278f1fd5cfa58d1e501ddd93a6530307` (parent `390437ef`).

**Full Exterior prices ("Could not load prices").**
- The quote was requested on every address change. A half-typed address answers 400
  (`property_country_unavailable`), as `quote-probe.cjs` showed on dev.
- Pins went through FormData as `"[object Object]"`, so the server never used them and geocoded the address text
  instead.
- Any failure set the shared error. That error showed as a banner on every step, disabled Next, and was never
  retried, so one blip (for example during a host restart) stuck for the whole order.
- Now:
  - prices wait while an address is typed but not placed;
  - pins are sent as JSON;
  - a connection failure or a 5xx response retries twice;
  - what is left shows only under Delivery, with Retry: "We couldn’t load Full Exterior prices. Check your
    connection, then try again." A server refusal keeps its own message.

**Address suggestions (phones, first page).**
- The first version watched only `<body>`'s children. When Google later moved or grew the list (two-line rows, new
  results, a refocus), it went back below the field or over it.
- Each list is now watched itself (style, rows, size), its height is capped to the room above the field, and it is
  placed 6 px above the field.
- Checked on dev with a wrapping address: the list ended 6 px above the field after typing, a second search and a
  refocus.

**Additional photos and videos bar.**
- On the video summary the bar sat mid-screen (it was sticky at the end of short content).
- The capture step's scroller is now a column filling the screen. The bar takes the leftover space, so it sits at
  the bottom above Back/Next. It stays pinned while photos scroll, has no padding below it and a short white fade
  above it, and the scrollbar is hidden so both sides are even.
- Checked on dev: the bar's bottom equals the scroller's bottom (785 of 785).

**Tests.** A new `exteriors-photo-workflow` case covers the pin wait, JSON pins, the retries, a refusal kept off the
page-wide error, and the retry-exhausted message. The guided camera, orbital video, photo workflow and intro layout
suites pass, except two failures that predate this change:
- "Orbital video2 segments";
- pin confirmation, where the test checks synchronously after a pin move reloads the quote.

**Rollout.**
- Hosts: legacy, web and pool.
- Each file was three-way merged onto the host's live copy, with the edit scripts in
  `output/fh-order-fixes-20261023/` replayed on conflict.
- The manifest got only the project-request key `20261023-order-fixes`.

**Rollout note.** The pool node (`10.124.16.3`) has not answered since this rollout began ("No route to host"), so
these changes went to legacy and web only, as other sessions' rollouts did that evening.

## Follow-up: order pills, gutters in What's included — release `a355f79516045ead9544e1162dd360897459d087`

- **Order pills.** The property type and report scope pills opened the browser's own option list, which dropped
  downward past the bottom-anchored order panel. They now open their own list. It flips above the pill when there
  is less room below and stays inside the window. Arrows, Enter, Escape and Tab still work; Escape closes only the
  list, not the order. Checked on dev at 390×844: both lists opened above the pill (top 600 and 640, ending 6 px
  above it), and choosing Commercial changed the property type.
- **Gutters.** The separate "Gutters are included" line above the delivery prices is gone. The Full Exterior
  What's included pop-up (opened from the scope card and from Delivery) now lists "Gutters are always included."
  as its own bullet.
- **Rollout.** Legacy and web, project-request key `20261023-order-pills`. The pool was still unreachable. Dev
  answered 503 for about a minute while web restarted, and verify passed on a re-run after a legacy SSH timeout.
  Scripts: `output/fh-order-pills-20261023/`.
