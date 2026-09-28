# Platform language and measurement architecture

The platform now has one language service, shared by the portal, app host and Node output pipeline. The released interface locales are `en-US` and `en-GB`. Existing accounts retain US English and imperial defaults. New accounts inherit signup country defaults from the organization commercial profile; see [regional billing](architecture/regional-billing.md). This work is local; it does not activate a production rollout.

## Preferences and rollout

The existing default-off `firstmeasure.report_localization` capability is retained for compatibility and displayed as **Platform Language and Units**. It controls the Company **Measurements and language** card and personal interface-language controls. Server writes enforce the same gate. `firstmeasure.metric_measurements` remains a separate default-off metric default. Administrators can enable customization without forcing metric, and metric can be enabled without exposing customization.

Company settings live with the existing branch-scoped company configuration:

```json
{"localization":{"locale":"en-GB","measurement_system":"metric"}}
```

The default branch is the usual company configuration. Other branches keep their existing independent configuration; this change does not silently copy preferences between branches. Legacy `report_preferences` are read as a fallback and the Company form writes both formats for older consumers.

Personal `interface_locale` is nullable: null inherits Company language. Personal message `language` is also nullable: absent/null follows the current Company language, while an explicit choice remains fixed. Existing explicit `en` preferences normalize to `en-US`. `auto_translate_messages` remains independent. Company language determines newly ordered reports and issued documents regardless of the ordering employee's interface override. Disabling customization restores the US interface without deleting saved choices. Currency and time zone never follow implicitly from language. Physical data and monetary amounts remain in their existing storage units/currency.

| Setting | Scope | Available languages |
| --- | --- | --- |
| My Settings: interface language | This user's app interface | Installed language packs, or inherit Company |
| Company: company language and measurements | New company documents, PDFs and FirstMeasure reports | The same installed packs; units are independent |
| My Settings: message translation | Inline channel/project-note translations for this user | Broader translation targets, or inherit Company |

The Company card explains these scopes through its header info tooltip. Inline translation detects the message's source language and translates directly to the resolved target; it does not assume an English source. English (US) and English (UK) are distinct targets and cache keys, with spelling instructions for translated output. Generic detected English is treated as the same language as either English target, so existing English messages are not automatically rewritten just to change spelling.

After saving a different interface language, the settings page reloads to rebuild eagerly registered controls and labels. The current company-settings save completes first. Other open tabs adopt the saved preference on their next load.

## Shared runtime

- `public/v1/platform/localization/core.ts`: pure, instance-scoped catalog resolution, ICU messages, terminology, number/date/currency/list formatting and snapshots. No shared mutable server locale.
- `browser.ts`: builds `PlatformLanguage`, resolves `/v1/platform/me/localization`, sets document language, loads shared catalogs, retries failed loads and exposes `fm:language:updated` / `fm:language:missing` events.
- `server.ts`: request/job-scoped instances and immutable catalog loading. Frozen references fail if their catalog file is missing, rather than silently rendering with a different revision.
- The app runtime exposes `context.language` and loads namespaces for app packages and their bundles before mounting. Disabled apps use the same mechanism when enabled; no per-app language preference exists.

Use `context.language.text(key, fallback, values)` in app code, or `PlatformLanguage.text(namespace, key, fallback, values)` in shared code. Store full sentences, with ICU plural/select messages for grammar. Do not build grammar by concatenating translated words. Catalog misses fall back to the exact US source string. Parameters, customer names, notes, messages, addresses and document content are not translated by a DOM replacement pass.

Use `number`, `date`, `list`, or `money(amount, explicitCurrency)` for formatting. `formatLocale(legacyLocale)` preserves existing US formatting at migrated call sites. Unit conversion remains in `ReportUnits` at display/input boundaries; locale never changes arithmetic or stored geometry.

API error codes remain unchanged. Unambiguous static error messages have a shared catalog. The browser translates an error only when both its code and original message match that catalog, preserving contextual server errors.

## Terminology

Existing `variable_mappings.labels` overrides continue to apply to English. New `localized_labels[locale][namespace][key]` overrides take priority for their locale. The terminology editor saves British overrides independently and preserves US labels. Default labels resolve through the terminology catalog. Scheduling/workforce-specific configuration remains compatible with its existing fields.

## Reports, documents and email

New report manifests freeze `language_snapshot`, including locale, units, terminology, catalog versions and the report spelling dictionary. Existing reports without snapshots use their established US/default path. Roof and exterior PDF rendering use the order's frozen settings.

