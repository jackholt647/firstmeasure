# Mobile Settings spacing - September 25, 2026

Source fix e725c4a, integrated canonical commit/release 9444330e959b1efdceb60d7bc4264ee512a35552.

Billing's viewport-fit overflow on the outer tab clipped the mobile shell's negative margins, exposing the parent's gray padding. At mobile widths the tab now allows the normal bleed and the billing shell accounts for the parent's 24px vertical padding. Billing's extra content-padding override is removed. Company information refresh markup and listener are removed; save/autosave and billing-history reload are retained.

Chrome mobile-layout check at 390x844 verifies identical Company/Billing shell x=0, width=390, heading y=0 and content padding=18px, with no clipping on the tab. JavaScript syntax passes.

Deployment applies only the committed e725c4a patch to the verified live company.js baseline from 692caff88c3d7785c6909d1bf0da8c9feacc2b8c. The canonical file also contains newly committed notification changes not yet activated here, so copying the full canonical blob would incorrectly activate unrelated work. Live Brand Kit changes are preserved. The artifact is the baseline plus the exact reviewed patch, not the full integrated blob.

Baseline normalized SHA256: 09f23c3b3abe67f8a895a2151c534911d969d90144c14c6b6a21d0e1294400a4.
Candidate raw SHA256: 4bceabd1b4e3d4f5d9ceec6f1414684703e43e52b6f3b27317d6fd66a8ce7111.
Only company.js and release.env differ between release directories. Native binaries, backend, production and topology unchanged.

The second web node advanced concurrently to c3f0547ba427f01c576011f63242019c5f944e41 before activation. Its baseline guard correctly stopped the old artifact. The same committed patch was reapplied to its newer company.js, preserving that concurrent change. Second-node candidate SHA256: a162d217aaed927f30132a50e6ab30c5690962dc1ca0988b7268165198804daf. These are targeted per-node deltas, not an assertion that the entire fleet has an identical source baseline.
