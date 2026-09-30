# Shared browser color picker

The FirstMate browser UI uses
`public/libraries/color-picker/firstmate-color-picker.js`. Existing
`input[type="color"]` elements remain backing controls so IDs, selectors, form
values, and bubbling `input`/`change` events remain compatible. Captured clicks
and Enter/Space open the shared popover and prevent the browser's native dialog.
`showPicker()` on enhanced fields routes to the same popover. New controls are
enhanced by a document observer, including generated controls in editor menus.

The control provides a saturation/brightness plane (arrow keys, Shift for larger
steps), hue slider, HEX/RGB editing, palette/recent colors, Reset/Done, a focus
trap, and Escape. Its font comes from the original field. HEX and RGB inputs are
not rewritten while focused, preserving typing/caret state. The active backing
field can be rebound after a consumer rerender using its ID or identifying data
attributes. Consumers should preserve these identifiers when replacing controls.

API: `FirstMateColorPicker.open(input)`, `.close()`, `.refresh(scope)`. Parsing
and RGB/HSV conversion helpers are also exported. No per-app mount is required.

## Loading

- `public/portal/index.php` loads the library directly before Platform API.
- `public/libraries/platform-api/platform-api.js` loads it once for all other
  platform hosts, including the internal portal, mobile host, and customer host.
- `public/measure/internal/editor.php` loads it directly for Measurements, whose
  editor does not use the Platform API bootstrap.
- `public/measure/sales/sample-reports/index.php` loads it directly.
- The standalone `public/libraries/doc-editor/dev-editor.html`,
  `public/libraries/doc-editor/dev-website.html`, and
  `public/libraries/doc-workflow/dev-editor.html` harnesses load it directly.

## Audited consumers (September 29, 2026)

Repository-wide searches covered literal color-input markup, programmatic
`type: "color"`/`.type = "color"` construction, `setAttribute` construction,
native `showPicker()` calls, and existing picker selectors. All active consumers
are reached through the loading paths above.

| Source | Color controls |
| --- | --- |
| `public/libraries/brand-kit/brand-kit.js` | Primary, secondary, supporting palette, logo background |
| `public/libraries/apps/documents/studio.js` | Theme colors; Brand Kit now delegates to the shared Brand Kit |
| `public/libraries/doc-editor/firstmate-doc-editor.js` | Text, custom palette, page, border, paragraph shading, generic inspector colors |
| `public/libraries/visual-editor/firstmate-visual-editor.js` | Shared Doc Editor palette consumer; no independent native input constructor |
| `public/libraries/markup/firstmate-markup.js` | Custom markup stroke |
| `public/libraries/pricebook/firstmate-pricebook.js` | Color option values |
| `public/libraries/apps/equipment/app.js` | Unit identity |
| `public/libraries/apps/materials/project.js` | List colors |
| `public/libraries/apps/onboarding/wizard.js` | Primary and secondary brand colors |
| `public/libraries/apps/proposals/project.js` | Markup, proposal branding, rich text custom colors |
| `public/libraries/apps/settings/automations.js` | Board creation and template color |
| `public/libraries/apps/settings/company.js` | Project scopes, shared Brand Kit and supporting colors |
| `public/libraries/apps/settings/live_chat.js` | Chat branding configuration |
| `public/measure/internal/editor.php` | Mask color, including hidden/programmatically clicked control |
| `public/measure/internal/editor_scripts/wall_features.js` | Wall finish, default finish and trim |
| `public/measure/internal/editor_scripts/roof_trim_editor.js` | Wall and opening trim |
| `public/measure/internal/editor_scripts/project_resources.js` | Resource markup stroke |
| `public/measure/internal/editor_scripts/report.js` | Report primary and secondary branding |
| `public/measure/internal/portal_scripts/lead_viewer.js` | Email primary and secondary branding |
| `public/measure/internal/portal_scripts/sample_reports.js` | Sample report branding |
| `public/measure/sales/sample-reports/scripts/sample_reports.js` | Standalone sample report branding |

CSS color selectors and Doc Editor regression assertions are consumers of the
backing input contract, not additional picker constructors. The material
`richColorPicker` helper selects product color options and is unrelated to the
browser's native color dialog.

The retired `public/measure/internal/unused/diagnostics/codex_pdf_standalone_test.php`
contains two native inputs. Retired `unused/old_sales_portal` pages reference the
old lead/sample-report scripts. These inactive pages are left intact and were
not reactivated or treated as platform entry points.

## Verification

From `public/v1`, run
`node --test tests/color-picker-browser.test.mjs tests/browser-csrf.test.mjs`.
The browser test checks native click cancellation, original events and values,
HEX/RGB sequential typing, invalid HEX, keyboard editing, Escape/focus restoration,
dynamic insertion, dynamic field replacement, programmatic `showPicker`, disabled
controls, and viewport placement. Separate conversion assertions cover shorthand,
primary colors, hue wrap and channel bounds. The CSRF suite checks that the new
bootstrap does not affect the existing client request behavior.
