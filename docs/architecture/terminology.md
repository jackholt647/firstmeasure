# Terminology and language

Terminology chooses a company's display vocabulary **within a language**. Language packs supply the interface's translated messages and default vocabulary. Routes, database identifiers, roles, permission keys, workflow states and customer-authored content are never renamed.

## Ownership and resolution

- `public/libraries/platform-terminology/platform-terminology.js` owns the catalog (384 keys). Every registered portal/project surface and every explicit terminology reference in the audited source must use a catalog key. Related noun aliases resolve to one concept; a navigation phrase can retain an explicit override.
- `platform/localization/terminology-contract.json` is generated from that catalog. Do not hand-edit it. `terminology.ts` owns shared concepts, namespace aliases and literal composition. Ambiguous terms such as Unit, Item and Status remain scoped to their app.
- New settings live at `variable_mappings.localized_labels[locale][namespace][key]`. A missing override inherits; an empty string explicitly resets to the language default/inherited phrase. The editor never overwrites the other language's dictionary.
- `terminology-settings.ts` provides one read-only projection of current mappings plus the old Work/Workforce labels. Those records remain compatibility inputs, not competing editors. Reads do not seed workforce configuration. Historical `labels` apply only to English locales; locale-specific values take precedence.
- Writes to `variable_mappings` require `manage_company_settings` and CSRF through the branch-module API. The common persistence entry validates strings and bounds. The editor fetches fresh module data before merging its changed keys and reports detected conflicts.

The resolver checks a locale-specific override, an English legacy override where applicable, the installed terminology pack, and finally the supplied source fallback. No language change selects currency, units or time zone.

## App authoring

Use `PlatformTerminology.get('projects.project', 'Project')` for explicit concepts and navigation keys. Escape that plain value when inserting it into HTML.

Use catalogued `PlatformLanguage.text(namespace, key, fallback, values)` for source-owned prose; use `htmlText` for HTML sinks. Composition operates on **message literals before ICU parameters are inserted**, including plural branches. Values supplied from projects, people, messages or documents are not scanned or rewritten. HTML sinks escape custom labels; plain-text sinks return plain strings. Never perform terminology replacement over rendered DOM, customer content, URLs or stable IDs.

Shared nouns compose phrases such as “New Project” and “My Projects”; a phrase's explicit override wins. Singular/plural names are separate entries. The assistant drafts both when requested. Namespace-specific words do not become universal replacements. New language packs must review terminology defaults and message grammar together; the runtime is not a machine translator.

The source migration/compiler assigns HTML-aware message calls and checks unconverted eligible UI strings. Add a semantic namespace alias or shared concept deliberately when an app uses another domain's vocabulary. Adding a catalog entry alone is not a coverage claim.

## Surfaces

The audit scans app/library JavaScript, portal scripts and the standalone customer portal. Language extraction currently covers 162 source files and 92 namespaces. The active Android/iOS FirstMate host uses this portal runtime. The separately maintained FirstMeasure internal measurement/operations editor is outside this platform architecture change, as required by repository instructions; its files are preserved.

The customer portal receives a projection of known public display keys, the company language, and no unrelated settings. Issued documents install frozen terminology alongside frozen catalogs, including English documents with naming overrides. Authored document text stays unchanged.

## Settings and FirstMate

The editor remains under Configuration. Its toolbar has search, language, ordering, expand/collapse, draft discard and save. Sections use right-hand inputs, contextual information and inherited-wording resets. The FirstMate conversation sits on the right; narrow layouts have an explicit switch between the list and conversation. Related phrase inputs preview draft noun changes.

`terminology_assistant` is a focused declaration of the global FirstMate assistant. It shares its model, organization/personal instructions, settings, durable personal threads and chat renderer. It exposes only `draft_terminology` and `report_result`, requires company-settings permission, and has no cross-app tools. Drafts are bounded to known editor keys and require the administrator's normal Save action. An in-flight response does not overwrite newer manual drafts.

## Validation

Run in `public/v1`:

- `npm run test:terminology`: catalog/runtime freshness, explicit-key coverage, all registered portal/project navigation, browser editing and responsive layout, locale isolation, aliases, sentence/ICU composition, escaping, frozen documents and draft-tool bounds.
- `npm run test:localization`, `npm run check`, `npm run test:assistant`, and `npm run test:publication` for the shared infrastructure.
- `node --experimental-sqlite --import tsx --test --test-force-exit tests/customer-portal-v2.test.ts` for the public projection.

The older scheduling/settings source-pattern suites have 17 reproduced baseline failures. This change updates assertions for the moved terminology editor and localized portal text; it does not represent those unrelated suites as green. Structural scans cannot certify every future UI composition or a new language's grammar: keep behavior tests alongside catalog changes.

Development release reconciliation preserves the 17 installed web interface packs. New terminology/editor messages fall back to English where an installed pack has not translated them. Source migration traverses nested interface callbacks; it does not inspect or rewrite the live DOM.
