# FirstMate color picker

`firstmate-color-picker.js` supplies the shared color popover for browser UI.
Platform API loads it for all platform surfaces; the main portal, Measurements
editor, sample reports, and standalone Doc Editor harnesses also load it directly.

Existing `input[type="color"]` elements serve as backing controls. Their IDs,
selectors, values, native form behavior, and bubbling `input`/`change` events are
preserved. Captured clicks and Enter/Space open the FirstMate popover instead of
the browser dialog. Calls to a backing control's `showPicker()` also use this
popover. Dynamically inserted controls are enhanced automatically. No local app
picker implementation or explicit mount call is needed.

The popover provides a saturation/brightness plane, hue slider, HEX and RGB
fields, palette swatches, reset, keyboard navigation, focus containment, and
Escape to close. Font styling comes from the original field. Applications that
rerender a field during `input` retain the editing session when its replacement
uses the same ID or identifying data attributes.

Public API:

- `FirstMateColorPicker.open(input)` opens a backing control.
- `FirstMateColorPicker.close()` closes it and restores focus.
- `FirstMateColorPicker.refresh(scope)` enhances a newly added subtree immediately.
- Color parsing and RGB/HSV conversion helpers are available for shared callers.

The September 29 audit covered all repository UI sources, including literal and
programmatic inputs. Active picker consumers include Brand Kit, Docs Studio and
themes, Doc Editor (text, shapes, page, borders and shading), Visual Editor via
the shared Doc Editor color menu, markup, equipment, materials, onboarding,
proposals, pricebook, automations, project scopes, chat branding, Measurements
finishes/trim/resource markup/report colors, and sample reports. Internal portal
lead email and sample-report controls are covered by its Platform API bootstrap.
Retired diagnostics and old portal pages under `unused` are not activation targets.

Run `node --test tests/color-picker-browser.test.mjs` from `public/v1` for browser
event, native-dialog prevention, dynamic rerender, keyboard, viewport and color
conversion coverage.
