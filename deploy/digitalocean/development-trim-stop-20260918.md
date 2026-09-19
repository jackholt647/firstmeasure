# Development trim contact repair — September 18, 2026

Runtime `f4af452c4556d5b0fa288fe5fc0688047a9c85a3`; baseline `6500d2fb9d1cddf30a7173c046d14e1adde7b487`.

New trim treats existing coplanar wall trim and grouped window/door trim as occupied geometry. Opening trim is generated from sticker metadata for this calculation. Contact intervals block the whole width of the new strip, avoiding a narrow remainder beside the existing trim. Existing trim faces remain unchanged, and miter patches also exclude them. Trim on a different wall plane is not an obstacle.

893 regression tests pass. Added coverage checks all three side variants for windows and doors, complete wall area preservation, existing saved trim identity, and separate wall planes. The local root was synchronized after exact baseline comparison.

Deploy the committed wall_trim.js delta only to development worker, web and legacy; verify unchanged runtime hashes, readiness, development isolation and public served bytes. Production is unchanged. Refresh before creating trim again; already-created trim is not rewritten.
