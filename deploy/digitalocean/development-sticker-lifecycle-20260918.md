# Development sticker geometry ownership repair — September 18, 2026

Runtime `f605ec2e2185bf07172ee35825aa8d96ec07cf70`; baseline `565faf923e73c909e438a3e3b2348c646f91f228`.

Mounted sticker edits now carry interior/collinear sketch anchors omitted from the resolved polygon through the same affine edit as the sticker. Delete removes sticker-owned sketch boundaries and unused corners, restores the host wall opening, and removes solid stickers from the wire geometry rather than leaving a deleted face outline. Deliberate attached cuts and fixed building boundaries remain. Group deletion is one undoable transaction.

881 regression tests pass, including extra-anchor movement/cancel, trimmed sticker deletion/undo, solid wire removal, and the saved two-window wall with attached vertical cuts. The saved fixture contains only the affected wall geometry. Root files were synchronized after baseline comparison.

Deploy only the committed wall_face_draft.js delta to development worker, web and legacy, preserving and hashing all other public files. Verify development isolation, readiness and public script bytes. Production is unchanged.