The canonical Documents pipeline freezes the same context when creating an issued snapshot. Its PDF harness embeds the frozen catalogs before loading document widgets, without making network requests for translations. Proposals, invoices and other apps using `renderTemplatedArtifact` inherit this behavior. Document-delivery email templates use the snapshot context while preserving a user's custom message verbatim. Folder document exports use the current company context because those items are unversioned.

Other system-generated email templates and independent legacy PDF generators can use `serverLanguage` / `snapshotLanguage`; they still need to opt in at their source template. This is not an automatic translation of authored templates or every legacy output. Additional languages also need translated catalogs, locale-aware templates, appropriate fonts, input conventions and layout testing before enabling their registry entry.

## Adding a language pack

For parallel translation-only agents, use the [shared context and translation packet workflow](translation-agent-workflow.md). It separates one-time context research from per-language translation, validates imports, and supports partial pack registration with English fallback for development testing. Visual/font/template review can follow development publication; it is not a task for translation workers.

`public/v1/platform/localization/languages.json` is the shared registry. Its `packs` list drives both interface and Company dropdowns, supported locale validation and the generated manifest. Its separate `translation_targets` list drives inline translation choices. Only US and UK English packs are currently installed; French is already available as an inline translation target.

1. Translate the namespaces in `catalog-source.json` into a reviewed locale entry in `catalog-overrides.json`, for example `"fr-FR": { "shared": { ... }, "settings": { ... } }`. Preserve message keys and ICU placeholders/plural syntax. Translate terminology and report labels as well as interface messages. Missing translations fall back to US source text, so a partial entry is not a complete pack.
2. Track document/report templates, spelling dictionaries, fonts, date/number input, text expansion and layouts for testing after development publication. Non-English report templates need their own review; registering a locale does not translate authored content or unmigrated legacy outputs. For a right-to-left language, also verify component and PDF layouts.
3. Add the reviewed pack to `languages.json`, for example `{ "code": "fr-FR", "label": "Français", "direction": "ltr" }`. Both installed-language selectors and server validation then use it. Review signup region routing and its fallback with the new locale. Add a separate `translation_targets` entry only when the message target is not already present.
4. Run the build and checks below, plus `tests/language-integration.test.ts` and `tests/language-settings-browser.test.mjs`. Verify personal overrides, company inheritance, new report/document snapshots and actual translated output. Keep older content-hashed catalogs so issued documents retain their frozen language.

The builder accepts registered locales with reviewed overrides and rejects unknown message keys. It does not assess translation quality or guarantee complete coverage. The September 25 language-settings work passes its behavior tests and TypeScript check, but the broader catalog audit still reports recognized hardcoded UI strings (278 candidates at that point); resolve and review that coverage before claiming a complete additional language. These settings changes do not themselves deploy a new pack.

## Catalog maintenance and checks

`catalog-source.json` holds US messages. `catalog-overrides.json` contains reviewed locale-specific overrides; its British entries take precedence over the initial English spelling map. The build emits content-hashed catalog files plus a manifest under `public/libraries/platform-language/catalogs`. Keep old hashed files that issued snapshots reference. Do not edit generated bundles directly.

The current inventory scans 151 portal/library files and contains 8,560 messages across 87 namespaces, including shared errors and terminology. The source migration intentionally recognizes conservative UI patterns; this count is not a claim that every arbitrary English expression in the repository is internationalized. Complex conditionals, special renderers and new app surfaces need explicit message keys during review. CSS, identifiers, paths and customer data are excluded. US baselines are kept verbatim.

From `public/v1`:

```sh
npm run localization:build
npm run localization:check
npm run test:localization
npm run check
```

The check detects newly recognized hardcoded UI strings and stale generated catalogs/runtime. For a deliberate source migration, run `node scripts/localization-catalogs.mjs --write`, review the diff, then build and test. This migration is not a replacement for translation review. `localization-formatters.mjs` migrates eligible legacy date/number formatters while retaining their US behavior.

Validation also includes `node --test dev/report-localization.test.cjs`, `node dev/report-localization.browser.cjs`, and the Documents API suite with `FIRSTMEASURE_JOB_WORKERS=0`. Local PDF fixtures verify default US and explicit US output are byte-identical.

The integration checkout already has four failing settings/terminology source-contract checks (Money settings structure, terminology-agent flag registry, checklist terminology entry and an outdated tab-count assertion). They reproduce against the saved pre-migration sources. New localization tests are separate from those baseline failures.
