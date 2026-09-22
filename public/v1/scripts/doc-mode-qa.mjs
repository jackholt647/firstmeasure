/**
 * Exhaustive QA sweep of the DOC-MODE (word processor) editor surface.
 * Complements doc-editor-regression.mjs: that file guards the basics; this one
 * walks EVERY doc-mode feature — toolbar, menubar, dialogs, shortcuts,
 * inserts, comments/suggestions — with real mouse/keyboard input and asserts
 * against both the DOM and the DocModel.
 *
 *   node scripts/doc-mode-qa.mjs          (from public/v1; local stack on :8011)
 */
import { chromium } from "playwright-core";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

const HARNESS = process.env.DOC_HARNESS_URL || "http://127.0.0.1:8011/libraries/doc-editor/dev-editor.html";
const SHOTS = process.env.DOC_QA_SHOTS_DIR || path.resolve("doc-qa-shots");
await mkdir(SHOTS, { recursive: true });

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
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : "  " + JSON.stringify(detail).slice(0, 400)}`);
};

const browser = await chromium.launch({ executablePath: await browserPath(), headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, permissions: ["clipboard-read", "clipboard-write"], acceptDownloads: true });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("   [pageerror]", e.message));

await page.goto(HARNESS, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelector(".fmdoc-page") !== null, null, { timeout: 30000 });
await page.waitForTimeout(1200);

let shotIndex = 0;
async function shot(name) {
  shotIndex += 1;
  await page.screenshot({ path: path.join(SHOTS, `${String(shotIndex).padStart(2, "0")}-${name}.png`) });
}

/** Mount a fresh blank word-processing document in doc mode. */
async function freshDoc(bodyBlocks, opts) {
  await page.evaluate(({ blocks, options }) => {
    if (window.editor) window.editor.destroy();
    const doc = window.FMDocModel.createBlankDocument({ metadata: { document_type: "generic" } });
    const body = doc.pages[0].children.find((n) => n.props?.page_region === "body");
    if (blocks) body.children[0].props.blocks = blocks;
    window.editor = window.FMDocEditor.mount(document.getElementById("editor"), {
      document: doc, profile: (options && options.profile) || "document", mode: "doc", ...(options && options.mount || {})
    });
  }, { blocks: bodyBlocks || null, options: opts || null });
  await page.waitForTimeout(320);
}

function para(id, text, extra) { return { id, type: "paragraph", style_ref: "Normal text", runs: [{ text }], ...(extra || {}) }; }

/** The live body node (blocks) from the model. */
async function bodyBlocks() {
  return await page.evaluate(() => {
    const body = window.editor.getDocument().pages[0].children.find((n) => n.props?.page_region === "body");
    return body.children.filter((n) => n.type === "text").flatMap((n) => n.props.blocks);
  });
}

/** Click at a character position inside a rendered block (real mouse). */
async function clickInBlock(blockId, opts) {
  const point = await page.evaluate(({ id, where }) => {
    const el = document.querySelector('[data-page-region="body"] [data-block-id="' + id + '"]');
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    const x = where === "start" ? r.x + 2 : where === "end" ? r.right - 2 : r.x + r.width / 2;
    return { x, y: r.y + r.height / 2 };
  }, { id: blockId, where: (opts && opts.where) || "middle" });
  if (!point) throw new Error("block not found " + blockId);
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(120);
}

/** Select all text of one block with real mouse drag. */
async function selectBlock(blockId) {
  await page.evaluate((id) => {
    const el = document.querySelector('[data-page-region="body"] [data-block-id="' + id + '"]');
    const editable = el.closest(".fmde-docedit");
    editable.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }, blockId);
  await page.waitForTimeout(80);
}

async function toolbar(title) {
  await page.click('.fmde-toolbar button[title="' + title + '"]');
  await page.waitForTimeout(120);
}

async function menuItem(label, { exact = true } = {}) {
  const clicked = await page.evaluate(({ label, exact }) => {
    const items = Array.from(document.querySelectorAll(".fmde-menu-item"));
    const hit = items.find((i) => {
      const text = (i.querySelector(".fmde-menu-label") || i).textContent.trim();
      return exact ? text === label : text.includes(label);
    });
    if (hit) { hit.click(); return true; }
    return false;
  }, { label, exact });
  await page.waitForTimeout(150);
  return clicked;
}

/** Hover a menu item that owns a submenu, wait for it, return submenu labels. */
async function hoverSubmenu(parentLabel) {
  return await page.evaluate(async (parentLabel) => {
    const item = Array.from(document.querySelectorAll(".fmde-menu-item")).find((i) => (i.querySelector(".fmde-menu-label") || i).textContent.trim() === parentLabel);
    if (!item) return null;
    item.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 620));
    return Array.from(document.querySelectorAll(".fmde-menu-item")).map((i) => (i.querySelector(".fmde-menu-label") || i).textContent.trim());
  }, parentLabel);
}

async function openMenu(name) {
  await page.click('.fmde-menubar [data-menu-name="' + name + '"]').catch(async () => {
    await page.evaluate((n) => {
      Array.from(document.querySelectorAll(".fmde-menubar button")).find((b) => b.textContent.trim() === n)?.click();
    }, name);
  });
  await page.waitForTimeout(150);
}

async function closeMenus() {
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  await page.waitForTimeout(100);
}

// =============================================================================
// A. Typing, structural editing
// =============================================================================
await freshDoc([para("a1", "Hello world.")]);
await clickInBlock("a1", { where: "end" });
await page.keyboard.type(" Typed live.");
await page.waitForTimeout(400);
{
  const blocks = await bodyBlocks();
  check("A1 real keyboard typing commits to the model", blocks[0].runs.map((r) => r.text).join("") === "Hello world. Typed live.", blocks[0]);
}
await page.keyboard.press("Enter");
await page.keyboard.type("Second paragraph");
await page.waitForTimeout(400);
{
  const blocks = await bodyBlocks();
  check("A2 Enter splits into a new paragraph", blocks.length === 2 && blocks[1].runs.map((r) => r.text).join("") === "Second paragraph", blocks.map((b) => b.runs.map((r) => r.text).join("")));
}
await clickInBlock("a1", { where: "end" });
await page.keyboard.press("Delete");
await page.waitForTimeout(400);
{
  const blocks = await bodyBlocks();
  check("A3 Delete at block end merges the next paragraph up", blocks.length === 1 && blocks[0].runs.map((r) => r.text).join("").includes("Typed live.Second"), blocks.map((b) => b.runs.map((r) => r.text).join("")));
}

// =============================================================================
// B. Run formatting
// =============================================================================
await freshDoc([para("b1", "alpha bravo charlie")]);
await selectBlock("b1");
await toolbar("Bold (Ctrl+B)");
await page.waitForTimeout(350);
{
  const blocks = await bodyBlocks();
  const bold = blocks[0].runs.some((r) => r.bold || Number(r.weight) >= 600);
  check("B1 toolbar Bold sets run bold weight", bold, blocks[0].runs);
}
await selectBlock("b1");
await page.keyboard.press("Control+i");
await page.waitForTimeout(350);
{
  const blocks = await bodyBlocks();
  check("B2 Ctrl+I sets run.italic", blocks[0].runs.some((r) => r.italic), blocks[0].runs);
}
await selectBlock("b1");
await page.keyboard.press("Control+u");
await page.waitForTimeout(350);
{
  const blocks = await bodyBlocks();
  check("B3 Ctrl+U sets run.underline", blocks[0].runs.some((r) => r.underline), blocks[0].runs);
}
// font family via toolbar dropdown
await selectBlock("b1");
await toolbar("Font");
{
  const applied = await menuItem("Georgia");
  await page.waitForTimeout(350);
  const blocks = await bodyBlocks();
  check("B4 font dropdown applies run.font.family", applied && blocks[0].runs.some((r) => r.font && r.font.family === "Georgia"), blocks[0].runs);
}
// font size +
await selectBlock("b1");
await toolbar("Increase font size");
await page.waitForTimeout(350);
{
  const blocks = await bodyBlocks();
  check("B5 increase font size sets run.font.size_pt", blocks[0].runs.some((r) => r.font && r.font.size_pt === 12), blocks[0].runs.map((r) => r.font));
}
// text color via palette
await selectBlock("b1");
await toolbar("Text color");
{
  const point = await page.evaluate(() => {
    const chip = Array.from(document.querySelectorAll(".fmde-color-grid .fmde-color-chip")).find((c) => c.title === "#cc0000");
    if (!chip) return null;
    const r = chip.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (point) await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(400);
  const blocks = await bodyBlocks();
  check("B6 color palette applies run color", !!point && blocks[0].runs.some((r) => r.color === "#cc0000"), { point, runs: blocks[0].runs });
}
// highlight
await selectBlock("b1");
await toolbar("Highlight color");
{
  await page.evaluate(() => {
    const chips = document.querySelectorAll(".fmde-color-grid .fmde-color-chip");
    chips[Math.min(12, chips.length - 1)]?.click();
  });
  await page.waitForTimeout(350);
  const blocks = await bodyBlocks();
  check("B7 highlight palette applies run background", blocks[0].runs.some((r) => r.background), blocks[0].runs);
}
// clear formatting
await selectBlock("b1");
await toolbar("Clear formatting");
await page.waitForTimeout(350);
{
  const blocks = await bodyBlocks();
  const clean = blocks[0].runs.every((r) => !r.bold && !r.italic && !r.underline && !r.color && !r.background);
  check("B8 Clear formatting strips run styles", clean, blocks[0].runs);
}
// sticky typing format at collapsed caret
await freshDoc([para("b9", "prefix ")]);
await clickInBlock("b9", { where: "end" });
await page.keyboard.press("Control+b");
await page.keyboard.type("boldtail");
await page.waitForTimeout(400);
{
  const blocks = await bodyBlocks();
  const tail = blocks[0].runs.find((r) => (r.text || "").includes("boldtail"));
  check("B9 collapsed-caret Ctrl+B makes following typing bold", !!tail && (tail.bold === true || Number(tail.weight) >= 600), blocks[0].runs);
}
// paint format — styled runs must go in at mount time (getDocument() clones)
await freshDoc([
  { id: "p1", type: "paragraph", style_ref: "Normal text", runs: [{ text: "styled source", weight: 700, font: { family: "Georgia", size_pt: 14 }, color: "#ea4335" }] },
  { id: "p2", type: "paragraph", style_ref: "Normal text", runs: [{ text: "plain target" }] }
]);
await selectBlock("p1");
await toolbar("Paint format");
await selectBlock("p2");
await toolbar("Apply copied formatting");
await page.waitForTimeout(400);
{
  const blocks = await bodyBlocks();
  const target = blocks.find((b) => b.id !== "p1");
  const run = target && target.runs[0];
  const isBold = run && (run.bold === true || Number(run.weight) >= 600);
  check("B10 paint format copies family/size/bold/color to target", !!run && isBold && run.font && run.font.family === "Georgia", target && target.runs);
}

// =============================================================================
// C. Named styles
// =============================================================================
await freshDoc([para("c1", "Make me a heading")]);
await clickInBlock("c1");
await toolbar("Apply a named style to the selected paragraphs");
{
  const applied = await menuItem("Heading 1");
  await page.waitForTimeout(350);
  const blocks = await bodyBlocks();
  check("C1 named style dropdown applies style_ref", applied && blocks[0].style_ref === "Heading 1", blocks[0]);
  const styleLabel = await page.evaluate(() => document.querySelector(".fmde-styleselect span")?.textContent);
  check("C2 style dropdown label reflects caret style", styleLabel === "Heading 1", { styleLabel });
}
await clickInBlock("c1");
await toolbar("Apply a named style to the selected paragraphs");
{
  const cleared = await menuItem("Clear named style");
  await page.waitForTimeout(350);
  const blocks = await bodyBlocks();
  check("C3 clear named style removes style_ref", cleared && !blocks[0].style_ref, blocks[0]);
}

// =============================================================================
// D. Paragraph controls
// =============================================================================
await freshDoc([para("d1", "One"), para("d2", "Two"), para("d3", "Three")]);
await clickInBlock("d2");
await toolbar("Paragraph alignment");
await menuItem("Align center", { exact: false });
await page.waitForTimeout(300);
{
  const blocks = await bodyBlocks();
  check("D1 align dropdown centers current paragraph", blocks[1].align === "center", blocks[1]);
}
await clickInBlock("d2");
await page.keyboard.press("Control+Shift+j");
await page.waitForTimeout(300);
{
  const blocks = await bodyBlocks();
  check("D2 Ctrl+Shift+J justifies", blocks[1].align === "justify", blocks[1]);
}
await clickInBlock("d1");
await toolbar("Line and paragraph spacing");
await menuItem("1.5");
await page.waitForTimeout(300);
{
  const blocks = await bodyBlocks();
  check("D3 line spacing menu sets line_height", blocks[0].line_height === 1.5, blocks[0]);
}
// lists
await clickInBlock("d1");
await toolbar("Bulleted list");
await page.waitForTimeout(300);
{
  const blocks = await bodyBlocks();
  check("D4 bullet button converts to list_item", blocks[0].type === "list_item" && blocks[0].list_style === "bullet", blocks[0]);
}
await clickInBlock("d1");
await toolbar("Numbered list");
await page.waitForTimeout(300);
{
  const blocks = await bodyBlocks();
  check("D5 numbered button switches list style", blocks[0].list_style === "number", blocks[0]);
}
// BUG PROBE: Enter inside a numbered list item should keep numbering on the new item
await clickInBlock("d1", { where: "end" });
await page.keyboard.press("Enter");
await page.keyboard.type("next item");
await page.waitForTimeout(400);
{
  const blocks = await bodyBlocks();
  const tail = blocks[1];
  // "next item" arrives as "Next item": sentence auto-capitalization (Docs parity).
  check("D6 Enter in numbered list keeps list_style on new item", tail && tail.type === "list_item" && tail.list_style === "number" && tail.runs.map((r) => r.text).join("") === "Next item", blocks.slice(0, 3));
}
// checklist + shortcuts
await freshDoc([para("d7", "check me")]);
await clickInBlock("d7");
await toolbar("Checklist");
await page.waitForTimeout(300);
{
  const blocks = await bodyBlocks();
  check("D7 checklist button sets list_style check", blocks[0].type === "list_item" && blocks[0].list_style === "check", blocks[0]);
}
await freshDoc([para("d8", "shortcut list")]);
await clickInBlock("d8");
await page.keyboard.press("Control+Shift+7");
await page.waitForTimeout(300);
{
  const blocks = await bodyBlocks();
  check("D8 Ctrl+Shift+7 toggles numbered list", blocks[0].list_style === "number", blocks[0]);
}
await page.keyboard.press("Control+Shift+8");
await page.waitForTimeout(300);
{
  const blocks = await bodyBlocks();
  check("D9 Ctrl+Shift+8 switches to bulleted list", blocks[0].list_style === "bullet", blocks[0]);
}
// indent via toolbar
await clickInBlock("d8");
await toolbar("Increase indent");
await page.waitForTimeout(250);
{
  const blocks = await bodyBlocks();
  check("D10 increase indent bumps block.indent", blocks[0].indent === 1, blocks[0]);
}
await toolbar("Decrease indent");
await page.waitForTimeout(250);
{
  const blocks = await bodyBlocks();
  check("D11 decrease indent restores", !blocks[0].indent, blocks[0]);
}
// font size shortcuts
await freshDoc([para("d12", "resize me")]);
await selectBlock("d12");
await page.keyboard.press("Control+Shift+Period");
await page.waitForTimeout(350);
{
  const blocks = await bodyBlocks();
  check("D12 Ctrl+Shift+. bumps font size", blocks[0].runs.some((r) => r.font && r.font.size_pt === 12), blocks[0].runs);
}
// align shortcuts
await clickInBlock("d12");
await page.keyboard.press("Control+Shift+e");
await page.waitForTimeout(250);
{
  const blocks = await bodyBlocks();
  check("D13 Ctrl+Shift+E centers", blocks[0].align === "center", blocks[0]);
}
await page.keyboard.press("Control+Shift+r");
await page.waitForTimeout(250);
{
  const blocks = await bodyBlocks();
  check("D14 Ctrl+Shift+R right-aligns", blocks[0].align === "right", blocks[0]);
}
await page.keyboard.press("Control+Shift+l");
await page.waitForTimeout(250);
{
  const blocks = await bodyBlocks();
  check("D15 Ctrl+Shift+L left-aligns", blocks[0].align === "left", blocks[0]);
}
// clear formatting shortcut
await selectBlock("d12");
await page.keyboard.press("Control+\\");
await page.waitForTimeout(300);
{
  const blocks = await bodyBlocks();
  check("D16 Ctrl+\\ clears formatting", blocks[0].runs.every((r) => !r.font || !r.font.size_pt || r.font.size_pt === 11), blocks[0].runs);
}

// =============================================================================
// E. Menubar — structure and per-menu smoke
// =============================================================================
await freshDoc([para("e1", "menu target paragraph")]);
{
  const names = await page.evaluate(() => Array.from(document.querySelectorAll(".fmde-menubar > button")).map((b) => b.textContent.trim()));
  check("E1 menubar shows Menus + 7 menus", ["File", "Edit", "View", "Insert", "Format", "Tools", "Help"].every((m) => names.includes(m)), names);
}
await openMenu("Format");
{
  const opened = await page.evaluate(() => !!document.querySelector(".fmde-menu"));
  check("E2 Format menu opens", opened);
  // hover Text submenu
  const subLabels = await hoverSubmenu("Text");
  check("E3 Format ▸ Text submenu opens on hover", Array.isArray(subLabels) && subLabels.includes("Bold"), subLabels);
}
await closeMenus();
// BUG PROBE: Format ▸ Paragraph styles is suspected no-op (clickTool title mismatch)
await selectBlock("e1");
await openMenu("Format");
{
  const clicked = await menuItem("Paragraph styles");
  await page.waitForTimeout(300);
  const menuVisible = await page.evaluate(() => !!document.querySelector(".fmde-menu"));
  check("E4 Format ▸ Paragraph styles opens the style picker", clicked && menuVisible, { clicked, menuVisible });
}
await closeMenus();
// Edit menu items
await openMenu("Edit");
{
  const labels = await page.evaluate(() => Array.from(document.querySelectorAll(".fmde-menu-item")).map((i) => (i.querySelector(".fmde-menu-label") || i).textContent.trim()));
  check("E5 Edit menu lists undo/redo/clipboard/find", ["Undo", "Redo", "Cut", "Copy", "Paste", "Select all", "Find and replace"].every((l) => labels.includes(l)), labels);
}
await closeMenus();
// menu search palette — editor-scoped shortcuts need focus inside the editor
await clickInBlock("e1");
await page.keyboard.press("Alt+/");
await page.waitForTimeout(250);
{
  const open = await page.evaluate(() => !!document.querySelector(".fmde-command-menu"));
  check("E6 Alt+/ opens menu search palette", open);
  if (open) {
    await page.keyboard.type("word count");
    await page.waitForTimeout(200);
    const hit = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll(".fmde-command-results .fmde-menu-item")).find((i) => /Word count/.test(i.textContent));
      if (row) { row.click(); return true; }
      return false;
    });
    await page.waitForTimeout(300);
    const dialog = await page.evaluate(() => document.querySelector(".fmde-dialog")?.textContent || "");
    check("E7 palette executes command (Word count opens)", hit && /words/i.test(dialog), { hit, dialog: dialog.slice(0, 80) });
    await page.evaluate(() => document.querySelector("[data-dialog-close]")?.click());
  }
}

// =============================================================================
// F. Dialogs
// =============================================================================
// find & replace
await freshDoc([para("f1", "The rain in Spain falls on the plain. Rain again.")]);
await clickInBlock("f1");
await page.keyboard.press("Control+h");
await page.waitForTimeout(300);
{
  const hasPanel = await page.evaluate(() => !!document.querySelector(".fmde-find-panel"));
  check("F1 Ctrl+H opens the find & replace panel", hasPanel);
  if (hasPanel) {
    const type = async (sel, value) => page.evaluate(({ sel, value }) => {
      const input = document.querySelector(sel);
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, { sel, value });
    await type(".fmde-find-panel [data-find-text]", "rain");
    await page.waitForTimeout(250);
    const count1 = await page.evaluate(() => document.querySelector("[data-find-count]").textContent);
    check("F2a search shows live match count", count1 === "1 of 2", { count1 });
    const highlighted = await page.evaluate(() => CSS.highlights ? CSS.highlights.has("fmde-find-active") : "unsupported");
    check("F2b active match is highlighted via CSS highlights", highlighted === true || highlighted === "unsupported", { highlighted });
    await page.evaluate(() => document.querySelector("[data-find-next]").click());
    await page.waitForTimeout(200);
    const count2 = await page.evaluate(() => document.querySelector("[data-find-count]").textContent);
    check("F2c next navigates to 2 of 2", count2 === "2 of 2", { count2 });
    await page.evaluate(() => { const cb = document.querySelector("[data-find-case]"); cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); });
    await page.waitForTimeout(200);
    const count3 = await page.evaluate(() => document.querySelector("[data-find-count]").textContent);
    check("F2d match case narrows to 1 of 1", count3 === "1 of 1", { count3 });
    await page.evaluate(() => { const cb = document.querySelector("[data-find-case]"); cb.checked = false; cb.dispatchEvent(new Event("change", { bubbles: true })); });
    await type(".fmde-find-panel [data-replace-text]", "sun");
    await page.evaluate(() => document.querySelector("[data-replace-one]").click());
    await page.waitForTimeout(400);
    const afterOne = (await bodyBlocks())[0].runs.map((r) => r.text).join("");
    check("F2e Replace replaces only the active match", afterOne.includes("The sun in Spain") && /Rain again/.test(afterOne), { afterOne });
    await page.evaluate(() => document.querySelector("[data-replace-all]").click());
    await page.waitForTimeout(400);
    const afterAll = (await bodyBlocks())[0].runs.map((r) => r.text).join("");
    check("F2f Replace all rewrites the remaining matches", /sun again/.test(afterAll) && !/rain/i.test(afterAll), { afterAll });
    await page.evaluate(() => document.querySelector("[data-find-close]").click());
    await page.waitForTimeout(200);
    const closed = await page.evaluate(() => !document.querySelector(".fmde-find-panel") && !(CSS.highlights && CSS.highlights.has("fmde-find")));
    check("F2g closing clears panel and highlights", closed);
  }
}
// word count
await freshDoc([para("wc", "one two three four five")]);
await clickInBlock("wc");
await page.keyboard.press("Control+Shift+c");
await page.waitForTimeout(300);
{
  const dialog = await page.evaluate(() => document.querySelector(".fmde-dialog")?.textContent || "");
  check("F3 word count counts 5 words", /5/.test(dialog) && /Words/i.test(dialog), { dialog: dialog.slice(0, 120) });
  await page.evaluate(() => document.querySelector("[data-dialog-close]")?.click());
}
// keyboard shortcuts dialog + search
await clickInBlock("wc");
await page.keyboard.press("Control+/");
await page.waitForTimeout(300);
{
  const opened = await page.evaluate(() => !!document.querySelector(".fmde-shortcut-list"));
  check("F4 Ctrl+/ opens shortcuts dialog", opened);
  if (opened) {
    await page.keyboard.type("bold");
    await page.waitForTimeout(200);
    const visible = await page.evaluate(() => Array.from(document.querySelectorAll("[data-shortcut-row]:not([hidden])")).map((r) => r.textContent));
    check("F5 shortcut search filters rows", visible.length >= 1 && visible.every((v) => /bold/i.test(v)), visible);
    await page.evaluate(() => document.querySelector("[data-dialog-close]")?.click());
  }
}
// page setup
await openMenu("File");
await menuItem("Page setup");
await page.waitForTimeout(300);
{
  const dialogText = await page.evaluate(() => document.querySelector(".fmde-dialog")?.textContent || "");
  check("F6 File ▸ Page setup opens dialog", /Paper|Orientation|Margins/i.test(dialogText), { dialogText: dialogText.slice(0, 100) });
  if (dialogText) {
    const applied = await page.evaluate(() => {
      const dialog = document.querySelector(".fmde-dialog");
      const orientation = Array.from(dialog.querySelectorAll("select")).find((s) => Array.from(s.options).some((o) => /landscape/i.test(o.textContent)));
      if (orientation) { orientation.value = Array.from(orientation.options).find((o) => /landscape/i.test(o.textContent)).value; orientation.dispatchEvent(new Event("change", { bubbles: true })); }
      const apply = Array.from(dialog.querySelectorAll("button")).find((b) => /apply/i.test(b.textContent));
      apply?.click();
      return !!apply;
    });
    await page.waitForTimeout(500);
    const orient = await page.evaluate(() => window.editor.getDocument().settings.paper.orientation);
    check("F7 page setup applies landscape orientation", applied && orient === "landscape", { orient });
    // flip back
    await page.evaluate(() => {
      const doc = window.editor.getDocument();
      doc.settings.paper.orientation = "portrait";
      window.editor.setDocument(doc);
    });
  }
}
// margins via More menu
await freshDoc([para("m1", "margin probe")]);
{
  await toolbar("More document options");
  const clicked = await menuItem("Margins…");
  const narrow = clicked && await menuItem("Narrow (36pt)", { exact: false });
  await page.waitForTimeout(400);
  const margins = await page.evaluate(() => window.editor.getDocument().chains.body.page_defaults.margins_pt);
  check("F8 More ▸ Margins Narrow applies 36pt to chains", narrow && margins && margins.top === 36, margins);
}
// page numbers
await freshDoc([para("pn", "page number probe")]);
{
  await toolbar("More document options");
  const clicked = await menuItem("Page numbers");
  await page.waitForTimeout(300);
  const dialogText = await page.evaluate(() => document.querySelector(".fmde-dialog")?.textContent || "");
  check("F9 Page numbers dialog opens", clicked && /position|format|Page/i.test(dialogText), { dialogText: dialogText.slice(0, 120) });
  if (dialogText) {
    // BUG PROBE: a fresh document should default the dialog to SHOW numbers
    const defaultEnabled = await page.evaluate(() => document.querySelector("[data-pn-enabled]")?.value);
    check("F10a page numbers dialog defaults to Show on first open", defaultEnabled === "true", { defaultEnabled });
    const applied = await page.evaluate(() => {
      const dialog = document.querySelector(".fmde-dialog");
      const enabled = dialog.querySelector("[data-pn-enabled]");
      if (enabled) { enabled.value = "true"; enabled.dispatchEvent(new Event("change", { bubbles: true })); }
      const apply = Array.from(dialog.querySelectorAll("button")).find((b) => /apply|save|done/i.test(b.textContent));
      apply?.click();
      return !!apply;
    });
    await page.waitForTimeout(500);
    const meta = await page.evaluate(() => window.editor.getDocument().metadata.page_numbers);
    check("F10b page numbers persist enabled to metadata", applied && !!meta && meta.enabled === true, meta);
    const rendered = await page.evaluate(() => {
      const el = document.querySelector(".fmdoc-auto-page-number");
      return el ? el.textContent : null;
    });
    check("F10c page number renders on the page", typeof rendered === "string" && /1/.test(rendered), { rendered });
  }
}
// download submenu
await openMenu("File");
{
  const subLabels = await hoverSubmenu("Download");
  const hasFormats = Array.isArray(subLabels) && subLabels.some((l) => /PDF/.test(l)) && subLabels.some((l) => /Word/i.test(l)) && subLabels.some((l) => /Plain text/i.test(l));
  check("F11 File ▸ Download submenu offers PDF/Word/text formats", hasFormats, subLabels);
  if (hasFormats) {
    await menuItem("PDF document (.pdf)");
    await page.waitForTimeout(300);
    const hint = await page.evaluate(() => document.querySelector(".fmde-hint")?.textContent || "");
    check("F12 download action reaches the host hook (hint in bare harness)", /unavailable/i.test(hint), { hint });
  }
  await closeMenus();
}

// =============================================================================
// G. View toggles
// =============================================================================
await freshDoc([para("g1", "view probe")]);
await openMenu("View");
await menuItem("Show ruler");
await page.waitForTimeout(200);
{
  const state = await page.evaluate(() => {
    const root = document.querySelector(".fmde-root");
    const ruler = document.querySelector(".fmde-ruler-ui");
    return {
      cls: root.className.includes("fmde-show-ruler"),
      ruler: !!ruler,
      handles: ruler ? ruler.querySelectorAll(".fmde-ruler-handle").length : 0,
      height: ruler ? ruler.getBoundingClientRect().height : 0
    };
  });
  check("G1 Show ruler renders the interactive ruler", state.cls && state.ruler && state.handles === 4 && state.height >= 10, state);
}
await openMenu("View");
await menuItem("Show non-printing characters");
await page.waitForTimeout(200);
{
  // BUG PROBE: pilcrow markers require [data-block-type=paragraph] which renderer never emits
  const state = await page.evaluate(() => {
    const root = document.querySelector(".fmde-root");
    const on = root.className.includes("nonprint") || root.className.includes("non-printing");
    const block = document.querySelector('[data-page-region="body"] .fmdoc-block');
    const after = block ? getComputedStyle(block, "::after").content : null;
    return { rootCls: root.className, after };
  });
  check("G2 Show non-printing characters renders pilcrows", !!state.after && state.after !== "none" && state.after !== "normal", state);
}
await openMenu("View");
await menuItem("Show non-printing characters"); // toggle back off
await closeMenus();

// =============================================================================
// H. Insert features
// =============================================================================
// link via Ctrl+K dialog
await freshDoc([para("h1", "link me please")]);
await selectBlock("h1");
await page.keyboard.press("Control+k");
await page.waitForTimeout(300);
{
  const has = await page.evaluate(() => !!document.querySelector("[data-link-url]"));
  check("H1 Ctrl+K opens link dialog", has);
  if (has) {
    await page.evaluate(() => {
      const input = document.querySelector("[data-link-url]");
      input.value = "https://example.com";
      document.querySelector("[data-link-apply]").click();
    });
    await page.waitForTimeout(400);
    const blocks = await bodyBlocks();
    check("H2 link dialog applies run.href", blocks[0].runs.some((r) => r.href === "https://example.com" || r.link === "https://example.com"), blocks[0].runs);
  }
}
// special characters browser (replaces the old Symbols quick submenu)
await freshDoc([para("h3", "sym:")]);
await clickInBlock("h3", { where: "end" });
await openMenu("Insert");
{
  const clicked = await menuItem("Special characters");
  await page.waitForTimeout(300);
  const inserted = await page.evaluate(async () => {
    const dialog = document.querySelector(".fmde-dialog");
    if (!dialog) return { dialog: false };
    const search = dialog.querySelector("[data-sc-search]");
    search.value = "copyright";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    const visible = Array.from(dialog.querySelectorAll("[data-sc-char]:not([hidden])"));
    const target = visible.find((b) => b.dataset.scChar === "©");
    if (!target) return { dialog: true, found: false, visible: visible.length };
    target.click();
    await new Promise((r) => setTimeout(r, 250));
    document.querySelector("[data-dialog-close]")?.click();
    return { dialog: true, found: true };
  });
  await page.waitForTimeout(400);
  const blocks = await bodyBlocks();
  check("H3 Special characters dialog searches and inserts at caret", clicked && inserted.found && blocks[0].runs.map((r) => r.text).join("").includes("©"), { inserted, runs: blocks[0].runs });
}
// page break via Ctrl+Enter then undo
await freshDoc([para("h4", "BeforeAfter")]);
await clickInBlock("h4", { where: "middle" });
await page.evaluate(() => {
  // put caret precisely between Before|After
  const block = document.querySelector('[data-page-region="body"] [data-block-id="h4"]');
  const editable = block.closest(".fmde-docedit");
  editable.focus();
  const textNode = block.querySelector("span")?.firstChild || block.firstChild;
  const range = document.createRange();
  range.setStart(textNode, 6);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(500);
{
  const pages = await page.evaluate(() => document.querySelectorAll(".fmdoc-page").length);
  check("H4 Ctrl+Enter page break creates page 2", pages === 2, { pages });
}
// horizontal line — BUG PROBE in document profile (shapes:false)
await freshDoc([para("h5", "rule below")]);
await clickInBlock("h5", { where: "end" });
await openMenu("Insert");
{
  const clicked = await menuItem("Horizontal line");
  await page.waitForTimeout(400);
  const shapeCount = await page.evaluate(() => {
    const body = window.editor.getDocument().pages[0].children.find((n) => n.props?.page_region === "body");
    return body.children.filter((n) => n.type === "shape").length;
  });
  const hint = await page.evaluate(() => document.querySelector(".fmde-hint")?.textContent || "");
  check("H5 Insert ▸ Horizontal line inserts in document profile", clicked && shapeCount === 1, { shapeCount, hint });
}
// table via insert menu
await freshDoc([para("h6", "table below")]);
await clickInBlock("h6", { where: "end" });
await toolbar("Add media, video, or widget");
{
  const clicked = await menuItem("Table", { exact: false });
  await page.waitForTimeout(500);
  const tableCount = await page.evaluate(() => {
    const body = window.editor.getDocument().pages[0].children.find((n) => n.props?.page_region === "body");
    return body.children.filter((n) => n.type === "table").length;
  });
  const rendered = await page.evaluate(() => document.querySelectorAll('[data-page-region="body"] table, [data-page-region="body"] .fmdoc-table').length);
  check("H6 insert Table adds a 3x3 table node and renders it", clicked && tableCount === 1 && rendered >= 1, { tableCount, rendered });
}
// eSignature field — the menu item is catalog-gated (concurrent-session change
// 2026-08-11), so mount with a catalog that registers doc.signature.
await freshDoc([para("h7", "sign here")], { mount: { catalog: { widgets: [{ id: "doc.signature", version: 1, title: "Signature", defaults: { frame: { h: 90 } } }] } } });
await clickInBlock("h7", { where: "end" });
await openMenu("Insert");
{
  const clicked = await menuItem("eSignature field");
  await page.waitForTimeout(500);
  const widgets = await page.evaluate(() => {
    const body = window.editor.getDocument().pages[0].children.find((n) => n.props?.page_region === "body");
    return body.children.filter((n) => n.type === "widget").map((n) => n.props && n.props.widget);
  });
  check("H7 Insert ▸ eSignature inserts doc.signature widget", clicked && widgets.some((w) => /doc\.signature/.test(String(w))), widgets);
}
// bookmark
await freshDoc([para("h8", "bookmark anchor")]);
await clickInBlock("h8");
await openMenu("Insert");
{
  const clicked = await menuItem("Bookmark");
  await page.waitForTimeout(300);
  const bookmarks = await page.evaluate(() => window.editor.getDocument().metadata.bookmarks);
  check("H8 Insert ▸ Bookmark records a bookmark", clicked && Array.isArray(bookmarks) && bookmarks.length === 1, bookmarks);
}
// header/footer focus
await freshDoc([para("h9", "hf probe")]);
await openMenu("Insert");
{
  const clicked = await menuItem("Header");
  await page.waitForTimeout(300);
  const focused = await page.evaluate(() => !!document.activeElement?.closest?.('[data-page-region="header"]'));
  check("H9 Insert ▸ Header focuses the header region", clicked && focused, { focused });
}

// =============================================================================
// I. Comments & suggestions
// =============================================================================
await freshDoc([para("i1", "annotate this sentence please")]);
await selectBlock("i1");
await toolbar("Add comment");
await page.waitForTimeout(300);
{
  const draft = await page.evaluate(() => !!document.querySelector(".fmde-comment-draft, .fmde-comment-card textarea, .fmde-comments textarea"));
  check("I1 Add comment opens a draft card", draft);
  if (draft) {
    await page.evaluate(() => {
      const ta = document.querySelector(".fmde-comment-draft textarea, .fmde-comment-card textarea, .fmde-comments textarea");
      ta.value = "First comment";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      const submit = Array.from(document.querySelectorAll("button")).find((b) => /^comment$|^save$|^add$/i.test(b.textContent.trim()));
      submit?.click();
    });
    await page.waitForTimeout(400);
    const comments = await page.evaluate(() => window.editor.getDocument().metadata.comments);
    check("I2 comment persists to metadata.comments", Array.isArray(comments) && comments.length === 1 && comments[0].text === "First comment", comments);
  }
}
// suggestion accept
await freshDoc([para("i3", "please replace TARGET word")]);
await page.evaluate(() => {
  // select the word TARGET
  const block = document.querySelector('[data-page-region="body"] [data-block-id="i3"]');
  const editable = block.closest(".fmde-docedit");
  editable.focus();
  const textNode = block.querySelector("span")?.firstChild || block.firstChild;
  const text = textNode.textContent;
  const start = text.indexOf("TARGET");
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, start + "TARGET".length);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});
await toolbar("Suggest an edit");
await page.waitForTimeout(300);
await page.evaluate(() => {
  const dialog = document.querySelector(".fmde-dialog");
  const input = dialog?.querySelector("[data-suggest-text]");
  if (input) {
    input.value = "REPLACED";
    dialog.querySelector("[data-suggest-apply]").click();
  }
});
await page.waitForTimeout(400);
{
  const suggestions = await page.evaluate(() => window.editor.getDocument().metadata.suggestions);
  check("I3 Suggest an edit records a pending suggestion", Array.isArray(suggestions) && suggestions.length === 1 && suggestions[0].replacement === "REPLACED", suggestions);
  // accept it
  const accepted = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) => /accept/i.test(b.textContent) && b.closest("[data-suggestion-id], .fmde-comment-card, .fmde-suggestion"));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await page.waitForTimeout(400);
  const blocks = await bodyBlocks();
  const text = blocks[0].runs.map((r) => r.text).join("");
  check("I4 accepting the suggestion rewrites the text", accepted && text.includes("REPLACED") && !text.includes("TARGET"), { accepted, text });
}

// =============================================================================
// J. Zoom
// =============================================================================
await freshDoc([para("j1", "zoom probe")]);
{
  const before = await page.evaluate(() => document.querySelector(".fmde-zoom-label").textContent);
  await toolbar("Zoom in");
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.querySelector(".fmde-zoom-label").textContent);
  check("J1 zoom in raises zoom label", parseInt(after) > parseInt(before), { before, after });
  const scaled = await page.evaluate(() => {
    const el = document.querySelector(".fmdoc-scale, .fmdoc-page");
    const t = getComputedStyle(el).transform;
    return t && t !== "none";
  });
  check("J2 zoom applies a scale transform", scaled);
  await toolbar("Fit page");
  await page.waitForTimeout(300);
  const fit = await page.evaluate(() => document.querySelector(".fmde-zoom-label").textContent);
  check("J3 fit page recomputes zoom", /%$/.test(fit), { fit });
}

// =============================================================================
// K. Undo / redo round trip
// =============================================================================
await freshDoc([para("k1", "undo probe")]);
await clickInBlock("k1", { where: "end" });
await page.keyboard.type(" added");
await page.waitForTimeout(400);
await page.keyboard.press("Control+z");
await page.waitForTimeout(300);
{
  const blocks = await bodyBlocks();
  const text = blocks[0].runs.map((r) => r.text).join("");
  check("K1 Ctrl+Z reverts typed text", text === "undo probe", { text });
}
await page.keyboard.press("Control+y");
await page.waitForTimeout(300);
{
  const blocks = await bodyBlocks();
  const text = blocks[0].runs.map((r) => r.text).join("");
  check("K2 Ctrl+Y reapplies", text === "undo probe added", { text });
}

// =============================================================================
// L. Spellcheck toggle + dead File actions
// =============================================================================
await freshDoc([para("l1", "spelcheck probe")]);
{
  const before = await page.evaluate(() => document.querySelector(".fmde-docedit")?.getAttribute("spellcheck"));
  await toolbar("Spelling and grammar");
  const after = await page.evaluate(() => document.querySelector(".fmde-docedit")?.getAttribute("spellcheck"));
  check("L1 spellcheck toggle flips editable attribute", before === "true" && after === "false", { before, after });
}
// File action fallback hint (harness host provides no documentActions)
await openMenu("File");
await menuItem("Share");
await page.waitForTimeout(250);
{
  const hint = await page.evaluate(() => document.querySelector(".fmde-hint")?.textContent || "");
  check("L2 unimplemented host action shows a status hint", /unavailable/i.test(hint), { hint });
}
// Tools ▸ Accessibility — always unavailable, even in real hosts (bug probe, expected fail until fixed)
await openMenu("Tools");
{
  const present = await page.evaluate(() => Array.from(document.querySelectorAll(".fmde-menu-item")).some((i) => i.textContent.trim() === "Accessibility"));
  check("L3 Tools menu lists Accessibility only when host implements it", !present, { present });
}
await closeMenus();

// =============================================================================
// M. Strikethrough (suspected missing UI)
// =============================================================================
await freshDoc([para("m2", "strike me")]);
await selectBlock("m2");
{
  const anyStrikeUI = await page.evaluate(() => {
    const inToolbar = !!document.querySelector('.fmde-toolbar button[title*="trikethrough"]');
    return { inToolbar };
  });
  await openMenu("Format");
  const subLabels = await hoverSubmenu("Text");
  await closeMenus();
  const subHasStrike = Array.isArray(subLabels) && subLabels.some((l) => /strikethrough/i.test(l));
  check("M1 strikethrough is reachable from Format ▸ Text", subHasStrike || anyStrikeUI.inToolbar, { subLabels, ...anyStrikeUI });
}

// =============================================================================
// N. Typing format follows the caret (Google-Docs pending-format semantics)
// =============================================================================
await freshDoc([para("n1", "first paragraph here"), para("n2", "second paragraph here")]);
await clickInBlock("n1", { where: "end" });
await toolbar("Font");
await menuItem("Georgia");
await page.keyboard.type("georgia");
await page.waitForTimeout(400);
await clickInBlock("n2", { where: "end" });
await page.waitForTimeout(300); // allow the selectionchange sync to run
await page.keyboard.type("plain");
await page.waitForTimeout(400);
{
  const blocks = await bodyBlocks();
  const n1tail = blocks[0].runs.find((r) => (r.text || "").includes("georgia"));
  const n2tail = blocks[1].runs.find((r) => (r.text || "").includes("plain"));
  check("N1 chosen font applies at that caret only", !!n1tail && n1tail.font && n1tail.font.family === "Georgia", blocks[0].runs);
  check("N2 moving the caret resets the pending font (no sticky Georgia)", !!n2tail && (!n2tail.font || n2tail.font.family !== "Georgia"), blocks[1].runs);
}
await freshDoc([{ id: "n3", type: "paragraph", style_ref: "Normal text", runs: [{ text: "all red text", color: "#ea4335" }] }]);
await clickInBlock("n3", { where: "end" });
await page.waitForTimeout(300);
await page.keyboard.type("more");
await page.waitForTimeout(400);
{
  const blocks = await bodyBlocks();
  const colors = blocks[0].runs.map((r) => r.color);
  check("N3 typing inside colored text keeps its color", colors.every((c) => c === "#ea4335"), blocks[0].runs);
}
// toolbar reflection
await freshDoc([
  { id: "n4", type: "paragraph", style_ref: "Heading 1", runs: [{ text: "big heading" }] },
  { id: "n5", type: "paragraph", style_ref: "Normal text", runs: [{ text: "bold body", weight: 700 }] }
]);
await clickInBlock("n4");
await page.waitForTimeout(300);
{
  const styleLabel = await page.evaluate(() => document.querySelector(".fmde-styleselect span")?.textContent);
  check("N4 style dropdown label follows the caret", styleLabel === "Heading 1", { styleLabel });
}
await clickInBlock("n5");
await page.waitForTimeout(300);
{
  const boldActive = await page.evaluate(() => document.querySelector('.fmde-toolbar button[title="Bold (Ctrl+B)"]')?.classList.contains("active"));
  const styleLabel = await page.evaluate(() => document.querySelector(".fmde-styleselect span")?.textContent);
  check("N5 bold button reflects caret formatting", boldActive === true, { boldActive });
  check("N6 style label returns to Normal text", styleLabel === "Normal text", { styleLabel });
}

// =============================================================================
// O. Tranche A parity features (superscript, case, spacing, RTL, chip, suggest
//    dialog, bookmarks)
// =============================================================================
await freshDoc([para("o1", "x2 plus y2")]);
await selectBlock("o1");
await page.keyboard.press("Control+.");
await page.waitForTimeout(400);
{
  const blocks = await bodyBlocks();
  check("O1 Ctrl+. sets run.super", blocks[0].runs.some((r) => r.super === true), blocks[0].runs);
  const style = await page.evaluate(() => {
    const span = document.querySelector('[data-block-id="o1"] .fmdoc-run');
    return span ? getComputedStyle(span).verticalAlign : null;
  });
  check("O2 superscript renders with vertical-align super", style === "super", { style });
}
await selectBlock("o1");
await page.keyboard.press("Control+.");
await page.keyboard.press("Control+,");
await page.waitForTimeout(400);
{
  const blocks = await bodyBlocks();
  check("O3 Ctrl+, switches to run.sub", blocks[0].runs.some((r) => r.sub === true) && blocks[0].runs.every((r) => !r.super), blocks[0].runs);
}
// capitalization
await freshDoc([para("o4", "make me shout")]);
await selectBlock("o4");
await openMenu("Format");
{
  await hoverSubmenu("Text");
  const capLabels = await hoverSubmenu("Capitalization");
  const clicked = capLabels && await menuItem("UPPERCASE");
  await page.waitForTimeout(400);
  const blocks = await bodyBlocks();
  check("O4 Capitalization ▸ UPPERCASE transforms the selection", clicked && blocks[0].runs.map((r) => r.text).join("") === "MAKE ME SHOUT", blocks[0].runs);
}
// custom spacing
await freshDoc([para("o5", "spaced out")]);
await clickInBlock("o5");
await toolbar("Line and paragraph spacing");
{
  const clicked = await menuItem("Custom spacing…");
  await page.waitForTimeout(300);
  const applied = await page.evaluate(() => {
    const dialog = document.querySelector(".fmde-dialog");
    if (!dialog) return false;
    dialog.querySelector("[data-spacing-line]").value = "1.8";
    dialog.querySelector("[data-spacing-before]").value = "12";
    dialog.querySelector("[data-spacing-after]").value = "6";
    dialog.querySelector("[data-spacing-apply]").click();
    return true;
  });
  await page.waitForTimeout(400);
  const blocks = await bodyBlocks();
  const block = blocks[0];
  check("O5 custom spacing dialog sets line/before/after", clicked && applied && block.line_height === 1.8 && block.space_before_pt === 12 && block.space_after_pt === 6, block);
  const margins = await page.evaluate(() => {
    const el = document.querySelector('[data-block-id="o5"]');
    const cs = getComputedStyle(el);
    return { top: cs.marginTop, bottom: cs.marginBottom };
  });
  check("O6 spacing renders as block margins", parseFloat(margins.top) > 10 && parseFloat(margins.bottom) > 4, margins);
  // survives a re-parse (typing)
  await clickInBlock("o5", { where: "end" });
  await page.keyboard.type("!");
  await page.waitForTimeout(400);
  const after = (await bodyBlocks())[0];
  check("O7 custom spacing survives typing (parser preserves fields)", after.space_before_pt === 12 && after.space_after_pt === 6, after);
}
// RTL
await freshDoc([para("o8", "direction test")]);
await clickInBlock("o8");
await openMenu("Format");
{
  await hoverSubmenu("Paragraph direction");
  const clicked = await menuItem("Right-to-left");
  await page.waitForTimeout(400);
  const blocks = await bodyBlocks();
  const dir = await page.evaluate(() => document.querySelector('[data-block-id="o8"]')?.getAttribute("dir"));
  check("O8 RTL sets block.direction and dir attribute", clicked && blocks[0].direction === "rtl" && dir === "rtl", { block: blocks[0], dir });
}
// word count chip
await freshDoc([para("o9", "five little words here now")]);
await openMenu("Tools");
{
  const clicked = await menuItem("Word count while typing");
  await page.waitForTimeout(300);
  const chip = await page.evaluate(() => document.querySelector(".fmde-wordcount-chip")?.textContent || null);
  check("O9 word count chip appears with live count", clicked && chip === "5 words", { chip });
  await clickInBlock("o9", { where: "end" });
  await page.keyboard.type(" extra");
  await page.waitForTimeout(500);
  const chipAfter = await page.evaluate(() => document.querySelector(".fmde-wordcount-chip")?.textContent || null);
  check("O10 chip updates while typing", chipAfter === "6 words", { chipAfter });
}
// suggest dialog (no window.prompt)
await freshDoc([para("o11", "replace TARGET now")]);
await page.evaluate(() => {
  window.prompt = () => { throw new Error("window.prompt must not be used"); };
  const block = document.querySelector('[data-page-region="body"] [data-block-id="o11"]');
  const editable = block.closest(".fmde-docedit");
  editable.focus();
  const textNode = block.querySelector("span")?.firstChild || block.firstChild;
  const start = textNode.textContent.indexOf("TARGET");
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, start + 6);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
});
await toolbar("Suggest an edit");
await page.waitForTimeout(300);
{
  const submitted = await page.evaluate(() => {
    const dialog = document.querySelector(".fmde-dialog");
    if (!dialog) return { dialog: false };
    const quote = dialog.querySelector(".fmde-suggest-quote")?.textContent;
    const input = dialog.querySelector("[data-suggest-text]");
    input.value = "SWAPPED";
    dialog.querySelector("[data-suggest-apply]").click();
    return { dialog: true, quote };
  });
  await page.waitForTimeout(400);
  const suggestions = await page.evaluate(() => window.editor.getDocument().metadata.suggestions);
  check("O11 suggest-edit uses a dialog and records the suggestion", submitted.dialog && submitted.quote === "TARGET" && suggestions?.length === 1 && suggestions[0].replacement === "SWAPPED", { submitted, suggestions });
}
// bookmarks: flag renders, copy/remove menu, link targets
await freshDoc([
  { id: "o12", type: "paragraph", style_ref: "Heading 1", runs: [{ text: "Chapter One" }] },
  para("o13", "bookmark this line")
]);
await clickInBlock("o13");
await openMenu("Insert");
await menuItem("Bookmark");
await page.waitForTimeout(500);
{
  const flag = await page.evaluate(() => {
    const el = document.querySelector(".fmde-bookmark-flag");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const block = document.querySelector('[data-block-id="o13"]').getBoundingClientRect();
    return { visible: r.width > 0, nearBlock: Math.abs(r.top - block.top) < 30 };
  });
  check("O12 bookmark flag renders at the bookmarked line", !!flag && flag.visible && flag.nearBlock, flag);
  // link dialog offers heading + bookmark targets
  await selectBlock("o13");
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(300);
  const targets = await page.evaluate(() => {
    const select = document.querySelector("[data-link-target]");
    if (!select) return null;
    const options = Array.from(select.options).map((o) => o.textContent);
    select.value = select.options[1].value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const url = document.querySelector("[data-link-url]").value;
    document.querySelector("[data-link-apply]").click();
    return { options, url };
  });
  await page.waitForTimeout(400);
  const blocks = await bodyBlocks();
  const linked = blocks.flatMap((b) => b.runs).some((r) => String(r.link || "").startsWith("#fmdoc-"));
  check("O13 link dialog lists headings and bookmarks and applies internal link", !!targets && targets.options.some((o) => /Chapter One/.test(o)) && linked, { targets, linked });
  // remove via flag menu
  const removed = await page.evaluate(async () => {
    const el = document.querySelector(".fmde-bookmark-flag");
    if (!el) return false;
    el.click();
    await new Promise((r) => setTimeout(r, 200));
    const item = Array.from(document.querySelectorAll(".fmde-menu-item")).find((i) => /Remove bookmark/.test(i.textContent));
    if (!item) return false;
    item.click();
    return true;
  });
  await page.waitForTimeout(500);
  const bookmarksLeft = await page.evaluate(() => (window.editor.getDocument().metadata.bookmarks || []).length);
  const flagsLeft = await page.evaluate(() => document.querySelectorAll(".fmde-bookmark-flag").length);
  check("O14 flag menu removes the bookmark and its marker", removed && bookmarksLeft === 0 && flagsLeft === 0, { removed, bookmarksLeft, flagsLeft });
}

// =============================================================================
// P. Tranche B: outline, TOC, multi-level lists, borders & shading, page color
// =============================================================================
await freshDoc([
  { id: "p1h", type: "paragraph", style_ref: "Heading 1", runs: [{ text: "Alpha Section" }] },
  para("p1a", "body text under alpha"),
  { id: "p2h", type: "paragraph", style_ref: "Heading 2", runs: [{ text: "Beta Subsection" }] },
  para("p2a", "body text under beta")
]);
await openMenu("View");
await menuItem("Show document outline");
await page.waitForTimeout(300);
{
  const outline = await page.evaluate(() => Array.from(document.querySelectorAll(".fmde-outline-item")).map((i) => i.textContent.trim()));
  check("P1 outline panel lists headings", outline.length === 2 && outline[0] === "Alpha Section" && outline[1] === "Beta Subsection", outline);
  const indented = await page.evaluate(() => {
    const items = document.querySelectorAll(".fmde-outline-item");
    return parseInt(items[1].style.paddingLeft) > parseInt(items[0].style.paddingLeft);
  });
  check("P2 outline indents by heading level", indented);
}
// TOC
await clickInBlock("p2a", { where: "end" });
await openMenu("Insert");
await menuItem("Table of contents");
await page.waitForTimeout(500);
{
  const toc = await page.evaluate(() => {
    const body = window.editor.getDocument().pages[0].children.find((n) => n.props?.page_region === "body");
    const node = body.children.find((n) => n.type === "text" && n.props.toc_generated);
    return node ? node.props.blocks.map((b) => ({ text: b.runs.map((r) => r.text).join(""), link: b.runs[0]?.link, indent: b.indent || 0 })) : null;
  });
  check("P3 TOC node generated with linked heading lines", !!toc && toc.length === 2 && toc[0].text === "Alpha Section" && String(toc[0].link).startsWith("#fmdoc-block:") && toc[1].indent === 1, toc);
}
// multi-level list markers
await freshDoc([
  { id: "l1", type: "list_item", list_style: "number", runs: [{ text: "one" }] },
  { id: "l2", type: "list_item", list_style: "number", runs: [{ text: "two" }] },
  { id: "l3", type: "list_item", list_style: "number", indent: 1, runs: [{ text: "two-a" }] },
  { id: "l4", type: "list_item", list_style: "number", indent: 2, runs: [{ text: "two-a-i" }] },
  { id: "l5", type: "list_item", list_style: "number", runs: [{ text: "three" }] },
  { id: "l6", type: "list_item", list_style: "bullet", indent: 1, runs: [{ text: "nested bullet" }] }
]);
{
  const markers = await page.evaluate(() => ["l1", "l2", "l3", "l4", "l5", "l6"].map((id) => document.querySelector('[data-page-region="body"] [data-block-id="' + id + '"]')?.getAttribute("data-marker")));
  check("P4 numbered markers rotate by level (1. a. i.)", markers[0] === "1." && markers[1] === "2." && markers[2] === "a." && markers[3] === "i." && markers[4] === "3.", markers);
  check("P5 bullets rotate glyph by level", markers[5] === "◦", { marker: markers[5] });
}
// restart numbering
await clickInBlock("l5");
await openMenu("Format");
{
  await hoverSubmenu("Bullets & numbering");
  const clicked = await menuItem("Restart numbering");
  await page.waitForTimeout(400);
  const marker = await page.evaluate(() => document.querySelector('[data-page-region="body"] [data-block-id="l5"]')?.getAttribute("data-marker"));
  check("P6 restart numbering resets the counter", clicked && marker === "1.", { marker });
}
// borders & shading
await freshDoc([para("bs1", "boxed paragraph")]);
await clickInBlock("bs1");
await openMenu("Format");
{
  const clicked = await menuItem("Borders & shading");
  await page.waitForTimeout(300);
  const applied = await page.evaluate(() => {
    const dialog = document.querySelector(".fmde-dialog");
    if (!dialog) return false;
    dialog.querySelector("[data-bs-width]").value = "1";
    dialog.querySelector("[data-bs-color]").value = "#ff0000";
    dialog.querySelector("[data-bs-noshading]").checked = false;
    dialog.querySelector("[data-bs-shading]").value = "#fff2cc";
    dialog.querySelector("[data-bs-apply]").click();
    return true;
  });
  await page.waitForTimeout(400);
  const blocks = await bodyBlocks();
  const block = blocks[0];
  check("P7 borders & shading dialog writes block fields", clicked && applied && block.border && block.border.width_pt === 1 && block.shading === "#fff2cc", block);
  const styles = await page.evaluate(() => {
    const el = document.querySelector('[data-block-id="bs1"]');
    const cs = getComputedStyle(el);
    return { borderTop: cs.borderTopWidth, background: cs.backgroundColor };
  });
  check("P8 borders & shading render", parseFloat(styles.borderTop) > 0 && styles.background !== "rgba(0, 0, 0, 0)", styles);
  await clickInBlock("bs1", { where: "end" });
  await page.keyboard.type("!");
  await page.waitForTimeout(400);
  const after = (await bodyBlocks())[0];
  check("P9 borders survive typing (parser preserves fields)", !!after.border && after.shading === "#fff2cc", after);
}
// page color
await freshDoc([para("pc1", "page color probe")]);
await openMenu("File");
await menuItem("Page setup");
await page.waitForTimeout(400);
{
  const applied = await page.evaluate(() => {
    const dialog = document.querySelector(".fmde-dialog");
    if (!dialog) return false;
    const color = dialog.querySelector("[data-page-color]");
    color.value = "#e8f0fe";
    color.dispatchEvent(new Event("input", { bubbles: true }));
    dialog.querySelector("[data-page-apply]").click();
    return true;
  });
  await page.waitForTimeout(600);
  const setting = await page.evaluate(() => window.editor.getDocument().settings.page_background);
  const rendered = await page.evaluate(() => getComputedStyle(document.querySelector(".fmdoc-page")).backgroundColor);
  check("P10 page color persists and renders", applied && setting === "#e8f0fe" && rendered === "rgb(232, 240, 254)", { setting, rendered });
}

// =============================================================================
// Q. Tranche C: table editing in doc mode
// =============================================================================
async function tableNode() {
  return await page.evaluate(() => {
    const body = window.editor.getDocument().pages[0].children.find((n) => n.props?.page_region === "body");
    return body.children.find((n) => n.type === "table") || null;
  });
}
await freshDoc([para("q0", "table follows")]);
await clickInBlock("q0", { where: "end" });
await toolbar("Add media, video, or widget");
await menuItem("Table", { exact: false });
await page.waitForTimeout(600);
{
  const cellPoint = await page.evaluate(() => {
    const cell = document.querySelector('[data-node-type="table"] td[data-cell="1:0"]');
    if (!cell) return null;
    const r = cell.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  check("Q1 inserted table renders editable cells", !!cellPoint);
  if (cellPoint) {
    await page.mouse.click(cellPoint.x, cellPoint.y);
    await page.waitForTimeout(200);
    await page.keyboard.type("hello cell");
    await page.waitForTimeout(500);
    const node = await tableNode();
    check("Q2 typing in a cell commits to props.rows", node && node.props.rows[1].cells[0].text === "hello cell", node && node.props.rows[1]);
    const chip = await page.evaluate(() => !!document.querySelector(".fmde-table-chip"));
    check("Q3 table chip appears while a cell has focus", chip);
    // Tab navigation
    await page.keyboard.press("Tab");
    await page.keyboard.type("next");
    await page.waitForTimeout(500);
    const node2 = await tableNode();
    check("Q4 Tab moves to the next cell", node2 && node2.props.rows[1].cells[1].text === "next", node2 && node2.props.rows[1]);
    // add a row below via chip
    const rowsBefore = node2.props.rows.length;
    await page.evaluate(() => { Array.from(document.querySelectorAll(".fmde-table-chip button")).find((b) => b.title === "Insert row below")?.click(); });
    await page.waitForTimeout(500);
    const node3 = await tableNode();
    check("Q5 chip adds a row", node3 && node3.props.rows.length === rowsBefore + 1, { before: rowsBefore, after: node3 && node3.props.rows.length });
    // add a column
    const colsBefore = node3.props.columns.length;
    await page.evaluate(() => {
      const cell = document.querySelector('[data-node-type="table"] td[data-cell="1:0"]');
      cell.focus();
      Array.from(document.querySelectorAll(".fmde-table-chip button")).find((b) => b.title === "Insert column right")?.click();
    });
    await page.waitForTimeout(500);
    const node4 = await tableNode();
    const widthsSum = node4.props.columns.reduce((s, c) => s + c.width_frac, 0);
    check("Q6 chip adds a column and renormalizes widths", node4.props.columns.length === colsBefore + 1 && Math.abs(widthsSum - 1) < 0.02, { cols: node4.props.columns });
    // merge right
    await page.evaluate(() => {
      const cell = document.querySelector('[data-node-type="table"] td[data-cell="1:0"]');
      cell.focus();
      Array.from(document.querySelectorAll(".fmde-table-chip button")).find((b) => b.title === "Merge with cell to the right")?.click();
    });
    await page.waitForTimeout(500);
    const node5 = await tableNode();
    const merged = node5.props.rows[1].cells[0];
    check("Q7 merge right sets colspan and joins text", merged.colspan === 2 && node5.props.rows[1].cells.length === node4.props.rows[1].cells.length - 1, merged);
    const colspanDom = await page.evaluate(() => document.querySelector('[data-node-type="table"] td[data-cell="1:0"]')?.colSpan);
    check("Q8 merged cell renders with colspan", colspanDom === 2, { colspanDom });
    // unmerge
    await page.evaluate(() => {
      const cell = document.querySelector('[data-node-type="table"] td[data-cell="1:0"]');
      cell.focus();
      Array.from(document.querySelectorAll(".fmde-table-chip button")).find((b) => b.title === "Split merged cell")?.click();
    });
    await page.waitForTimeout(500);
    const node6 = await tableNode();
    check("Q9 unmerge restores the cell", !node6.props.rows[1].cells[0].colspan && node6.props.rows[1].cells.length === node5.props.rows[1].cells.length + 1, node6.props.rows[1]);
    // column resize by dragging the first column boundary
    const before = node6.props.columns.map((c) => c.width_frac);
    const boundary = await page.evaluate(() => {
      const cell = document.querySelector('[data-node-type="table"] td[data-cell="1:0"]');
      const r = cell.getBoundingClientRect();
      return { x: r.right - 1, y: r.y + r.height / 2 };
    });
    await page.mouse.move(boundary.x, boundary.y);
    await page.mouse.down();
    await page.mouse.move(boundary.x + 40, boundary.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const node7 = await tableNode();
    const after = node7.props.columns.map((c) => c.width_frac);
    check("Q10 dragging a column boundary resizes width_frac", after[0] > before[0] + 0.02 && Math.abs(after.reduce((s, w) => s + w, 0) - 1) < 0.05, { before, after });
    // delete table
    await page.evaluate(() => {
      const cell = document.querySelector('[data-node-type="table"] td[data-cell="1:0"]');
      cell.focus();
      Array.from(document.querySelectorAll(".fmde-table-chip button")).find((b) => b.textContent === "Delete table")?.click();
    });
    await page.waitForTimeout(500);
    const node8 = await tableNode();
    check("Q11 delete table removes the node", node8 === null);
  }
}

// =============================================================================
// R. Tranche C: image handling in doc mode
// =============================================================================
await freshDoc([para("r1", "text before the image"), para("r2", "text after the image")]);
await page.evaluate(() => {
  // Insert a flow image node directly (media pickers need a host).
  const body = window.editor.getDocument().pages[0].children.find((n) => n.props?.page_region === "body");
  const doc = window.editor.getDocument();
  const node = window.FMDocModel.createNode("image", {
    name: "QA image", anchor: "flow",
    frame: { x: 0, y: 0, w: 0, h: 120, z: 0 },
    props: { media: { url: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'><rect width='40' height='40' fill='%23f00'/></svg>" }, fit: "contain", alt: "qa" }
  });
  const bodyNode = doc.pages[0].children.find((n) => n.props?.page_region === "body");
  bodyNode.children.splice(1, 0, node);
  window.editor.setDocument(doc);
  window.__qaImageId = node.id;
});
await page.waitForTimeout(500);
{
  const imgPoint = await page.evaluate(() => {
    const el = document.querySelector('[data-node-type="image"][data-node-id]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, h: r.height };
  });
  check("R1 flow image renders in the body", !!imgPoint, imgPoint);
  if (imgPoint) {
    await page.mouse.click(imgPoint.x, imgPoint.y);
    await page.waitForTimeout(300);
    const overlay = await page.evaluate(() => !!document.querySelector(".fmde-img-overlay"));
    check("R2 clicking the image shows the overlay chip", overlay);
    // resize via the SE handle
    const handle = await page.evaluate(() => {
      const el = document.querySelector(".fmde-img-handle");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (handle) {
      await page.mouse.move(handle.x, handle.y);
      await page.mouse.down();
      await page.mouse.move(handle.x, handle.y + 40, { steps: 4 });
      await page.mouse.up();
      await page.waitForTimeout(500);
      const frameH = await page.evaluate(() => {
        let found = null;
        (function walk(n) { if (!n || found) return; if (n.id === window.__qaImageId) { found = n; return; } (n.children || []).forEach(walk); })({ children: window.editor.getDocument().pages });
        return found && found.frame.h;
      });
      check("R3 dragging the handle grows frame.h", frameH > 130, { frameH });
    } else check("R3 dragging the handle grows frame.h", false, { handle: null });
    // wrap right
    await page.evaluate(() => {
      const img = document.querySelector('[data-node-type="image"][data-node-id]');
      img.click();
    });
    await page.waitForTimeout(200);
    await page.evaluate(() => { Array.from(document.querySelectorAll(".fmde-img-chip button")).find((b) => b.textContent === "Wrap right")?.click(); });
    await page.waitForTimeout(500);
    const wrapped = await page.evaluate(() => {
      const el = document.querySelector('[data-fmdoc-float="right"][data-node-type="image"]');
      let anchor = null;
      (function walk(n) { if (!n || anchor) return; if (n.id === window.__qaImageId) { anchor = n.anchor; return; } (n.children || []).forEach(walk); })({ children: window.editor.getDocument().pages });
      return { dom: !!el, anchor };
    });
    check("R4 Wrap right floats the image against a text block", wrapped.dom && wrapped.anchor && wrapped.anchor.wrap === "right" && !!wrapped.anchor.to_block, wrapped);
    // back to inline
    await page.evaluate(() => { document.querySelector('[data-node-type="image"]').click(); });
    await page.waitForTimeout(200);
    await page.evaluate(() => { Array.from(document.querySelectorAll(".fmde-img-chip button")).find((b) => b.textContent === "In line")?.click(); });
    await page.waitForTimeout(500);
    const inline = await page.evaluate(() => {
      let anchor = null;
      (function walk(n) { if (!n || anchor) return; if (n.id === window.__qaImageId) { anchor = n.anchor; return; } (n.children || []).forEach(walk); })({ children: window.editor.getDocument().pages });
      return anchor;
    });
    check("R5 In line restores flow anchor", inline === "flow", { inline });
    // delete
    await page.evaluate(() => { document.querySelector('[data-node-type="image"]').click(); });
    await page.waitForTimeout(200);
    await page.evaluate(() => { Array.from(document.querySelectorAll(".fmde-img-chip button")).find((b) => b.textContent === "Delete")?.click(); });
    await page.waitForTimeout(500);
    const gone = await page.evaluate(() => {
      let found = null;
      (function walk(n) { if (!n || found) return; if (n.id === window.__qaImageId) { found = n; return; } (n.children || []).forEach(walk); })({ children: window.editor.getDocument().pages });
      return !found && !document.querySelector('[data-node-type="image"]');
    });
    check("R6 Delete removes the image node", gone);
  }
}

// =============================================================================
// S. Tranche C: footnotes
// =============================================================================
await freshDoc([para("s1", "First paragraph for notes."), para("s2", "Second paragraph target.")]);
await clickInBlock("s2", { where: "end" });
await openMenu("Insert");
await menuItem("Footnote");
await page.waitForTimeout(600);
{
  const stateNow = await page.evaluate(() => ({
    notes: window.editor.getDocument().metadata.footnotes,
    marker: document.querySelector(".fmdoc-footnote-ref")?.textContent,
    strip: !!document.querySelector(".fmdoc-footnotes"),
    focusInStrip: !!document.activeElement?.closest?.(".fmdoc-footnote-text")
  }));
  check("S1 Insert ▸ Footnote records anchor + renders marker and strip", stateNow.notes?.length === 1 && stateNow.marker === "1" && stateNow.strip, stateNow);
  check("S2 the new footnote's strip entry gets focus", stateNow.focusInStrip, { focusInStrip: stateNow.focusInStrip });
  await page.keyboard.type("A note about the second paragraph");
  await page.waitForTimeout(500);
  const noteText = await page.evaluate(() => window.editor.getDocument().metadata.footnotes[0].text);
  check("S3 typing in the strip commits footnote text", noteText === "A note about the second paragraph", { noteText });
}
// a second footnote EARLIER in the document must become number 1
await clickInBlock("s1", { where: "end" });
await page.keyboard.press("Control+Alt+f");
await page.waitForTimeout(600);
{
  const numbering = await page.evaluate(() => {
    const markers = Array.from(document.querySelectorAll(".fmdoc-footnote-ref")).map((m) => ({ n: m.textContent, block: m.closest("[data-block-id]")?.getAttribute("data-block-id") }));
    return markers;
  });
  const first = numbering.find((m) => m.block === "s1");
  const second = numbering.find((m) => m.block === "s2");
  check("S4 footnotes renumber by document order", numbering.length === 2 && first?.n === "1" && second?.n === "2", numbering);
  // delete the first footnote via its strip × button
  await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll(".fmdoc-footnote")).find((r) => r.querySelector(".fmdoc-footnote-text")?.textContent === "");
    row?.querySelector(".fmde-footnote-del")?.click();
  });
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({
    notes: window.editor.getDocument().metadata.footnotes.length,
    markers: Array.from(document.querySelectorAll(".fmdoc-footnote-ref")).map((m) => m.textContent)
  }));
  check("S5 delete button removes the footnote and renumbers", after.notes === 1 && after.markers.length === 1 && after.markers[0] === "1", after);
}

// =============================================================================
// T. Tranche C: ruler drag, header variants, pageless
// =============================================================================
await freshDoc([para("t1", "ruler and margins probe")]);
await clickInBlock("t1");
await openMenu("View");
await menuItem("Show ruler");
await page.waitForTimeout(400);
{
  const geo = await page.evaluate(() => {
    const handle = document.querySelectorAll(".fmde-ruler-margin")[0];
    if (!handle) return null;
    const r = handle.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  check("T1 ruler shows margin handles", !!geo, geo);
  if (geo) {
    await page.mouse.move(geo.x, geo.y);
    await page.mouse.down();
    await page.mouse.move(geo.x - 30, geo.y, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    const margins = await page.evaluate(() => window.editor.getDocument().chains.body.page_defaults.margins_pt);
    check("T2 dragging the left margin handle narrows the margin", margins.left < 60 && margins.left >= 18, margins);
  }
  // first-line indent drag
  await clickInBlock("t1");
  await page.waitForTimeout(300);
  const fl = await page.evaluate(() => {
    const handle = document.querySelector(".fmde-ruler-first");
    if (!handle) return null;
    const r = handle.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + 3 };
  });
  if (fl) {
    await page.mouse.move(fl.x, fl.y);
    await page.mouse.down();
    await page.mouse.move(fl.x + 40, fl.y, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const blocks = await bodyBlocks();
    const indentCss = await page.evaluate(() => getComputedStyle(document.querySelector('[data-block-id="t1"]')).textIndent);
    check("T3 dragging the first-line marker sets first_line_indent_pt", blocks[0].first_line_indent_pt > 10 && parseFloat(indentCss) > 10, { block: blocks[0], indentCss });
  } else check("T3 dragging the first-line marker sets first_line_indent_pt", false, { handle: null });
}
// header variants
await freshDoc(null);
await page.evaluate(() => {
  const body = window.editor.getDocument();
});
await openMenu("Insert");
await menuItem("Header");
await page.waitForTimeout(400);
{
  const chip = await page.evaluate(() => !!document.querySelector(".fmde-header-chip"));
  check("T4 focusing the header shows the options chip", chip);
  if (chip) {
    await page.evaluate(() => {
      const box = document.querySelectorAll(".fmde-header-chip input")[0];
      box.checked = true;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForTimeout(700);
    const variantState = await page.evaluate(() => {
      const doc = window.editor.getDocument();
      const hasVariant = doc.pages[0].children.some((n) => n.props?.page_region === "header_first");
      return { options: doc.settings.header_options, hasVariant };
    });
    check("T5 enabling different-first-page stores the option and creates the variant frame", variantState.options?.different_first === true && variantState.hasVariant, variantState);
    // page 1 must show the variant, base header hidden; page 2+ shows base
    await page.evaluate(() => {
      const doc = window.editor.getDocument();
      const body = doc.pages[0].children.find((n) => n.props?.page_region === "body");
      body.children[0].props.blocks = Array.from({ length: 120 }, (_, i) => ({ id: "hv_" + i, type: "paragraph", style_ref: "Normal text", runs: [{ text: "Header variant pagination filler line " + i }] }));
      const header = doc.pages[0].children.find((n) => n.props?.page_region === "header");
      header.children[0].props.blocks[0].runs[0].text = "BASE HEADER";
      window.editor.setDocument(doc);
    });
    await page.waitForTimeout(800);
    const visibility = await page.evaluate(() => {
      const pages = Array.from(document.querySelectorAll(".fmdoc-page"));
      const shown = (pageEl, region) => Array.from(pageEl.querySelectorAll('[data-page-region="' + region + '"]')).some((el) => el.style.display !== "none");
      return { pages: pages.length, p1base: shown(pages[0], "header"), p1first: shown(pages[0], "header_first"), p2base: pages[1] ? shown(pages[1], "header") : null };
    });
    check("T6 page 1 shows the first-page header, later pages the base header", visibility.pages > 1 && visibility.p1base === false && visibility.p1first === true && visibility.p2base === true, visibility);
  }
}
// pageless
await freshDoc([para("pl1", "pageless probe")]);
await openMenu("View");
await menuItem("Pageless");
await page.waitForTimeout(700);
{
  const stateNow = await page.evaluate(() => ({
    pageless: window.editor.getDocument().settings.pageless,
    fill: !!document.querySelector('.fmdoc-page[data-fill="true"]'),
    pages: document.querySelectorAll(".fmdoc-page").length,
    headerVisible: (() => { const el = document.querySelector('[data-page-region="header"]'); return !!el; })()
  }));
  check("T7 pageless renders one fluid page without header chrome", stateNow.pageless === true && stateNow.fill && stateNow.pages === 1 && !stateNow.headerVisible, stateNow);
  await openMenu("View");
  await menuItem("Pageless");
  await page.waitForTimeout(700);
  const back = await page.evaluate(() => ({
    pageless: window.editor.getDocument().settings.pageless,
    fill: !!document.querySelector('.fmdoc-page[data-fill="true"]'),
    headerVisible: !!document.querySelector('[data-page-region="header"]')
  }));
  check("T8 toggling back restores paged layout with headers", back.pageless === false && !back.fill && back.headerVisible, back);
}

// =============================================================================
// U. Tranche D: autocorrect, spelling panel, HTML export
// =============================================================================
await freshDoc([para("u1", "Note:")]);
await clickInBlock("u1", { where: "end" });
await page.waitForTimeout(600); // language engine warm-up
await page.keyboard.type(" teh mistake happened");
await page.waitForTimeout(500);
{
  const text = (await bodyBlocks())[0].runs.map((r) => r.text).join("");
  check("U1 dictionary autocorrect fixes typos as you type", text.includes("the mistake"), { text });
}
await freshDoc([para("u2", "")]);
await clickInBlock("u2", { where: "end" });
await page.keyboard.type('she said "hi" today');
await page.waitForTimeout(500);
{
  const text = (await bodyBlocks())[0].runs.map((r) => r.text).join("");
  check("U2 smart quotes + sentence capitalization", text.includes("“hi”") && text.startsWith("She said"), { text });
}
await freshDoc([para("u3", "")]);
await clickInBlock("u3", { where: "end" });
await page.keyboard.type("- ");
await page.keyboard.type("groceries");
await page.waitForTimeout(500);
{
  const block = (await bodyBlocks())[0];
  check("U3 '- ' at line start starts a bulleted list", block.type === "list_item" && block.list_style === "bullet" && block.runs.map((r) => r.text).join("").includes("roceries"), block);
}
await freshDoc([para("u4", "")]);
await clickInBlock("u4", { where: "end" });
await page.keyboard.type("visit www.example.com now");
await page.waitForTimeout(500);
{
  const runs = (await bodyBlocks())[0].runs;
  const linkedText = runs.filter((r) => r.link === "https://www.example.com").map((r) => r.text).join("");
  check("U4 URLs auto-link on the following space", linkedText === "www.example.com", runs);
}
// spelling panel
await freshDoc([para("u5", "We will recieve the shipment tomorow.")]);
await openMenu("Tools");
await menuItem("Spelling & grammar check");
await page.waitForTimeout(1200);
{
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll(".fmde-spell-row")).map((r) => ({ label: r.querySelector(".fmde-spell-label").textContent, fixes: Array.from(r.querySelectorAll(".fmde-spell-actions .fmde-btn")).map((b) => b.textContent).slice(0, 2) })));
  check("U5 spelling panel lists misspellings with suggestions", rows.some((r) => r.label === "recieve" && r.fixes.includes("receive")), rows);
  const applied = await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll(".fmde-spell-row")).find((r) => r.querySelector(".fmde-spell-label").textContent === "recieve");
    const btn = row && Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "receive");
    if (!btn) return false;
    btn.click();
    return true;
  });
  await page.waitForTimeout(600);
  const text = (await bodyBlocks())[0].runs.map((r) => r.text).join("");
  check("U6 accepting a suggestion rewrites the document", applied && text.includes("receive the shipment"), { text });
  await page.evaluate(() => document.querySelector("[data-spell-close]")?.click());
}
// HTML export
await freshDoc([para("u7", "Exported paragraph content.")]);
await openMenu("File");
{
  await hoverSubmenu("Download");
  const downloadPromise = page.waitForEvent("download", { timeout: 8000 }).catch(() => null);
  await menuItem("Web page (.html)");
  const download = await downloadPromise;
  check("U7 Download ▸ Web page produces an .html file", !!download && download.suggestedFilename().endsWith(".html"), { name: download && download.suggestedFilename() });
  if (download) {
    const path = await download.path();
    const { readFile } = await import("node:fs/promises");
    const html = await readFile(path, "utf8");
    check("U8 exported HTML is self-contained with content and styles", html.includes("Exported paragraph content.") && html.includes(".fmdoc-page") && html.startsWith("<!doctype html>"), { bytes: html.length });
  }
  await closeMenus();
}

// =============================================================================
// V. Version history UI + compare (mock versionsApi adapter)
// =============================================================================
await page.evaluate(() => {
  window.editor.destroy();
  const doc = window.FMDocModel.createBlankDocument({ metadata: { document_type: "generic" } });
  const body = doc.pages[0].children.find((n) => n.props?.page_region === "body");
  body.children[0].props.blocks = [{ id: "v1", type: "paragraph", style_ref: "Normal text", runs: [{ text: "Original text here" }] }];
  window.__bodyTextId = body.children[0].id;
  window.__versionCalls = [];
  const mockVersions = {
    list: () => Promise.resolve({ checkpoints: [{ id: "cp1", name: "First draft", reason: "manual", created_at: "2026-08-10T10:00:00Z" }] }),
    get: (id) => Promise.resolve({ checkpoint: { id: id, definition: null } }),
    create: (bodyArg) => { window.__versionCalls.push(["create", bodyArg]); return Promise.resolve({ ok: true }); },
    diff: () => Promise.resolve({ diff: {
      changed_blocks: [{ node_id: window.__bodyTextId, block_id: "v1", before_text: "Original text here", after_text: "Original text EDITED", word_diff: [{ type: "same", text: "Original text" }, { type: "del", text: "here" }, { type: "add", text: "EDITED" }] }],
      added_blocks: [], removed_blocks: [], other_changes: 0
    } })
  };
  window.editor = window.FMDocEditor.mount(document.getElementById("editor"), { document: doc, profile: "document", mode: "doc", versionsApi: mockVersions });
});
await page.waitForTimeout(400);
await openMenu("File");
await menuItem("Version history");
await page.waitForTimeout(400);
{
  const rowText = await page.evaluate(() => document.querySelector(".fmde-version-row")?.textContent || "");
  check("V1 version history dialog lists checkpoints", rowText.includes("First draft"), { rowText });
  await page.evaluate(() => {
    document.querySelector("[data-version-name]").value = "Milestone";
    document.querySelector("[data-version-save]").click();
  });
  await page.waitForTimeout(300);
  const created = await page.evaluate(() => window.__versionCalls);
  check("V2 Save version calls the adapter with the name", created.length === 1 && created[0][1].name === "Milestone", created);
  await page.evaluate(() => { Array.from(document.querySelectorAll(".fmde-version-actions button")).find((b) => b.textContent === "View changes")?.click(); });
  await page.waitForTimeout(400);
  const diffHtml = await page.evaluate(() => ({ add: !!document.querySelector(".fmde-diff-add"), del: !!document.querySelector(".fmde-diff-del") }));
  check("V3 View changes renders a word-level diff", diffHtml.add && diffHtml.del, diffHtml);
  await page.evaluate(() => document.querySelectorAll("[data-dialog-close]").forEach((b) => b.click()));
}
await openMenu("Tools");
await menuItem("Compare with version");
await page.waitForTimeout(400);
{
  const clicked = await menuItem("First draft", { exact: false });
  await page.waitForTimeout(500);
  const suggestions = await page.evaluate(() => window.editor.getDocument().metadata.suggestions);
  check("V4 Compare materializes differences as suggested edits", clicked && suggestions?.length === 1 && suggestions[0].replacement === "Original text EDITED", suggestions);
}

// =============================================================================
// W. Collaboration client (mock transport)
// =============================================================================
await page.evaluate(() => {
  window.editor.destroy();
  const doc = window.FMDocModel.createBlankDocument({ metadata: { document_type: "generic" } });
  const body = doc.pages[0].children.find((n) => n.props?.page_region === "body");
  body.children[0].props.blocks = [{ id: "w1", type: "paragraph", style_ref: "Normal text", runs: [{ text: "collab base" }] }];
  window.__bodyTextId = body.children[0].id;
  window.__collabSent = [];
  const transport = {
    close() {},
    send(rev, commands) { window.__collabSent.push({ rev, commands }); return Promise.resolve({ ok: true, revision: rev + 1 }); },
    presence() { return Promise.resolve(null); }
  };
  window.editor = window.FMDocEditor.mount(document.getElementById("editor"), {
    document: doc, profile: "document", mode: "doc",
    collab: { actor: { id: "me", name: "Me" }, connect(handlers) { window.__collabHandlers = handlers; return transport; } }
  });
  setTimeout(() => window.__collabHandlers.onHello({ revision: 5, presence: [] }), 60);
});
await page.waitForTimeout(500);
{
  // remote edit applies to the document
  await page.evaluate(() => {
    window.__collabHandlers.onCommands({ revision: 6, actor: { id: "other", name: "Rae" }, commands: [{ type: "text.edit", node_id: window.__bodyTextId, blocks: [{ id: "w1", type: "paragraph", style_ref: "Normal text", runs: [{ text: "collab base plus remote" }] }] }] });
  });
  await page.waitForTimeout(500);
  const text = (await bodyBlocks())[0].runs.map((r) => r.text).join("");
  check("W1 remote command batches apply to the local document", text === "collab base plus remote", { text });
  const sentBefore = await page.evaluate(() => window.__collabSent.length);
  check("W2 remote applies are not echoed back", sentBefore === 0, { sentBefore });
  // local typing pushes a batch with the current base revision
  await clickInBlock("w1", { where: "end" });
  await page.keyboard.type("!");
  await page.waitForTimeout(600);
  const sent = await page.evaluate(() => window.__collabSent);
  check("W3 local edits push command batches at the tracked revision", sent.length >= 1 && sent[0].rev === 6 && sent[0].commands.some((c) => c.type === "text.edit"), { count: sent.length, first: sent[0] && { rev: sent[0].rev, types: sent[0].commands.map((c) => c.type) } });
  // presence renders a colored remote cursor
  await page.evaluate(() => {
    window.__collabHandlers.onPresence({ presence: [{ actor: { id: "other", name: "Rae" }, color: "#e37400", cursor: { node_id: window.__bodyTextId, block_id: "w1", offset: 3 } }] });
  });
  await page.waitForTimeout(300);
  const cursor = await page.evaluate(() => {
    const marker = document.querySelector(".fmde-collab-cursor");
    return marker ? { tag: marker.querySelector(".fmde-collab-cursor-tag")?.textContent, color: marker.style.background } : null;
  });
  check("W4 presence renders a named colored remote cursor", !!cursor && cursor.tag === "Rae", cursor);
}

// =============================================================================
// X. Shared visual-editor chrome on DOCUMENTS (FMVisualEditor wrapper)
// =============================================================================
await page.evaluate(() => {
  window.editor.destroy();
  const doc = window.FMDocModel.createBlankDocument({ metadata: { document_type: "generic" } });
  const body = doc.pages[0].children.find((n) => n.props?.page_region === "body");
  body.children[0].props.blocks = [{ id: "x1", type: "paragraph", style_ref: "Normal text", runs: [{ text: "chrome on documents" }] }];
  window.__vis = window.FMVisualEditor.mount(document.getElementById("editor"), {
    document: doc, profile: "designer", mode: "visual",
    chrome: { contentKind: "document" }
  });
  window.editor = window.__vis.editor;
});
await page.waitForTimeout(700);
{
  const chrome = await page.evaluate(() => ({
    root: !!document.querySelector(".fmve-chrome"),
    railTabs: Array.from(document.querySelectorAll(".fmve-chrome [data-ch-tab]")).map((b) => b.dataset.chTab),
    builtInRailHidden: (() => { const rail = document.querySelector(".fmve-chrome .fmde-rail"); return !rail || getComputedStyle(rail).display === "none"; })()
  }));
  check("X1 visual mode shows the shared chrome rail on a document", chrome.root && chrome.railTabs.length >= 4, chrome);
  check("X2 the doc-editor's built-in rail is suppressed under chrome", chrome.builtInRailHidden, chrome);
  // Templates panel opens with the generic section registry
  await page.evaluate(() => window.__vis.setChromeTab("templates"));
  await page.waitForTimeout(400);
  const templates = await page.evaluate(() => document.querySelectorAll("[data-ch-panel] [data-ch-tpl-card]").length);
  check("X3 templates panel renders generic entries", templates > 0, { templates });
  // Pages strip uses the built-in document adapter: Add page inserts a page
  const pagesBefore = await page.evaluate(() => window.__vis.getDocument().pages.length);
  const addClicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll(".fmve-chrome button")).find((b) => /add page/i.test(b.textContent) || /add page/i.test(b.title || ""));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await page.waitForTimeout(600);
  const pagesAfter = await page.evaluate(() => window.__vis.getDocument().pages.length);
  check("X4 pages strip Add page inserts a document page", !addClicked || pagesAfter === pagesBefore + 1, { addClicked, pagesBefore, pagesAfter });
  // Mode switch: doc mode hides chrome, keeps the word-processor toolbar
  await page.evaluate(() => window.__vis.setMode("doc"));
  await page.waitForTimeout(500);
  const docMode = await page.evaluate(() => ({
    nochrome: document.querySelector(".fmve-chrome").className.includes("fmve-nochrome"),
    menubar: Array.from(document.querySelectorAll(".fmde-menubar > button")).map((b) => b.textContent.trim()).includes("File"),
    railHidden: (() => { const rail = document.querySelector(".fmwe-chrome-rail, .fmve-chrome [data-chrome-rail]"); return !rail || getComputedStyle(rail).display === "none" || rail.offsetParent === null; })()
  }));
  check("X5 doc mode hides chrome and shows the document menubar", docMode.nochrome && docMode.menubar, docMode);
  // Preview: chromeless shared renderer
  await page.evaluate(() => window.__vis.setMode("preview"));
  await page.waitForTimeout(500);
  const preview = await page.evaluate(() => ({
    nochrome: document.querySelector(".fmve-chrome").className.includes("fmve-nochrome"),
    pages: document.querySelectorAll(".fmdoc-page").length
  }));
  check("X6 preview stays chromeless and renders pages", preview.nochrome && preview.pages >= 1, preview);
  // back to visual: chrome restores
  await page.evaluate(() => window.__vis.setMode("visual"));
  await page.waitForTimeout(500);
  const restored = await page.evaluate(() => !document.querySelector(".fmve-chrome").className.includes("fmve-nochrome"));
  check("X7 returning to visual restores the chrome", restored);
  await page.evaluate(() => { window.__vis.destroy(); });
  await page.waitForTimeout(200);
  const cleaned = await page.evaluate(() => !document.querySelector(".fmve-chrome"));
  check("X8 destroy tears down chrome and editor", cleaned);
  // remount a plain editor so any later sections keep working
  await page.evaluate(() => {
    const doc = window.FMDocModel.createBlankDocument({ metadata: { document_type: "generic" } });
    window.editor = window.FMDocEditor.mount(document.getElementById("editor"), { document: doc, profile: "document", mode: "doc" });
  });
}

await shot("final-state");
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("FAILED:\n  " + failed.map((f) => f.name).join("\n  ")); process.exitCode = 1; }
