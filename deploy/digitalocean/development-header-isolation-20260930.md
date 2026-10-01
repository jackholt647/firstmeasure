# Preserve app header icons and spacing — development

Source release: `15d3cbd8fae869c573307b44b680fab770b9ee7a`.
Target: https://dev.1m8.ai; follow-up to the reported header regression.

The shared app chrome stylesheet matched every `[data-app-header]`, including
existing Projects, Contacts, Equipment, Feed and studio headers. Its added
padding/background produced a second header panel within already padded apps.
Its generic icon color overrode Projects' white folder glyph with the same red
used by its icon tile, making the icon appear absent.

Generated shared headers now declare `data-app-header="shared"`; all shared
header selectors require that value. Existing header markers remain available
for DOM discovery but do not opt into the generated header styling. Each
existing application retains its own header spacing, responsive behavior and
icon colors. Grouped Communications/Financials/Payroll headers retain their
shared layout. The loader cache version is bumped.

The new browser regression fails with JavaScript fetched from development before
the fix and passes with the scoped release at 1280px and 600px. It compares the
existing Projects header's padding, minimum height, background, gap, icon color,
icon background, margin and title size before/after loading shared chrome, and
checks that generated shared headers still receive styling. Three existing
app-group/boot checks also pass. Domain APIs are mocked in these browser tests.

Only app-chrome.js and its manifest cache reference are deployed. Concurrent
working-tree styling is excluded from the commit; per-role live source is merged
and preserved. Baseline guards catch concurrent activations before switching a
host. Immutable hardlink staging and atomic overlay writes retain previous
releases without mutating their files. No data, capabilities, provider settings,
worker, production or topology changes.

Release evidence and per-role predecessors: ignored
`output/header-isolation-20260930/` and each deployed `channels-release.json`.
To roll back, verify there has been no subsequent deployment, restore the role's
recorded prior symlink, restart only its development service and PHP-FPM, and
verify development readiness and outbound safety.

Completed: all three serving roles verified release 15d3cbd8, readiness and enforced development outbound safety. Both public assets matched expected hashes on three fetches each. The desktop/mobile regression passed using the downloaded served script. Each role's immediate predecessor was 5d44c75b05495907afe6569beb17b3685a99e3a9. Reload the portal to apply the corrected styles.
