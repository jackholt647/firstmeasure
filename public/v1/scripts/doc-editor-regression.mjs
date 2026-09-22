/**
 * Regression guard for the PAGED document surface (doc.kind "document").
 * The website work changed shared editor/renderer internals; this proves the
 * document editor still selects, moves and resizes, keeps its three modes and
 * its Pages rail, and that the built-in profiles are untouched.
 *
 *   node scripts/doc-editor-regression.mjs      (from public/v1)
 */
import { chromium } from "playwright-core";
import { access } from "node:fs/promises";

const HARNESS = process.env.DOC_HARNESS_URL || "http://127.0.0.1:8011/libraries/doc-editor/dev-editor.html";

async function browserPath() {
  const candidates = process.platform === "win32"
    ? ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
       "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
       "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium"];
  for (const c of candidates) { try { await access(c); return c; } catch { /* next */ } }
  throw new Error("no Chrome/Edge found");
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : "  " + JSON.stringify(detail)}`);
};

const browser = await chromium.launch({ executablePath: await browserPath(), headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on("pageerror", (e) => console.log("   [pageerror]", e.message));

await page.goto(HARNESS, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelector(".fmdoc-page") !== null, null, { timeout: 30000 });
await page.waitForTimeout(2000);

const shape = await page.evaluate(() => ({
  pages: document.querySelectorAll(".fmdoc-page").length,
  modes: Array.from(document.querySelectorAll(".fmde-modebtn")).map((b) => b.textContent.trim()),
  railTabs: Array.from(document.querySelectorAll(".fmde-rail-tab")).map((b) => b.textContent.trim()),
  paperField: Array.from(document.querySelectorAll(".fmde-field-label")).map((l) => l.textContent.trim()).includes("Paper"),
  profiles: window.FMDocEditor.PROFILES,
  designerFlags: window.FMDocEditor.PROFILE_FLAGS.designer,
  documentFlags: window.FMDocEditor.PROFILE_FLAGS.document,
  fillFlags: window.FMDocEditor.PROFILE_FLAGS.fill,
  inlineFlags: window.FMDocEditor.PROFILE_FLAGS.inline
}));

check("paged document still renders pages", shape.pages >= 1, { pages: shape.pages });
check("all three modes remain available", shape.modes.join(",") === "Visual,Doc,Preview", shape.modes);
check("Pages rail tab still present for paged docs", shape.railTabs.some((t) => /pages/i.test(t)), shape.railTabs);
check("paper-size control still shown for paged docs", shape.paperField);
check("website profile registered alongside the built-ins",
  shape.profiles.includes("website") && ["designer", "document", "fill", "inline"].every((p) => shape.profiles.includes(p)), shape.profiles);

// Built-in profile flag presets must be byte-identical to their documented values.
const expected = {
  designer: { free_transform: true, rotate: true, resize: true, shapes: true, images: true, filters: true, text_style: true, widget_insert: true, page_manage: true, group: true, z_order: true, theme_edit: true, bind_edit: true, unlock: false },
  document: { free_transform: true, rotate: false, resize: true, shapes: false, images: true, filters: false, text_style: true, widget_insert: true, page_manage: true, group: true, z_order: true, theme_edit: false, bind_edit: false, unlock: true }
};
for (const [name, want] of Object.entries(expected)) {
  const got = name === "designer" ? shape.designerFlags : shape.documentFlags;
  const same = Object.keys(want).every((k) => got[k] === want[k]);
  check(`${name} profile flags unchanged`, same, same ? undefined : { got, want });
}
check("fill profile stays locked down", shape.fillFlags.free_transform === false && shape.fillFlags.resize === false, shape.fillFlags);
// Inline is chromeless and keeps page structure locked, but movable objects
// retain grouping parity with the other transform-enabled profiles.
check("inline keeps page structure locked while movable objects remain groupable",
  shape.inlineFlags.widget_insert === false && shape.inlineFlags.page_manage === false && shape.inlineFlags.group === true && shape.inlineFlags.unlock === false,
  shape.inlineFlags);

// Direct manipulation on a paged doc must still work.
const nodeId = await page.evaluate(() => {
  const el = document.querySelector('.fmdoc-page [data-node-id][data-node-type="text"]');
  return el ? el.getAttribute("data-node-id") : null;
});
if (!nodeId) {
  check("found a text node to manipulate", false);
} else {
  const rect = await page.evaluate((id) => {
    const r = document.querySelector('[data-node-id="' + id + '"]').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, nodeId);
  await page.mouse.click(rect.x + rect.w / 2, rect.y + rect.h / 2);
  await page.waitForTimeout(300);
  const sel = await page.evaluate(() => window.editor ? window.editor.selection() : []);
  check("clicking a node in a paged doc selects it", sel.length === 1, sel);

  const before = await page.evaluate((id) => {
    let f = null;
    (function walk(n) { if (!n || f) return; if (n.id === id) { f = n.frame; return; } (n.children || []).forEach(walk); })({ children: window.editor.getDocument().pages });
    return f && { x: f.x, y: f.y };
  }, nodeId);
  await page.keyboard.down("Alt");
  await page.mouse.move(rect.x + rect.w / 2, rect.y + rect.h / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.w / 2 + 60, rect.y + rect.h / 2 + 30, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await page.waitForTimeout(400);
  const moved = await page.evaluate((id) => {
    const r = document.querySelector('[data-node-id="' + id + '"]').getBoundingClientRect();
    return { x: r.x, y: r.y };
  }, nodeId);
  check("dragging a node in a paged doc moves it", Math.abs((moved.x - rect.x) - 60) < 10,
    { dx: +(moved.x - rect.x).toFixed(1), before });
}

// Host-provided dictation must enter through text.edit so it participates in
// the normal editor history/change stream.
const dictation = await page.evaluate(async () => {
  const source = window.editor.getDocument();
  window.editor.destroy();
  const host = document.getElementById("editor");
  window.editor = window.FMDocEditor.mount(host, {
    document: source,
    profile: "document",
    mode: "visual",
    onDictate: () => Promise.resolve("dictated regression text")
  });
  let textId = "";
  (function walk(node) {
    if (!node || textId) return;
    if (node.type === "text") { textId = node.id; return; }
    for (const child of node.children || []) walk(child);
  })({ children: window.editor.getDocument().pages });
  window.editor.select([textId]);
  const button = document.querySelector('[aria-label="Dictate into the selected text section"]');
  button?.click();
  await new Promise((resolve) => setTimeout(resolve, 80));
  let found = null;
  (function walk(node) {
    if (!node || found) return;
    if (node.id === textId) { found = node; return; }
    for (const child of node.children || []) walk(child);
  })({ children: window.editor.getDocument().pages });
  const text = (found?.props?.blocks || []).flatMap((block) => block.runs || []).map((run) => run.text || "").join("");
  const inserted = text.includes("dictated regression text");
  window.editor.undo();
  let afterUndo = null;
  (function walk(node) {
    if (!node || afterUndo) return;
    if (node.id === textId) { afterUndo = node; return; }
    for (const child of node.children || []) walk(child);
  })({ children: window.editor.getDocument().pages });
  const undoText = (afterUndo?.props?.blocks || []).flatMap((block) => block.runs || []).map((run) => run.text || "").join("");
  return {
    hasButton: !!button,
    inserted,
    undoRemoved: !undoText.includes("dictated regression text")
  };
});
check("dictation control appears when the host provides onDictate", dictation.hasButton, dictation);
check("dictation inserts returned text through the editor", dictation.inserted, dictation);
check("dictation insertion participates in undo history", dictation.undoRemoved, dictation);

const docModeDictation = await page.evaluate(async () => {
  window.editor.setMode("doc");
  await new Promise((resolve) => setTimeout(resolve, 40));
  const editable = document.querySelector(".fmde-docedit");
  const block = editable?.querySelector(".fmdoc-block");
  if (!editable || !block) return { editable:false, inserted:false };
  editable.focus();
  const range = document.createRange();
  range.selectNodeContents(block);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  document.querySelector('[aria-label="Dictate into the selected text section"]')?.click();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const text = Array.from(document.querySelectorAll(".fmde-docedit .fmdoc-block"))
    .map((item) => item.textContent || "").join(" ");
  return { editable:true, inserted:text.includes("dictated regression text") };
});
check("doc-mode dictation inserts at an active editable section", docModeDictation.editable && docModeDictation.inserted, docModeDictation);

const bodyModeRoundTrip = await page.evaluate(async () => {
  window.editor.destroy();
  const doc = window.FMDocModel.createBlankDocument();
  const originalBody = doc.pages[0].children.find((node) => node.props?.page_region === "body");
  originalBody.children[0].props.blocks = [
    { id: "round_trip_heading", type: "heading", level: 1, runs: [{ text: "One heading" }] },
    { id: "round_trip_paragraph", type: "paragraph", runs: [{ text: "One paragraph" }] }
  ];
  window.editor = window.FMDocEditor.mount(document.getElementById("editor"), { document: doc, profile: "document", mode: "doc" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  window.editor.setMode("visual");
  await new Promise((resolve) => setTimeout(resolve, 100));
  window.editor.select([originalBody.children[0].id]);
  const atomicSelection = window.editor.selection();
  const selectedBody = atomicSelection.length === 1 && atomicSelection[0] === originalBody.id;
  document.querySelector(".fmde-root")?.focus();
  document.querySelector(".fmde-root")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const bodyDeleted = !window.editor.getDocument().pages[0].children.some((node) => node.props?.page_region === "body");
  window.editor.setMode("doc");
  await new Promise((resolve) => setTimeout(resolve, 120));
  const restoredBody = window.editor.getDocument().pages[0].children.find((node) => node.props?.page_region === "body");
  const editable = document.querySelector('[data-page-region="body"] .fmde-docedit[contenteditable="true"]');
  const block = editable?.querySelector(".fmdoc-block");
  editable?.focus();
  if (block) {
    const range = document.createRange();
    range.selectNodeContents(block);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("insertText", false, "Still editable");
  }
  await new Promise((resolve) => setTimeout(resolve, 260));
  const savedBody = window.editor.getDocument().pages[0].children.find((node) => node.props?.page_region === "body");
  const savedText = (savedBody?.children?.[0]?.props?.blocks || []).flatMap((item) => item.runs || []).map((run) => run.text || "").join("");
  return { selectedBody, bodyDeleted, restored: !!restoredBody, editable: !!editable, savedText };
});
check("Visual treats the Doc body as one selectable object", bodyModeRoundTrip.selectedBody, bodyModeRoundTrip);
check("returning to Doc restores a deleted editable body", bodyModeRoundTrip.bodyDeleted && bodyModeRoundTrip.restored && bodyModeRoundTrip.editable && bodyModeRoundTrip.savedText.includes("Still editable"), bodyModeRoundTrip);

// Product "Blank" documents are a word-processing scaffold, not an empty
// designer page: body text paginates and header/footer repeat on auto-pages.
const blankDocument = await page.evaluate(async () => {
  window.editor.destroy();
  const doc = window.FMDocModel.createBlankDocument({ metadata: { document_type: "generic" } });
  const regions = doc.pages[0].children;
  const header = regions.find((node) => node.props?.page_region === "header");
  const body = regions.find((node) => node.props?.page_region === "body");
  const footer = regions.find((node) => node.props?.page_region === "footer");
  header.children[0].props.blocks[0].runs[0].text = "Repeated header";
  footer.children[0].props.blocks[0].runs[0].text = "Repeated footer";
  body.children[0].props.blocks = Array.from({ length: 150 }, (_, index) => ({
    id: "blank_block_" + index,
    type: "paragraph",
    style_ref: "Normal text",
    runs: [{ text: "This is flowing paragraph " + (index + 1) + " in the blank document regression test." }]
  }));
  window.editor = window.FMDocEditor.mount(document.getElementById("editor"), { document: doc, profile: "document", mode: "doc" });
  await new Promise((resolve) => setTimeout(resolve, 350));
  const pages = Array.from(document.querySelectorAll(".fmdoc-page"));
  const repeated = pages.every((pageEl) => pageEl.textContent.includes("Repeated header") && pageEl.textContent.includes("Repeated footer"));
  const titles = Array.from(document.querySelectorAll(".fmde-toolbar button")).map((button) => button.title || button.textContent.trim());
  const headerRegion = document.querySelector('[data-page-region="header"]');
  headerRegion?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  document.execCommand("insertText", false, " updated");
  await new Promise((resolve) => setTimeout(resolve, 260));
  // A collapsed caret is enough to choose the format for subsequent typing.
  const fontButton = document.querySelector('button[title="Font"]');
  fontButton?.click();
  Array.from(document.querySelectorAll(".fmde-menu-item")).find((item) => item.textContent.trim() === "Georgia")?.click();
  document.execCommand("insertText", false, "G");
  await new Promise((resolve) => setTimeout(resolve, 260));
  const savedHeader = window.editor.getDocument().pages[0].children.find((node) => node.props?.page_region === "header");
  const headerRuns = savedHeader.children[0].props.blocks.flatMap((block) => block.runs || []);
  const typedRun = headerRuns.find((run) => String(run.text || "").includes("G"));
  const colorButton = document.querySelector('button[title="Text color"]');
  colorButton?.click();
  const textSwatches = document.querySelectorAll(".fmde-color-grid .fmde-color-chip").length;
  const hasTextCustom = !!document.querySelector('.fmde-color-menu input[type="color"]');
  const highlightButton = document.querySelector('button[title="Highlight color"]');
  highlightButton?.click();
  const highlightSwatches = document.querySelectorAll(".fmde-color-grid .fmde-color-chip").length;
  const hasHighlightCustom = !!document.querySelector('.fmde-color-menu input[type="color"]');
  const toolbarOverflow = getComputedStyle(document.querySelector(".fmde-toolbar")).overflowX;
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  const duplicatePairs = [
    ["Print", "Print"], ["Spelling and grammar", "Spelling and grammar"], ["Paint format", "Paint format"],
    ["Bold (Ctrl+B)", "Bold"], ["Italic (Ctrl+I)", "Italic"], ["Underline (Ctrl+U)", "Underline"],
    ["Font", "Font…"], ["Font size", "Font size…"], ["Text color", "Text color…"],
    ["Highlight color", "Highlight color…"], ["Insert link", "Insert link"], ["Add comment", "Add comment"],
    ["Bulleted list", "Bulleted list"], ["Numbered list", "Numbered list"], ["Checklist", "Checklist"]
  ];
  const visibleTitle = (title) => Array.from(document.querySelectorAll('.fmde-toolbar button[title="' + title + '"]')).some((button) => getComputedStyle(button.closest(".fmde-tb-group")).display !== "none");
  document.querySelector('button[title="More document options"]')?.click();
  const wideMoreLabels = Array.from(document.querySelectorAll(".fmde-menu-item")).map((item) => item.textContent.trim());
  const wideDuplicates = duplicatePairs.filter(([title, label]) => visibleTitle(title) && wideMoreLabels.includes(label));
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  const host = document.getElementById("editor");
  host.style.width = "700px";
  await new Promise((resolve) => setTimeout(resolve, 240));
  const toolbar = document.querySelector(".fmde-toolbar");
  const toolbarRect = toolbar.getBoundingClientRect();
  const visibleGroupsFit = Array.from(toolbar.querySelectorAll(":scope > .fmde-tb-group"))
    .filter((group) => getComputedStyle(group).display !== "none")
    .every((group) => group.getBoundingClientRect().right <= toolbarRect.right + 1);
  document.querySelector('button[title="More document options"]')?.click();
  const moreLabels = Array.from(document.querySelectorAll(".fmde-menu-item")).map((item) => item.textContent.trim());
  const narrowDuplicates = duplicatePairs.filter(([title, label]) => visibleTitle(title) && moreLabels.includes(label));
  return {
    pages: pages.length,
    repeated,
    headerFocused: !!document.activeElement?.closest?.('[data-page-region="header"]'),
    headerBlockCount: savedHeader.children[0].props.blocks.length,
    pendingFontApplied: typedRun?.font?.family === "Georgia",
    paletteGrid: textSwatches >= 60 && highlightSwatches >= 60 && hasTextCustom && hasHighlightCustom,
    liveColorIndicators: !!colorButton?.querySelector(".fmde-tool-color-line") && !!highlightButton?.querySelector(".fmde-tool-color-line"),
    toolbarDoesNotScroll: toolbarOverflow === "hidden" || toolbarOverflow === "clip",
    responsiveOverflow: visibleGroupsFit && toolbar.scrollWidth <= toolbar.clientWidth && ["Print", "Paragraph style…", "Insert link", "Align left", "Bulleted list", "Page numbers"].every((label) => moreLabels.includes(label)),
    exclusiveOverflow: wideDuplicates.length === 0 && narrowDuplicates.length === 0,
    wideMoreLabels,
    wideDuplicates,
    narrowDuplicates,
    controls: ["Print", "Spelling and grammar", "Paint format", "Font", "Font size", "Text color", "Highlight color", "Insert link", "Add comment", "Paragraph alignment", "Line and paragraph spacing", "Checklist", "Bulleted list", "Numbered list", "More document options"].every((title) => titles.includes(title))
  };
});
check("blank document body automatically paginates", blankDocument.pages > 1, blankDocument);
check("blank document header and footer repeat on generated pages", blankDocument.repeated, blankDocument);
check("clicking an invisible page region starts text editing", blankDocument.headerFocused, blankDocument);
check("editing a repeated header updates one source block", blankDocument.headerBlockCount === 1, blankDocument);
check("Doc toolbar exposes the familiar word-processing control set", blankDocument.controls, blankDocument);
check("font choice at a caret applies to subsequently typed text", blankDocument.pendingFontApplied, blankDocument);
check("text and highlight pickers use dense shared color grids", blankDocument.paletteGrid, blankDocument);
check("color toolbar icons expose live color indicators", blankDocument.liveColorIndicators, blankDocument);
check("Doc toolbar never becomes a horizontal scroller", blankDocument.toolbarDoesNotScroll, blankDocument);
check("responsive overflow moves complete control groups into More", blankDocument.responsiveOverflow, blankDocument);
check("More never duplicates commands that remain visible in the toolbar", blankDocument.exclusiveOverflow, blankDocument);

const listExit = await page.evaluate(async () => {
  window.editor.destroy();
  const doc = window.FMDocModel.createBlankDocument();
  const body = doc.pages[0].children.find((node) => node.props?.page_region === "body");
  body.children[0].props.blocks = [{ id: "empty_list", type: "list_item", list_style: "bullet", runs: [{ text: "" }] }];
  window.editor = window.FMDocEditor.mount(document.getElementById("editor"), { document: doc, profile: "document", mode: "doc" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  document.querySelector('[data-page-region="body"]')?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  const editable = document.querySelector('[data-page-region="body"] .fmde-docedit');
  editable?.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertParagraph" }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  const savedBody = window.editor.getDocument().pages[0].children.find((node) => node.props?.page_region === "body");
  return savedBody.children[0].props.blocks[0];
});
check("Enter on an empty list item exits to a normal paragraph", listExit.type === "paragraph" && !listExit.list_style, listExit);

const previewBlankLineParity = await page.evaluate(async () => {
  window.editor.destroy();
  const doc = window.FMDocModel.createBlankDocument();
  const body = doc.pages[0].children.find((node) => node.props?.page_region === "body");
  body.children[0].props.blocks = [
    { id: "parity_before", type: "paragraph", runs: [{ text: "Before" }] },
    { id: "parity_blank_1", type: "paragraph", runs: [{ text: "" }] },
    { id: "parity_blank_2", type: "paragraph", runs: [{ text: "" }] },
    { id: "parity_after", type: "paragraph", runs: [{ text: "After" }] }
  ];
  window.editor = window.FMDocEditor.mount(document.getElementById("editor"), { document: doc, profile: "document", mode: "doc" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const heights = () => ["parity_blank_1", "parity_blank_2"].map((id) => document.querySelector('[data-block-id="' + id + '"]')?.getBoundingClientRect().height || 0);
  const docHeights = heights();
  window.editor.setMode("preview");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const previewHeights = heights();
  return {
    docHeights,
    previewHeights,
    previewBlockCount: ["parity_before", "parity_blank_1", "parity_blank_2", "parity_after"].filter((id) => document.querySelector('[data-block-id="' + id + '"]')).length
  };
});
check("Preview preserves consecutive blank paragraph lines from Doc mode", previewBlankLineParity.previewBlockCount === 4 && previewBlankLineParity.previewHeights.every((height, index) => height > 0 && Math.abs(height - previewBlankLineParity.docHeights[index]) < 1), previewBlankLineParity);

const caretParagraphCommands = await page.evaluate(async () => {
  window.editor.destroy();
  const doc = window.FMDocModel.createBlankDocument();
  const body = doc.pages[0].children.find((node) => node.props?.page_region === "body");
  body.children[0].props.blocks = [
    { id: "caret_first", type: "paragraph", style_ref: "Normal text", runs: [{ text: "Caret-only paragraph" }] },
    { id: "caret_second", type: "paragraph", style_ref: "Normal text", runs: [{ text: "Second paragraph" }] }
  ];
  window.editor = window.FMDocEditor.mount(document.getElementById("editor"), { document: doc, profile: "document", mode: "doc" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const first = document.querySelector('[data-page-region="body"] [data-block-id="caret_first"]');
  const editable = first?.closest(".fmde-docedit");
  editable?.focus();
  const range = document.createRange();
  range.setStart(first.firstChild?.firstChild || first.firstChild || first, 3);
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  document.querySelector('button[title="Paragraph alignment"]')?.click();
  Array.from(document.querySelectorAll(".fmde-menu-item")).find((item) => item.textContent.includes("Align center"))?.click();
  await new Promise((resolve) => setTimeout(resolve, 80));

  // Clicking paper chrome outside a region hides the box outline without
  // surrendering the insertion caret.
  document.querySelector(".fmdoc-page-content")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  const passiveCaret = document.querySelector(".fmde-root")?.classList.contains("fmde-caret-passive")
    && !!document.activeElement?.closest?.(".fmde-docedit")
    && window.getSelection().isCollapsed;

  const activeEditable = document.activeElement?.closest?.(".fmde-docedit");
  const tabEvent = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  const tabPrevented = activeEditable ? !activeEditable.dispatchEvent(tabEvent) : false;
  await new Promise((resolve) => setTimeout(resolve, 80));
  const bodyAfterTab = window.editor.getDocument().pages[0].children.find((node) => node.props?.page_region === "body");
  const indentAfterTab = bodyAfterTab.children[0].props.blocks.find((block) => block.id === "caret_first")?.indent;
  const shiftedEditable = document.activeElement?.closest?.(".fmde-docedit");
  shiftedEditable?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  const bodyAfterShiftTab = window.editor.getDocument().pages[0].children.find((node) => node.props?.page_region === "body");
  const indentAfterShiftTab = bodyAfterShiftTab.children[0].props.blocks.find((block) => block.id === "caret_first")?.indent || 0;
  document.activeElement?.closest?.(".fmde-docedit")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 80));

  const projectedTab = document.querySelector('[data-page-region="body"] [data-block-id="caret_first"] > [data-fmdoc-indent]');
  let selectedTabText = "";
  let projectedTabWidth = 0;
  if (projectedTab?.firstChild) {
    const tabRange = document.createRange();
    tabRange.selectNodeContents(projectedTab);
    const tabSelection = window.getSelection();
    tabSelection.removeAllRanges();
    tabSelection.addRange(tabRange);
    selectedTabText = tabSelection.toString();
    projectedTabWidth = projectedTab.getBoundingClientRect().width;
    tabSelection.deleteFromDocument();
    projectedTab.closest(".fmde-docedit")?.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentForward" }));
  }
  await new Promise((resolve) => setTimeout(resolve, 220));
  const bodyAfterSelectedTabDelete = window.editor.getDocument().pages[0].children.find((node) => node.props?.page_region === "body");
  const blockAfterSelectedTabDelete = bodyAfterSelectedTabDelete.children[0].props.blocks.find((block) => block.id === "caret_first");
  const indentAfterSelectedTabDelete = blockAfterSelectedTabDelete?.indent || 0;
  const textAfterSelectedTabDelete = blockAfterSelectedTabDelete?.runs.map((run) => run.text || "").join("");

  document.activeElement?.closest?.(".fmde-docedit")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 80));

  const placeCaretAtStart = () => {
    const block = document.querySelector('[data-page-region="body"] [data-block-id="caret_first"]');
    const target = block?.closest(".fmde-docedit");
    target?.focus();
    const caretRange = document.createRange();
    caretRange.selectNodeContents(block);
    caretRange.collapse(true);
    const caretSelection = window.getSelection();
    caretSelection.removeAllRanges();
    caretSelection.addRange(caretRange);
    return target;
  };
  const backspaceEditable = placeCaretAtStart();
  const backspacePrevented = backspaceEditable
    ? !backspaceEditable.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentBackward" }))
    : false;
  await new Promise((resolve) => setTimeout(resolve, 80));
  const bodyAfterIndentBackspace = window.editor.getDocument().pages[0].children.find((node) => node.props?.page_region === "body");
  const indentAfterBackspace = bodyAfterIndentBackspace.children[0].props.blocks.find((block) => block.id === "caret_first")?.indent || 0;

  document.activeElement?.closest?.(".fmde-docedit")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  const deleteEditable = placeCaretAtStart();
  const deletePrevented = deleteEditable
    ? !deleteEditable.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentForward" }))
    : false;
  await new Promise((resolve) => setTimeout(resolve, 80));
  const bodyAfterIndentDelete = window.editor.getDocument().pages[0].children.find((node) => node.props?.page_region === "body");
  const indentAfterDelete = bodyAfterIndentDelete.children[0].props.blocks.find((block) => block.id === "caret_first")?.indent || 0;
  document.activeElement?.closest?.(".fmde-docedit")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 80));

  const placeCaretInBlock = (blockId, atEnd) => {
    const block = document.querySelector(`[data-page-region="body"] [data-block-id="${blockId}"]`);
    const target = block?.closest(".fmde-docedit");
    target?.focus();
    const caretRange = document.createRange();
    caretRange.selectNodeContents(block);
    caretRange.collapse(!atEnd);
    const caretSelection = window.getSelection();
    caretSelection.removeAllRanges();
    caretSelection.addRange(caretRange);
    return target;
  };
  placeCaretInBlock("caret_second", false)?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  const boundaryDeleteEditable = placeCaretInBlock("caret_first", true);
  const boundaryDeletePrevented = boundaryDeleteEditable
    ? !boundaryDeleteEditable.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentForward" }))
    : false;
  await new Promise((resolve) => setTimeout(resolve, 80));
  const bodyAfterBoundaryDelete = window.editor.getDocument().pages[0].children.find((node) => node.props?.page_region === "body");
  const boundaryBlocks = bodyAfterBoundaryDelete.children[0].props.blocks;
  const nextIndentAfterBoundaryDelete = boundaryBlocks.find((block) => block.id === "caret_second")?.indent || 0;

  document.querySelector('button[title="Line and paragraph spacing"]')?.click();
  Array.from(document.querySelectorAll(".fmde-menu-item")).find((item) => item.textContent.trim() === "1.5")?.click();
  await new Promise((resolve) => setTimeout(resolve, 80));
  document.querySelector('button[title="Bulleted list"]')?.click();
  await new Promise((resolve) => setTimeout(resolve, 80));

  const savedBody = window.editor.getDocument().pages[0].children.find((node) => node.props?.page_region === "body");
  const saved = savedBody.children[0].props.blocks.find((block) => block.id === "caret_first");
  return {
    align: saved?.align,
    indent: saved?.indent,
    lineHeight: saved?.line_height,
    type: saved?.type,
    listStyle: saved?.list_style,
    passiveCaret,
    tabPrevented,
    indentAfterTab,
    indentAfterShiftTab,
    selectedTabText,
    projectedTabWidth,
    indentAfterSelectedTabDelete,
    textAfterSelectedTabDelete,
    backspacePrevented,
    indentAfterBackspace,
    deletePrevented,
    indentAfterDelete,
    boundaryDeletePrevented,
    nextIndentAfterBoundaryDelete,
    blockCountAfterBoundaryDelete: boundaryBlocks.length
  };
});
check("collapsed-caret paragraph controls target the current paragraph", caretParagraphCommands.align === "center" && caretParagraphCommands.lineHeight === 1.5 && caretParagraphCommands.type === "list_item" && caretParagraphCommands.listStyle === "bullet", caretParagraphCommands);
check("clicking outside a text region preserves a passive insertion caret", caretParagraphCommands.passiveCaret, caretParagraphCommands);
check("Tab and Shift+Tab indent/outdent without moving focus", caretParagraphCommands.tabPrevented && caretParagraphCommands.indentAfterTab === 1 && caretParagraphCommands.indentAfterShiftTab === 0 && caretParagraphCommands.indent === 1, caretParagraphCommands);
check("paragraph tab markers are selectable and delete as one indent level", caretParagraphCommands.selectedTabText === "\t" && caretParagraphCommands.projectedTabWidth > 0 && caretParagraphCommands.indentAfterSelectedTabDelete === 0 && caretParagraphCommands.textAfterSelectedTabDelete === "Caret-only paragraph", caretParagraphCommands);
check("Backspace and Delete remove an indent before text", caretParagraphCommands.backspacePrevented && caretParagraphCommands.indentAfterBackspace === 0 && caretParagraphCommands.deletePrevented && caretParagraphCommands.indentAfterDelete === 0, caretParagraphCommands);
check("Delete before an indented paragraph outdents instead of merging", caretParagraphCommands.boundaryDeletePrevented && caretParagraphCommands.nextIndentAfterBoundaryDelete === 0 && caretParagraphCommands.blockCountAfterBoundaryDelete === 2, caretParagraphCommands);

const livePagination = await page.evaluate(async () => {
  window.editor.destroy();
  const doc = window.FMDocModel.createBlankDocument();
  window.editor = window.FMDocEditor.mount(document.getElementById("editor"), { document: doc, profile: "document", mode: "doc" });
  await new Promise((resolve) => setTimeout(resolve, 90));
  document.querySelector('[data-page-region="body"]')?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  document.execCommand("insertText", false, ("A line that should remain inside the connected body text boxes.\n").repeat(90));
  // Deliberately shorter than DOC_COMMIT_MS: crossing the body frame should
  // force pagination immediately instead of waiting for the idle debounce.
  await new Promise((resolve) => setTimeout(resolve, 110));
  const pages = Array.from(document.querySelectorAll(".fmdoc-page"));
  const bodyFrames = Array.from(document.querySelectorAll('[data-chain="body"]'));
  const firstBody = pages[0]?.querySelector('[data-page-region="body"]');
  const firstFooter = pages[0]?.querySelector('[data-page-region="footer"]');
  return {
    pages: pages.length,
    bodyFrames: bodyFrames.length,
    clipped: bodyFrames.every((frame) => getComputedStyle(frame).overflow === "hidden"),
    bodyEndsBeforeFooter: !!firstBody && !!firstFooter && firstBody.getBoundingClientRect().bottom <= firstFooter.getBoundingClientRect().top + 0.5,
    framesFit: bodyFrames.every((frame) => frame.scrollHeight <= frame.clientHeight + 1)
  };
});
check("live typing paginates as soon as the body text box fills", livePagination.pages > 1 && livePagination.bodyFrames > 1, livePagination);
check("connected body frames stop before the footer", livePagination.clipped && livePagination.bodyEndsBeforeFooter && livePagination.framesFit, livePagination);

const explicitPageBreak = await page.evaluate(async () => {
  window.editor.destroy();
  const doc = window.FMDocModel.createBlankDocument();
  const body = doc.pages[0].children.find((node) => node.props?.page_region === "body");
  body.children[0].props.blocks = [{
    id: "break_source",
    type: "paragraph",
    style_ref: "Normal text",
    runs: [{ text: "BeforeAfter" }]
  }];
  window.editor = window.FMDocEditor.mount(document.getElementById("editor"), { document: doc, profile: "document", mode: "doc" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const sourceBlock = document.querySelector('[data-page-region="body"] [data-block-id="break_source"]');
  const editable = sourceBlock?.closest(".fmde-docedit");
  editable?.focus();
  const textNode = sourceBlock?.querySelector("span")?.firstChild || sourceBlock?.firstChild;
  const range = document.createRange();
  range.setStart(textNode, 6);
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  editable?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 150));

  const afterInsert = window.editor.getDocument().pages[0].children.find((node) => node.props?.page_region === "body");
  const typesAfterInsert = afterInsert.children.map((node) => node.type);
  const textAfterInsert = afterInsert.children.filter((node) => node.type === "text")
    .map((node) => node.props.blocks.flatMap((block) => block.runs).map((run) => run.text || "").join(""));
  const pagesAfterInsert = document.querySelectorAll(".fmdoc-page").length;
  const breakElement = document.querySelector(".fmdoc-page_break");
  const breakMarkerHidden = !!breakElement
    && getComputedStyle(breakElement, "::before").display === "none"
    && getComputedStyle(breakElement, "::after").display === "none";
  const activeAfterInsert = document.activeElement?.closest?.(".fmde-docedit");
  const caretOnContinuation = !!activeAfterInsert
    && activeAfterInsert.getAttribute("data-node-id")?.replace(/::part\d+$/, "") === afterInsert.children[2]?.id
    && window.getSelection().isCollapsed;

  activeAfterInsert?.dispatchEvent(new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType: "deleteContentBackward"
  }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const afterBackspace = window.editor.getDocument().pages[0].children.find((node) => node.props?.page_region === "body");
  const mergedText = afterBackspace.children[0].props.blocks.flatMap((block) => block.runs).map((run) => run.text || "").join("");
  const pagesAfterBackspace = document.querySelectorAll(".fmdoc-page").length;

  window.editor.undo();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const afterUndo = window.editor.getDocument().pages[0].children.find((node) => node.props?.page_region === "body");
  return {
    typesAfterInsert,
    textAfterInsert,
    pagesAfterInsert,
    breakMarkerHidden,
    caretOnContinuation,
    mergedTypes: afterBackspace.children.map((node) => node.type),
    mergedText,
    pagesAfterBackspace,
    undoRestoredBreak: afterUndo.children.map((node) => node.type).join(",") === "text,page_break,text"
  };
});
check("Ctrl+Enter splits text at the caret and starts a new page", explicitPageBreak.typesAfterInsert.join(",") === "text,page_break,text" && explicitPageBreak.textAfterInsert.join("|") === "Before|After" && explicitPageBreak.pagesAfterInsert === 2 && explicitPageBreak.caretOnContinuation, explicitPageBreak);
check("explicit page breaks have no visible editor marker", explicitPageBreak.breakMarkerHidden, explicitPageBreak);
check("Backspace at the new page start removes the page break and rejoins text", explicitPageBreak.mergedTypes.join(",") === "text" && explicitPageBreak.mergedText === "BeforeAfter" && explicitPageBreak.pagesAfterBackspace === 1, explicitPageBreak);
check("removing an explicit page break participates in undo", explicitPageBreak.undoRestoredBreak, explicitPageBreak);

// Theme chrome must not add a second, output-only content offset, and resizing
// one member of a flow table must keep every sibling width linked.
const layoutDoc = await page.evaluate(async () => {
  window.editor.destroy();
  const M = window.FMDocModel;
  const doc = M.createDocument({ first_page_role: "body" });
  const child = (id, name, h) => M.createNode("frame", {
    id, name, anchor: "flow", frame: { x: 0, y: 0, w: 420, h }, props: {}, children: []
  });
  const header = child("pricing_header", "li_header", 22);
  const items = child("pricing_items", "Line items", 120);
  const totals = child("pricing_totals", "li_totals", 60);
  const stack = M.createNode("frame", {
    id: "pricing_stack",
    frame: { x: 72, y: 100, w: 420, h: 260, layout: "flow" },
    props: { flow: { direction: "column", gap: 6, padding: [0, 0, 0, 0] } },
    children: [header, items, totals]
  });
  doc.pages[0].children = [stack];
  const theme = {
    tokens: { spacing: { page_margin_pt: 40 } },
    page_masters: [{ match: { role: "*" }, content_inset: { top: 48, right: 48, bottom: 48, left: 116 }, chrome: [] }]
  };
  const componentDoc = M.createDocument({ first_page_role: "body" });
  componentDoc.components = {
    li_header: { params: {}, root: M.createNode("frame", { frame: { x: 0, y: 0, w: 500, h: 22 }, props: {}, children: [M.createNode("text", { frame: { x: 300, y: 0, w: 180, h: 20 }, props: { blocks: [] } })] }) }
  };
  componentDoc.pages[0].children = [M.createNode("component_ref", { frame: { x: 72, y: 80, w: 400, h: 22 }, props: { component: "li_header" } })];
  const fittedComponent = M.resolveBindings(componentDoc, {}).pages[0].children[0];
  const componentWidths = { root: fittedComponent.frame.w, childX: fittedComponent.children[0].frame.x, childW: fittedComponent.children[0].frame.w };
  window.editor = window.FMDocEditor.mount(document.getElementById("editor"), { document: doc, theme, profile: "designer", mode: "visual" });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const relativeX = () => {
    const node = document.querySelector('[data-node-id="pricing_stack"]');
    const pageEl = node?.closest(".fmdoc-page");
    if (!node || !pageEl) return null;
    return (node.getBoundingClientRect().left - pageEl.getBoundingClientRect().left) / (96 / 72);
  };
  const visualX = relativeX();
  window.editor.setMode("preview");
  await new Promise((resolve) => setTimeout(resolve, 120));
  const previewX = relativeX();
  const outputHost = document.createElement("div");
  outputHost.style.cssText = "position:fixed;left:-10000px;top:0";
  document.body.appendChild(outputHost);
  const outputHandle = window.FMDocRenderer.render(outputHost, { document: M.deepClone(doc), theme, mode: "static", scale: 1 });
  await outputHandle.ready();
  const outputX = outputHandle.measureNode("pricing_stack")?.x;
  outputHandle.destroy();
  outputHost.remove();
  window.editor.setMode("visual");
  await new Promise((resolve) => setTimeout(resolve, 120));
  window.editor.select(["pricing_items"]);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const handle = document.querySelector('[data-fmde-selbox="pricing_items"] [data-fmde-handle="e"]');
  const rect = handle?.getBoundingClientRect();
  return { visualX, previewX, outputX, componentWidths, authoredX: window.editor.getDocument().pages[0].children[0].frame.x, handle: rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null };
});
check("Visual, Preview and generated output use the same authored left position", layoutDoc.authoredX === 72 && layoutDoc.outputX === 72 && Math.abs(layoutDoc.previewX - layoutDoc.visualX) < 0.5, layoutDoc);
check("component inner columns scale with their assigned instance width", layoutDoc.componentWidths.root === 400 && layoutDoc.componentWidths.childX === 240 && layoutDoc.componentWidths.childW === 144, layoutDoc.componentWidths);
if (layoutDoc.handle) {
  await page.mouse.move(layoutDoc.handle.x, layoutDoc.handle.y);
  await page.mouse.down();
  await page.mouse.move(layoutDoc.handle.x - 20, layoutDoc.handle.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(180);
}
const linkedWidths = await page.evaluate(() => {
  const stack = window.editor.getDocument().pages[0].children[0];
  return { parent: stack.frame.w, children: stack.children.map((node) => node.frame.w) };
});
check("resizing a flow-table member updates its header, rows, totals and parent", !!layoutDoc.handle && linkedWidths.parent < 420 && linkedWidths.parent > 100 && linkedWidths.children.every((width) => Math.abs(width - linkedWidths.parent) < 0.01), linkedWidths);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("failed: " + failed.map((f) => f.name).join("; ")); process.exit(1); }
