# Settings search

Settings search uses UI source and rendered HTML, not a parallel handwritten catalogue.

`public/v1/scripts/settings-search-index.mjs` parses JavaScript with TypeScript's syntax tree,
discovers the shell's sections and their mounted settings modules, and extracts static labels,
headings, tooltip descriptions and navigation destinations. It never executes application
code or reads organization data. Unknown expressions remain placeholders and are excluded.
The HTML parser uses inert template fragments. The generated `search-index.js` is loaded
before `search.js`, with content-based asset versions.

Generate after changing settings UI, including new modules:

```
cd public/v1
node scripts/settings-search-index.mjs
node scripts/settings-search-index.mjs --check
node --test tests/settings-search-engine-browser.test.mjs tests/settings-search-contract.test.mjs tests/settings-search-dropdown-browser.test.mjs
```

The dedicated Settings search CI workflow checks freshness and behavior. Commit the generated
artifact with its UI changes. It records source hashes; generation is deterministic across
platforms and normalizes CRLF. Windows uses installed Chrome; Linux uses Playwright Chromium.

At runtime the shell attaches the same available sections used by its navigation. A debounced
observer extracts labels and tooltips from the current rendered page, replacing its live
entries when controls change. It never mounts pages, changes inputs, reads input values,
indexes option data, or persists organization-specific DOM. Reattachment releases the prior
observer. Labels can use native `<label>`, `aria-label`, `aria-labelledby`, `aria-describedby`,
or the existing field-label layouts. `data-settings-search-ignore` excludes a subtree.

Search normalizes Unicode and accents, supports word prefixes and one-edit typos on longer
title words, and ranks exact titles ahead of help-text matches. The top-bar consumes those
ranked results directly. Selection uses Portal navigation and, when a matching control exists,
expands its details group, scrolls, focuses, and briefly highlights it without triggering a
change event. `id`, `name`, and stable `data-*` attributes provide destinations.

Limits are explicit: source extraction cannot statically resolve arbitrary runtime-generated
text. Those controls become searchable when rendered. Entity-specific editors may require
selecting an entity after navigating to their category. A settings label is discovery metadata,
not authorization: the owning UI and API continue enforcing their existing access checks.
For a custom UI that the extractor cannot understand, improve the common extractor or provide
an accessible label and stable destination; do not add a second manual search catalogue.
