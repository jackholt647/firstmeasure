# Project resource rows on one line — October 11, 2026

Follow-up to the [October 10 density change](development-project-list-density-20261010.md), whose narrow-pane rows still took two lines.

Every line item in the Materials, Labor, Equipment and custom resource panes is now a single 24px row at any pane width: drag handle, name, optional variant or pay-type selector (its arrow only under 360px), color swatch, quantity sized to its digits (three by default, growing while typing), unit as plain text that becomes an input on focus, unit price (four characters by default), and Remove. Panes of 480px or more add a read-only line total. A narrow pane truncates the name; the row's hover summary gives the full name, quantity, unit, price, total and variant. The column header strip is gone because quantity and unit no longer sit in fixed columns.

Dragging the handle reorders an item within its list or moves it beside an item, or onto the header, of another list of the same resource type. Clicking the handle still opens the move-to-list menu, which is the keyboard and touch path. A reorder writes the list's items as one `revision` version; a move writes the target's items as one `supplement` version and then removes the item from the source, undoing the target write if the removal fails.

List headers are one line without the repeated category icon: collapse, name, subtotal, icon-only Schedule and Order, Delete. Lists named after their category display as Default, and lists created by the first Add are titled Default. Collapsing a list is local view state. Minimize moved from lists to resource type columns, restored from a header pill. The measured/order units switch moved to the action header and applies to every list.

Validation: `node --test tests/project-scope-work-browser.test.mjs` (11 passing), covering one-line rows with all controls inside the row at 233px and 500px+ columns, the hover summary, and the reorder, cross-list, cross-type and failed-write paths of the drop writer. Real drag and drop, the handle menu and input growth were exercised in headless Chrome against the rendered panes. The hosted modal was not inspected in a signed-in browser session.

Development activation only: release `062ca96ff81278cfa8ebecfd1bbe026b22616d7e` over audited `5759f2eecff3fe9bd08c1b17ce05516bd84a489c` baselines on compatibility, web and pool, as immutable hardlink overlays of two owned files merged onto each role's live content. The worker serves no library files and stays on its baseline. Each role passed stage, activate and verify. Rollback: repoint `/opt/firstmeasure/current` to the retained baseline release on each role and restart its development service.

## Follow-ups the same day

Release `75eef23291bac8bf850b67ec4d861d085c2aa3b7` widened the unit price to six characters and showed it in whole dollars with separators (edited as the stored number on focus), after four-digit prices were clipped. A concurrent rollout from another checkout activated over it mid-verify; its release kept this content.

Release `7cd0e1268caee2b35f6b70698d9fbfe76950cee2` then changed what a collapsed row shows: quantity, unit and the read-only line total in whole dollars at every pane width, with an expander. Expanding a row shows its variant or pay type, the unit price and Remove beneath it, so the inline price, the inline remove button and the arrow-only selectors are gone. The bundle version is `20261011-row-totals`.

Validation: `node --test tests/project-scope-work-browser.test.mjs` (11 passing), including that price and Remove are hidden until a row is expanded and that the expanded detail stays inside a 233px pane. Activated on compatibility, web and pool over audited `b045f1906810b0395ba0c0cd98088938593a5ebb` baselines, staged in the standard release directories; each role passed stage, activate and verify. The hosted modal was not inspected in a signed-in browser session.

Release `07b7a6c748a678941cc1b7e8bfdf9e4f0e3216fc` changed both pitch breakdown tables (the Scope of Work measurements and the 3D roof key's Pitches tab) from one row per pitch to one column per pitch: a Pitch row above a Squares row, scrolling sideways when the rail is narrow. Editing, validation and project-local overrides are unchanged. Five library files shipped, with the roof viewer, scope helper and Project bundle versions set to `20261011-pitch-columns`.

Validation: `node --test tests/project-scope-work-browser.test.mjs tests/measurements-roof-viewer-browser.test.mjs` (13 passing). Staged, activated and verified on compatibility and web; pool activated, but a concurrent rollout from another checkout replaced the active release on all three roles before pool's verify ran. A re-audit after it settled found every role on `940d95c71c3dc04ad133f4809772a0f5312b9bf6` with these files intact, and the public readiness endpoint healthy.
