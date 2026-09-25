# Console language tester

On a portal page that loads `PlatformLanguage`, open Chrome DevTools → Console:

```js
PlatformLanguage.tester.open()
```

A small **Language preview** panel appears at the top left. Click **Reload & start** once to enable capture from page startup (finish any unsaved work before this initial reload). Then choose a language from the dropdown. Subsequent changes swap captured labels in place, without reloading or remounting the page. The panel follows navigation in the same tab on the same origin.

Only installed interface packs appear, automatically using the shared language registry. Newly registered packs appear after the updated bundle is deployed and the page is refreshed. Broader inline message-translation languages do not appear until they have an installed interface pack. Missing translations retain the existing English fallback.

**Account language** previews the normal current interface locale. The × button closes the panel, restores it and clears the tab's preview setting. No personal/company preference write is made. Units, billing, actual engine context and snapshot locale remain unchanged. The overlay is hidden by default and has no customer-facing menu entry.

Console shortcuts after the initial capture reload:

```js
await PlatformLanguage.tester.setLocale('en-GB')
await PlatformLanguage.tester.setLocale(null) // Account language
PlatformLanguage.tester.status()             // Preview locale and live-binding count
PlatformLanguage.tester.close()
```

## What updates live

- Source-owned `PlatformLanguage.text`, app-scoped `language.text`, and `FMText` labels rendered into DOM text.
- Titles, placeholders, accessibility labels, alt text and standard tooltip attributes.
- Newly rendered labels, including SPA navigation and lazy-loaded controls.
- Document `lang` and text direction for the preview, including RTL packs.
- Same-origin child frames that load this runtime and started with the preview session enabled. They follow the parent through tab-storage events and do not show duplicate panels. Cross-origin frames and frames with a different/no language runtime are independent.

Bindings retain the exact catalog key and interpolation values rather than matching English text on the page. Customer text that happens to equal a catalog label stays untouched. Swaps retain element identity, form values, focus and event handlers. An application or user edit to a bound node releases that binding instead of overwriting the edit. Add `data-fm-language-preview="off"` to a subtree that must remain fixed.

## Implementation and limits

This is a developer visual-QA mode. When explicitly enabled at startup, translated string calls carry temporary provenance delimiters. A DOM observer consumes them and records bindings; ordinary pages never emit them or install the observer. Input value assignments strip the delimiters, and editable regions are excluded from live swaps. There is no heuristic replacement of customer text. The preview uses a separate catalog engine so it cannot set the locale used by normal snapshots.

Static uncatalogued text, canvas text, strings split across complex HTML fragments, generated PDFs and independent legacy renderers are not automatically live-bound. The panel reports complex/skipped captures. Use normal locale rendering to test those surfaces. QA mode previews existing packs; it does not translate missing strings or download fonts. Continue report/font/layout testing separately.

Do visual checking in this mode; close it before testing record creation, exports or other data-writing workflows, which should be checked in the ordinary account locale. Provenance capture intentionally instruments UI string calls and is not a production rendering mode.

Tests: `node --test tests/language-tester-browser.test.mjs tests/localization-browser.test.mjs` from `public/v1`. The browser fixture exercises live switching, placeholders, ICU values, English fallback, RTL, unchanged customer/form data and snapshot settings, event-handler preservation, tab navigation, same-origin frames and close/reset behavior.
