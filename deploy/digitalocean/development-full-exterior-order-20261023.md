# Report order: Full Exterior naming, no card prices, map first on phones, gutters included — development, October 23, 2026

Release `84b244510fd542d718c742b0d0fcc2e676ebb8f3` (parent `276ade49`).

**Changes (report ordering).**
- The Residential, Commercial and Multifamily cards no longer show a price. The price depends on the scope chosen
  next, Roof Only or Full Exterior.
- "Full Structure" is now "Full Exterior" everywhere in ordering: scope choice, info popout, review heading, order
  button, sample download, audit text and the ordered state. Each reworded string has a new catalog key.
- Phones, first page: the header, then the map, then the address field and its buttons at the bottom, at the same
  sizes. Google's address suggestions open above the field, so the keyboard does not cover them.
- Full Exterior has no gutters toggle (`#rStepReport` is hidden in that flow). Under Delivery it now says "Gutters
  are included with every Full Exterior report."
  - The order payload already sent `include_gutter_measurements: '1'`. The server forces the flag on for
    `exteriors_` projects and refuses to turn it off.
  - Instant development copies of full-house reports now set the flag explicitly too.

**Tests.** `exteriors-guided-camera` (review heading assertion updated), `development-reports` and the full-house
viewer tests all pass. Three failures predate this change and are unrelated to it:
- "Orbital video2 segments" in `exteriors-orbital-video`;
- two cases in `mobile-order-sequence`, whose code slice misses `orderSubmissionPending`, added in `05dc4641`.

**Rollout.** The four files were three-way merged onto each host's live copy. On a conflict, the exact edits are
replayed (`order-edits.py`, and `replay.exteriors`). The manifest swaps only the project-request cache key
(`20261023-full-exterior-order`). Scripts: `output/fh-order-20261023/`.
