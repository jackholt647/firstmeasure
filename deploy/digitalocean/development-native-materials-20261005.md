# Original material grid restoration

The user rejected the separate Document materials panel. Runtime
`585ea6f8e90a1b4fee883b6bd0154430fde183a2` removes its mount and restores the
original material-section renderer as the sole Scope material view. It retains
color-coded rows and lists, inline fields, item variants, the price-book picker,
list visibility controls and the original order composer. The redundant Materials
widget selector is removed; Lists remains. The responsive sidebar fix is retained.

This is a frontend restoration. It neither deletes nor rewrites document material
ledger data. The removed panel was the ledger's project viewer; generated ledger
sets are not yet adapted into the original material-list API/renderer. That
integration remains a separate implementation gap and must reuse the native
renderer rather than adding another material UI.

Seven Scope tests passed. Hosted tests using local candidate assets verified two
list colors, saved inline quantity edits, adding and saving a price-book item,
roof-widget switching and absence of the replacement panel and duplicate widget
on desktop and phone. Artifacts are in `output/scope-native-20261005`.

Deployment is limited to the project UI and its manifest bundle version on the
development serving roles. Immutable overlays preserve each audited live
baseline. No backend, worker, database or production changes. Rollback uses each
role's previous path in the manifest, development service restart and PHP-FPM
reload.

## Final activation

Final runtime: `f590528965536bf351231c866dca59ce83a867cf`. It also refreshes the
native toolbar after save-state changes so Order cannot remain disabled after
a completed inline/price-book save. A concurrent release
`119be99265394a06e7013cb6bbf0d64a69f6f719` changed the baseline during activation;
the release guard stopped, fresh baselines were captured, and its changes were
preserved in the final overlays.

All three development serving roles passed final source-hash and readiness
verification. Live desktop and phone checks passed without local asset overrides:
inline edits and price-book additions persisted, list visibility filtered the
native grid, the original order dialog opened, and no replacement panel or
duplicate Materials selector appeared. No browser errors.
