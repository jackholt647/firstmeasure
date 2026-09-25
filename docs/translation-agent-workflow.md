# Translation agents: shared context, independent languages

This workflow separates code/context research from translation. It does not require translation workers to inspect the repository, run application tests, review layouts or deploy. Visual/font/template review can happen after development publication. Registration and building are central integration tasks.

## Current state

The source catalog has 8,985 messages in 90 namespaces at the initial extraction. It previously contained English strings and ICU format markers, not per-message semantic explanations. The context extractor found source references for 8,437 messages. The rest remain visible in the review queue; a generated catalog entry may have no literal source call (for example generated report terminology).

The new system provides the complete inventory, source excerpts for a context author, reusable reviewed notes, bounded language packets and validated per-locale imports. **Extraction is not semantic review.** The initial notes do not claim every message has been explained. A shared context author still needs to review the queued entries once. Unresolved entries are explicitly marked, and translation workers can return questions instead of guessing.

## 1. Build context once

From `public/v1`:

```sh
node scripts/translation-kit.mjs context
```

Output is in `output/translation-kit` at the repository root:

- `context.json`: complete inventory with stable IDs, source hashes, ICU arguments, inferred roles, neighboring catalog strings and source references/excerpts.
- `context-review/*.json`: batches of at most 60 entries for the context author. Nearby catalog entries are clues, not guaranteed neighboring UI elements. Inferred roles need review.

Give the context author these batches, the shared glossary and access to source when excerpts are insufficient. Have it record **meaning, placeholder meanings, constraints and source_hash** under `messages` in `public/v1/platform/localization/translation-context.json`. Namespace descriptions and the glossary live in that file too. Use concise prose, not code dumps. Example:

```json
{
  "settings/company_language_inherit": {
    "source_hash": "COPY THE HASH FROM THE CONTEXT ENTRY",
    "meaning": "Dropdown choice that follows the company default language instead of fixing a personal language.",
    "placeholders": { "name": "Display name of the current company language, such as English (UK)." },
    "constraints": ["Keep this concise enough for a dropdown option."]
  }
}
```

Never mark an uncertain interpretation reviewed. If one key is reused with incompatible meanings, the coordinator should split the source key before translation. Changes to the English message invalidate its reviewed note automatically. Changes to surrounding behavior require the coordinator to revisit the note even if its text is unchanged.

## 2. Produce small, code-free language packets

```sh
node scripts/translation-kit.mjs packets --locale fr-FR
```

Normal export requires reviewed message context. Add `--allow-unreviewed` for a deliberate draft run; unresolved meanings remain flagged and must not be presented as reviewed context.

Each language has its own `input/` and `responses/` directory. Packets contain at most 60 messages, a shared glossary, source text, context, placeholder information and constraints. Source code/excerpts are omitted. Response templates contain null translations and an `issues` array. A null response preserves English fallback. Responses are never overwritten when regenerating identical packets. Packet hashes change when the source or context changes; dispatch only the packets listed in that locale's current `manifest.json`, not stale files left from a prior extraction.

Dispatch languages independently, and feed each worker one packet at a time. Maintain a small locale glossary for consistent domain terminology across its packets. A language contains many batches: **do not ask one lightweight model to ingest all 8,985 messages at once**. Copy only its inputs, response templates and instructions into the task/worktree; generated files under `output` are not automatically included by Git. No language list or models are selected by this script.

Suggested translation-worker prompt:

> Translate the assigned packets into [locale]. Use only the supplied source text, context and glossary; no repository research, UI tests or deployment. Preserve packet IDs, message IDs, ICU arguments, HTML/entities, URLs and brands. Fill the response JSON translations with natural target-language text. Leave uncertain items null and explain them in issues. Keep a short locale glossary and process one packet per batch. Write only your assigned language's response files.

## 3. Coordinator validates and imports

```sh
node scripts/translation-kit.mjs import --packet PATH_TO_INPUT_JSON --response PATH_TO_RESPONSE_JSON
```

Import checks packet identity, locale, unchanged source hashes, missing/unknown keys, nonempty translations, ICU syntax/argument names/types and preserved HTML/entity/URL tokens. Target-language plural categories can differ from English. Null entries are skipped. Issues are printed for coordinator review. These checks establish structural validity, not linguistic correctness.

Accepted translations merge into `public/v1/platform/localization/packs/<locale>.json`. Imports should run serially per locale. Agents never race to edit the central registry or shared override file. The compiler reads registered per-locale files and fills missing messages with English.

## 4. Register, load and publish for testing

```sh
node scripts/translation-kit.mjs register --locale fr-FR --label Français
# For an intentionally incomplete dev pack, add --allow-partial.
npm run localization:build
node --test tests/translation-kit.test.mjs
npm run check
```

Registration prints translated/total counts. Both Company and personal interface selectors use that registry; inline translation targets remain a separate broader list. Registration and compilation are local until the coordinator uses the normal authorized development deployment workflow. Keep old content-hashed catalog files for issued document/report snapshots.

Then test the languages together in the app. Visual polish, font coverage and report-template review may follow development publication. Existing browser stacks use system/generic fallback fonts, but that cannot guarantee glyph support in every OS or PDF renderer. English text fallback covers missing catalog entries, not missing glyphs or unlocalized legacy templates. This workflow does not silently convert every report template or add embedded fonts. Record these as dev testing findings rather than assigning them to translation workers.

The separate `localization:check` audit still has a known hardcoded-string backlog. It remains visible; this context pipeline only covers messages already in the source catalog.
