# Contacts layout correction and shared icons - September 29, 2026

Development-only immutable release: `6ca57704c2c46951a2a84f4f1fe9555981e7dbfe`.

Contacts no longer declares full-bleed, restoring the same portal-provided 22px desktop / 12px mobile inset used by Projects and Feed. The previous standalone screenshot fixture supplied margin and failed to detect this integration defect. New tests exercise the portal panel selectors and app fullBleed registration.

Contacts retains the two-line Feed title scale (18px title, 12px subtitle), 38px toolbar controls and 12px action text. Contact names are 16px and details 13px; cards have 16px padding. List rows have 14px padding, rounded soft backgrounds and gutters rather than edge-to-edge dividers. Narrow screens show a readable wrapped list and toolbar. Search, sorting, imports, contact/project opening and automatic data loading remain available.

Projects title icon now matches its registered sidebar icon (`fa-folder-open`). Removed manual refresh buttons and click handlers from Contacts and Feed. Feed's automatic loading and mutation updates are retained.

Validation: three frontend syntax checks; Projects and Contacts browser fixtures passed. Contacts tests compare computed title/action font sizes and action heights against actual Feed CSS, verify portal insets, larger row typography and padding, removal of refresh, search/sort/view switching, contact/project opening and layouts at 390px and 320px. Desktop tiles/list and mobile screenshots inspected. The current signed-in development browser account exposes only Projects; direct live Contacts/Feed navigation is therefore unavailable in that account. No account grants or flags were changed.

Rollout overlays only the three owned app files and their bundle tokens on audited role-specific baselines. Development web, pool and compatibility prior release: `257c373dacbdb03e3baba301591e5de632f5c011`. All app source files matched that immutable baseline; compatibility manifest differences are preserved. Source/runtime guards precede staging and activation, with rollback on failed readiness. No production or worker changes.

Rollback: restore each development role's `/opt/firstmeasure/current` to `/opt/firstmeasure/releases/257c373dacbdb03e3baba301591e5de632f5c011`, restart its development service and PHP-FPM, and verify development readiness/environment isolation.

Activated and directly verified on all three development roles. Runtime development isolation, outbound safety and owned-file hashes passed. Four public frontend asset hashes and six public readiness responses passed. Contacts/Projects browser tests passed with the hosted app scripts and actual portal fonts; the hosted Feed script has no refresh button. The live development browser confirms the Projects title and sidebar both use `fas fa-folder-open`.
