# FirstMeasure language completion — October 6, 2026

Runtime release: `49c80d359719f6bdd3b4ace4532ed627a6feeb1c`.

The audited FirstMeasure controls now resolve through language catalogs: Brand Kit,
company information and measurements, billing and credit dialogs, project creation,
roof/exterior ordering, shared project-window controls, and report labels. Embedded
order windows and direct credit dialogs load their catalogs before first render.
Billing dates, counts and money displays use the company locale without changing
currency, report prices or stored amounts. Customer names, addresses and authored
notes remain unchanged. Report dictionaries freeze catalog IDs and source-phrase
aliases with the order; historical snapshots retain their issued dictionaries.

Sixteen GPT-6 Luna language tasks completed, covering the fifteen non-English packs
and British English. US English remains the source. The Norwegian task initially
stopped incomplete; it was resumed, completed, and revalidated before integration.
The coordinator validated and imported 14,130 response entries, preserving existing
translations and reusing matching Brand Kit translations from the old namespace.
All active packets pass identity, source-hash, ICU argument/type, HTML/entity and
URL checks. Three ambiguous legacy keys remain null in every assignment:
`firstmeasure/m_4aa448197d6dba`, `firstmeasure/m_560af3752dff0d`, and
`firstmeasure/m_5802bbe967d5c6`. Current order code does not reference these keys;
their English fallback is retained for compatibility.

The compiler preserves the expanded report namespace across builds and performs
British spelling changes only in ICU literal text, preserving argument names such
as `{color}`. Missing non-English entries are reported while English fallback stays
available. Asset versions were updated for the changed application bundles.

Validation: 12 platform/localization/PDF-worker tests and 22 report/exterior tests;
14 real browser PDF exports with default/explicit US byte equality and metric
exclusion checks; deterministic before/after US drawing checks; company-locale
formatting checks without currency/value changes; JavaScript/PHP syntax; local and
staged Linux TypeScript checks. A fresh hosted development fixture verified Japanese
Brand Kit and preview labels, measurement settings, the New Report button, initial
contact placeholders, map instructions and the direct credit dialog, with no page
errors. Temporary browser fixtures were deleted. No payment or external message was
created. These checks establish structural translation validity, not a professional
linguistic review of every phrase. Non-Latin PDF glyph coverage and long translated
PDF labels still need per-language visual export review; the existing fonts remain.

Development web, pool, compatibility and PDF worker are active on the release.
Immutable overlays retain unrelated role-specific code and settings; updated files
are detached before writing hardlink clones. Source and compiled assets are verified
by hash, including report scripts and catalogs on the PDF worker. Readiness and
development outbound isolation passed on all four roles. Public readiness and the
hosted browser checks passed after activation. Production, infrastructure topology,
provider configuration and database schemas were not changed.

The prior web/pool/compatibility release was
`62884b984deecc90f91995db710dc6916459c028`; the prior worker release was
`90fce73f149950417eabda93538d22ca47a9e2a8`. Exact paths, per-role files, hashes,
capacity checks and rollback provenance are in
`output/firstmeasure-localization-wiring-20261006/deployment/manifest.json` and
`verified-deployment.json`. Task identities, packet results and hosted captures are
in the parent output directory. Rollback restores the recorded prior role symlink,
restarts its development service, and reloads PHP-FPM for serving roles. Recheck
intervening deployments first. Keep historical content-hashed catalog files for
issued report/document snapshots.
