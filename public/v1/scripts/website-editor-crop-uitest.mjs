/**
 * Headless interaction test for the 2026-07-30 web-editor round: fluid-page
 * width, vertical-only section resize, live shape-fill resize preview and the
 * Canva-style crop mode.
 *
 *   node scripts/website-editor-crop-uitest.mjs      (from public/v1)
 *   npm run test:website-crop
 *
 * Requires the local web host on :8011 (uses the dev-website.html harness
 * with ?fixture=fill — no API needed).
 *
 * Covers:
 *  1. fluid (fill) blank page renders full-width in the editor (no 0-width collapse)
 *  2. page-width drag bars are gone; sections expose vertical resize only
 *  3. shape image-fill live resize preview stays true (viewBox tracks the drag)
 *  4. crop mode: dblclick opens, pan clamps to coverage, Enter/outside-click
 *     commits props.crop / style.fill.crop, Esc cancels
 */
import { chromium } from "playwright-core";
import { access } from "node:fs/promises";

const HARNESS = "http://127.0.0.1:8011/libraries/doc-editor/dev-website.html?fixture=fill";
const IMG_URL = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="140"><rect width="200" height="140" fill="#94a3b8"/><circle cx="60" cy="60" r="30" fill="#f59e0b"/></svg>');

async function browserPath() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
  ];
  for (const c of candidates) { try { await access(c); return c; } catch {} }
  throw new Error("no Chrome/Edge found");
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : "  " + JSON.stringify(detail)}`);
};

const browser = await chromium.launch({ executablePath: await browserPath(), headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("   [pageerror]", e.message));
await page.goto(HARNESS, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
await page.waitForTimeout(2500); // normalization settles

// ---- 1. fluid page renders full width --------------------------------------
const geo = await page.evaluate(() => {
  const stage = document.querySelector(".fmde-stage");
  const pg = document.querySelector(".fmdoc-page");
  const section = document.querySelector('[data-node-id="' + window.editor.getDocument().root.children[0].id + '"]');
  const sectionRects = Array.from(document.querySelectorAll('.fmdoc-view > [data-node-id] > [data-node-type="frame"]')).map((el) => {
    const rect = el.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  });
  return {
    stageW: stage.getBoundingClientRect().width,
    pageW: pg.getBoundingClientRect().width,
    sectionW: section ? section.getBoundingClientRect().width : 0,
    pwHandles: document.querySelectorAll(".fmde-pwhandle").length,
    sectionRects
  };
});
check("fluid page renders at a real width (not 0)", geo.pageW > 400, geo);
check("section spans the page", Math.abs(geo.sectionW - geo.pageW) < 3, { sectionW: geo.sectionW });
check("website sections are flush with no root gutter", geo.sectionRects.length < 2 || Math.abs(geo.sectionRects[1].top - geo.sectionRects[0].bottom) < 1, geo.sectionRects);
check("page-width drag bars are gone", geo.pwHandles === 0);

// ---- 2. sections resize vertically only -----------------------------------
const sectionId = await page.evaluate(() => {
  const id = window.editor.getDocument().root.children[0].id;
  window.editor.select([id]);
  return id;
});
await page.waitForTimeout(300);
const handles = await page.evaluate(() => {
  const dirs = {};
  document.querySelectorAll(".fmde-selbox [data-fmde-handle]").forEach((h) => {
    const r = h.getBoundingClientRect();
    dirs[h.getAttribute("data-fmde-handle")] = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  return dirs;
});
check("section selection exposes only vertical handles", Object.keys(handles).sort().join(",") === "n,s", Object.keys(handles));

const beforeDrag = await page.evaluate(() => ({
  paper: window.editor.getDocument().settings.paper,
  pageW: document.querySelector(".fmdoc-page").getBoundingClientRect().width,
  sectionH: document.querySelector('[data-node-id="' + window.editor.getDocument().root.children[0].id + '"]').getBoundingClientRect().height
}));
await page.mouse.move(handles.s.x, handles.s.y);
await page.mouse.down();
await page.mouse.move(handles.s.x, handles.s.y + 60, { steps: 6 });
const midDrag = await page.evaluate(() => ({
  pageW: document.querySelector(".fmdoc-page").getBoundingClientRect().width,
  sectionH: document.querySelector('[data-node-id="' + window.editor.getDocument().root.children[0].id + '"]').getBoundingClientRect().height
}));
await page.mouse.up();
await page.waitForTimeout(600);
const afterDrag = await page.evaluate(() => ({
  paper: window.editor.getDocument().settings.paper,
  pageW: document.querySelector(".fmdoc-page").getBoundingClientRect().width,
  sectionH: document.querySelector('[data-node-id="' + window.editor.getDocument().root.children[0].id + '"]').getBoundingClientRect().height
}));
check("dragging the bottom handle live-resizes only section height", midDrag.sectionH > beforeDrag.sectionH + 50 && Math.abs(midDrag.pageW - beforeDrag.pageW) < 2, { before: beforeDrag, mid: midDrag });
check("vertical resize does not convert the fluid page to fixed width", afterDrag.paper.size === "fill", afterDrag.paper);
check("committed section height matches the drag", Math.abs(afterDrag.sectionH - midDrag.sectionH) < 8 && Math.abs(afterDrag.pageW - beforeDrag.pageW) < 2, { mid: midDrag, after: afterDrag });

// Empty template image slots are real image nodes: they show an affordance
// and double-clicking invokes the configured media picker rather than crop.
const emptyImageId = await page.evaluate(() => {
  const section = window.editor.getDocument().root.children[0];
  const node = FMDocModel.createNode("image", { name: "Empty image", frame: { x: 430, y: 18, w: 150, h: 90, z: 7 }, props: { media: null, fit: "cover", alt: "" } });
  window.editor.apply({ type: "node.insert", node, parent_id: section.id });
  return node.id;
});
await page.waitForTimeout(350);
const emptyHint = await page.evaluate((id) => {
  const el = document.querySelector('[data-node-id="' + id + '"]');
  return { imageType: el?.getAttribute("data-node-type"), hint: el?.querySelector(".fmdoc-image-empty-hint")?.textContent.trim() || "" };
}, emptyImageId);
check("empty template image renders as an interactive image slot", emptyHint.imageType === "image" && /double-click/i.test(emptyHint.hint), emptyHint);
const emptyImagePoint = await page.evaluate((id) => { const r = document.querySelector('[data-node-id="' + id + '"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, emptyImageId);
await page.mouse.dblclick(emptyImagePoint.x, emptyImagePoint.y);
await page.waitForFunction((id) => {
  let node = null;
  (function walk(item) { if (!item || node) return; if (item.id === id) { node = item; return; } (item.children || []).forEach(walk); })(window.editor.getDocument().root);
  return !!(node && node.props && node.props.media);
}, emptyImageId);
const pickedEmptyImage = await page.evaluate((id) => {
  let node = null;
  (function walk(item) { if (!item || node) return; if (item.id === id) { node = item; return; } (item.children || []).forEach(walk); })(window.editor.getDocument().root);
  return node && node.props && node.props.media;
}, emptyImageId);
check("double-clicking an empty image fills that slot through the media picker", !!pickedEmptyImage, pickedEmptyImage);

// ---- 3. shape image-fill live resize ---------------------------------------
const shapeId = await page.evaluate((imgUrl) => {
  const doc = window.editor.getDocument();
  const sec = doc.root.children[0];
  const node = FMDocModel.createNode("shape", {
    name: "Rounded photo label",
    frame: { x: 60, y: 10, w: 120, h: 90, z: 9 },
    props: { shape: "rect", corner_radius: 14, text: "Photo", text_style: { family: "Georgia", size_pt: 21, weight: 700, italic: true, underline: true, color: "#ffffff" }, text_align: "center", text_valign: "middle" },
    style: { fill: { type: "image", media: { url: imgUrl }, fit: "cover" }, stroke: { color: "#2563eb", width_pt: 4 } }
  });
  window.editor.apply({ type: "node.insert", node, parent_id: sec.id });
  window.editor.select([node.id]);
  return node.id;
}, IMG_URL);
await page.waitForTimeout(700);

const seHandle = await page.evaluate(() => {
  const h = document.querySelector('.fmde-selbox [data-fmde-handle="se"]');
  const r = h.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.move(seHandle.x, seHandle.y);
await page.mouse.down();
await page.mouse.move(seHandle.x + 80, seHandle.y + 10, { steps: 5 });
const midShape = await page.evaluate((id) => {
  const el = document.querySelector('[data-node-id="' + id + '"]');
  const svg = el.querySelector("svg");
  const vb = svg.getAttribute("viewBox").split(" ").map(Number);
  const r = el.getBoundingClientRect();
  const image = svg.querySelector("pattern image");
  const shape = svg.querySelector(":scope > rect");
  return {
    vbW: vb[2], vbH: vb[3],
    elRatio: r.width / r.height,
    vbRatio: vb[2] / vb[3],
    imgW: Number(image.getAttribute("width")),
    imgH: Number(image.getAttribute("height")),
    par: image.getAttribute("preserveAspectRatio"),
    border: {
      x: Number(shape.getAttribute("x")), y: Number(shape.getAttribute("y")),
      w: Number(shape.getAttribute("width")), h: Number(shape.getAttribute("height")),
      rx: Number(shape.getAttribute("rx")), stroke: Number(shape.getAttribute("stroke-width"))
    }
  };
}, shapeId);
await page.mouse.up();
await page.waitForTimeout(500);
check("mid-resize the shape viewBox tracks the element (no stale stretch)", Math.abs(midShape.elRatio - midShape.vbRatio) < 0.03, midShape);
check("mid-resize the fill image covers the live viewBox", Math.abs(midShape.imgW - midShape.vbW) < 0.5 && Math.abs(midShape.imgH - midShape.vbH) < 0.5, { imgW: midShape.imgW, vbW: midShape.vbW });
check("fill image keeps cover semantics mid-drag", midShape.par === "xMidYMid slice", midShape.par);
const committedShape = await page.evaluate((id) => {
  const svg = document.querySelector('[data-node-id="' + id + '"] svg');
  const shape = svg.querySelector(":scope > rect");
  const vb = svg.getAttribute("viewBox").split(" ").map(Number);
  return {
    vbW: vb[2], vbH: vb[3],
    border: {
      x: Number(shape.getAttribute("x")), y: Number(shape.getAttribute("y")),
      w: Number(shape.getAttribute("width")), h: Number(shape.getAttribute("height")),
      rx: Number(shape.getAttribute("rx")), stroke: Number(shape.getAttribute("stroke-width"))
    }
  };
}, shapeId);
check("live border width and corner geometry exactly match the committed resize", JSON.stringify(midShape.border) === JSON.stringify(committedShape.border) && Math.abs(midShape.vbW - committedShape.vbW) < 0.01 && Math.abs(midShape.vbH - committedShape.vbH) < 0.01, { live: midShape, committed: committedShape });
const resizedFrame = await page.evaluate((id) => {
  let node = null;
  (function walk(item) { if (!item || node) return; if (item.id === id) { node = item; return; } (item.children || []).forEach(walk); })(window.editor.getDocument().root);
  return node && { ...node.frame };
}, shapeId);
await page.keyboard.press("Control+z");
await page.waitForTimeout(450);
const undoneFrame = await page.evaluate((id) => {
  let node = null;
  (function walk(item) { if (!item || node) return; if (item.id === id) { node = item; return; } (item.children || []).forEach(walk); })(window.editor.getDocument().root);
  return node && { ...node.frame };
}, shapeId);
check("Ctrl+Z restores a resized item", !!undoneFrame && Math.abs(undoneFrame.w - 120) < 0.1 && Math.abs(undoneFrame.h - 90) < 0.1, { resizedFrame, undoneFrame });
await page.keyboard.press("Control+y");
await page.waitForTimeout(450);
const redoneFrame = await page.evaluate((id) => {
  let node = null;
  (function walk(item) { if (!item || node) return; if (item.id === id) { node = item; return; } (item.children || []).forEach(walk); })(window.editor.getDocument().root);
  return node && { ...node.frame };
}, shapeId);
check("Ctrl+Y restores the resize", !!redoneFrame && Math.abs(redoneFrame.w - resizedFrame.w) < 0.1 && Math.abs(redoneFrame.h - resizedFrame.h) < 0.1, { resizedFrame, redoneFrame });

// ---- 4. crop mode ----------------------------------------------------------
const shapeCenter = await page.evaluate((id) => {
  const r = document.querySelector('[data-node-id="' + id + '"]').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
}, shapeId);
await page.mouse.click(shapeCenter.x, shapeCenter.y, { button: "right" });
await page.waitForTimeout(200);
const visualContextMenu = await page.evaluate(() => {
  const menu = document.querySelector(".fmde-element-context");
  return menu ? {
    labels: Array.from(menu.querySelectorAll(".fmde-menu-label")).map((el) => el.textContent.trim()),
    styleButtons: menu.querySelectorAll(".fmde-context-style-btn").length
  } : null;
});
check("Visual elements expose layer, duplicate/delete, and four appearance controls on right-click", !!visualContextMenu && visualContextMenu.styleButtons === 4 && ["Bring to front", "Bring forward", "Send backward", "Send to back", "Duplicate", "Delete"].every((label) => visualContextMenu.labels.includes(label)), visualContextMenu);
const lineWidthAnchor = await page.locator('.fmde-element-context [aria-label="Line width"]').boundingBox();
await page.locator('.fmde-element-context [aria-label="Line width"]').click();
await page.waitForTimeout(180);
const lineWidthMenu = await page.locator('.fmde-style-menu[aria-label="Line width"]').boundingBox();
check("right-click line-width editor stays anchored to its mini-control", !!lineWidthAnchor && !!lineWidthMenu && lineWidthMenu.x > 8 && lineWidthMenu.y > 8 && Math.abs(lineWidthMenu.x - lineWidthAnchor.x) < 3 && Math.abs(lineWidthMenu.y - (lineWidthAnchor.y + lineWidthAnchor.height + 4)) < 4, { anchor: lineWidthAnchor, menu: lineWidthMenu });
await page.keyboard.press("Escape");
await page.mouse.click(shapeCenter.x, shapeCenter.y, { button: "right" });
await page.waitForTimeout(180);
const cornersAnchor = await page.locator('.fmde-element-context [aria-label="Corners"]').boundingBox();
await page.locator('.fmde-element-context [aria-label="Corners"]').click();
await page.waitForTimeout(180);
const cornersMenu = await page.locator('.fmde-style-menu[aria-label="Corners"]').boundingBox();
check("right-click corners editor stays anchored to its mini-control", !!cornersAnchor && !!cornersMenu && cornersMenu.x > 8 && cornersMenu.y > 8 && Math.abs(cornersMenu.x - cornersAnchor.x) < 3 && Math.abs(cornersMenu.y - (cornersAnchor.y + cornersAnchor.height + 4)) < 4, { anchor: cornersAnchor, menu: cornersMenu });
await page.keyboard.press("Escape");
await page.mouse.click(shapeCenter.x, shapeCenter.y, { button: "right" });
await page.locator(".fmde-element-context .fmde-menu-item", { hasText: "Duplicate" }).click();
await page.waitForTimeout(350);
const duplicateCount = await page.evaluate(() => {
  let count = 0;
  (function walk(node) { if (!node) return; if (node.name === "Rounded photo label") count += 1; (node.children || []).forEach(walk); })(window.editor.getDocument().root);
  return count;
});
check("context-menu Duplicate performs the undoable element command", duplicateCount === 2, duplicateCount);
await page.evaluate((id) => { window.editor.undo(); window.editor.select([id]); }, shapeId);
await page.waitForTimeout(400);
await page.mouse.dblclick(shapeCenter.x, shapeCenter.y);
await page.waitForTimeout(400);
const cropUi = await page.evaluate(() => {
  const ui = document.querySelector(".fmde-cropui");
  if (!ui) return null;
  const ghost = ui.querySelector(".fmde-crop-ghost");
  const solid = ui.querySelector(".fmde-crop-solid");
  const box = ui.querySelector(".fmde-crop-imgbox");
  const preview = ui.querySelector(".fmde-crop-object-preview");
  const previewTextEl = preview && preview.querySelector(".fmde-crop-object-text");
  const previewTextStyle = previewTextEl && getComputedStyle(previewTextEl);
  const g = ghost.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  return {
    ghostOpacity: getComputedStyle(ghost).opacity,
    solidClip: solid.style.clipPath,
    handles: ui.querySelectorAll(".fmde-crop-handle").length,
    previewText: preview ? preview.textContent : "",
    previewOpacity: preview ? getComputedStyle(preview).opacity : null,
    previewRadius: preview ? getComputedStyle(preview).borderRadius : null,
    previewBorder: preview ? getComputedStyle(preview).boxShadow : null,
    previewFont: previewTextStyle ? previewTextStyle.fontFamily : null,
    previewFontSize: previewTextStyle ? previewTextStyle.fontSize : null,
    previewFontWeight: previewTextStyle ? previewTextStyle.fontWeight : null,
    previewFontStyle: previewTextStyle ? previewTextStyle.fontStyle : null,
    previewDecoration: previewTextStyle ? previewTextStyle.textDecorationLine : null,
    imgBox: { x: b.x, y: b.y, w: b.width, h: b.height },
    ghostBox: { w: g.width, h: g.height }
  };
});
check("dblclick on an image-filled shape opens crop mode", !!cropUi, cropUi && { handles: cropUi.handles });
check("full image shows translucent with a solid viewport layer", !!cropUi && Number(cropUi.ghostOpacity) < 0.6 && /inset/.test(cropUi.solidClip), cropUi && { opacity: cropUi.ghostOpacity, clip: cropUi.solidClip });
check("crop mode preserves translucent text, border and rounded corners", !!cropUi && cropUi.previewText === "Photo" && Number(cropUi.previewOpacity) < 0.6 && cropUi.previewRadius !== "0px" && cropUi.previewBorder !== "none", cropUi && { text: cropUi.previewText, opacity: cropUi.previewOpacity, radius: cropUi.previewRadius, border: cropUi.previewBorder });
check("crop text keeps its rendered font size and styling", !!cropUi && /Georgia/i.test(cropUi.previewFont) && parseFloat(cropUi.previewFontSize) > 27 && cropUi.previewFontWeight === "700" && cropUi.previewFontStyle === "italic" && /underline/.test(cropUi.previewDecoration), cropUi && { font: cropUi.previewFont, size: cropUi.previewFontSize, weight: cropUi.previewFontWeight, style: cropUi.previewFontStyle, decoration: cropUi.previewDecoration });
check("crop box is larger than the viewport (cover default)", !!cropUi && cropUi.imgBox.w >= shapeCenter.w - 1, cropUi && { imgW: cropUi.imgBox.w, viewportW: shapeCenter.w });

// pan the image along its slack axis (this aspect pair leaves vertical
// slack), then commit with Enter
const panFrom = { x: shapeCenter.x, y: shapeCenter.y };
await page.mouse.move(panFrom.x, panFrom.y);
await page.mouse.down();
await page.mouse.move(panFrom.x, panFrom.y - 40, { steps: 4 });
await page.mouse.up();
await page.keyboard.press("Enter");
await page.waitForTimeout(600);
const afterCrop = await page.evaluate((id) => {
  let node = null;
  (function walk(n) { if (!n || node) return; if (n.id === id) { node = n; return; } (n.children || []).forEach(walk); })(window.editor.getDocument().root);
  const el = document.querySelector('[data-node-id="' + id + '"]');
  const image = el.querySelector("pattern image");
  return {
    crop: node.style.fill.crop || null,
    uiGone: !document.querySelector(".fmde-cropui"),
    par: image.getAttribute("preserveAspectRatio"),
    imgY: Number(image.getAttribute("y"))
  };
}, shapeId);
check("commit writes style.fill.crop", !!afterCrop.crop && afterCrop.crop.w >= 1 && afterCrop.crop.h >= 1, afterCrop.crop);
check("crop pan moved the image up (y above centered)", !!afterCrop.crop && afterCrop.crop.y < -0.01 && afterCrop.crop.y >= 1 - afterCrop.crop.h - 0.01, afterCrop.crop);
check("crop UI closes on commit", afterCrop.uiGone);
check("cropped shape renders without stretching at the crop rect", afterCrop.par === "xMidYMid slice" && afterCrop.imgY < 0, { par: afterCrop.par, imgY: afterCrop.imgY });

// re-enter and cancel with Escape — crop unchanged
await page.mouse.dblclick(shapeCenter.x, shapeCenter.y);
await page.waitForTimeout(400);
const reopened = await page.evaluate(() => !!document.querySelector(".fmde-cropui"));
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
const afterCancel = await page.evaluate((id) => {
  let node = null;
  (function walk(n) { if (!n || node) return; if (n.id === id) { node = n; return; } (n.children || []).forEach(walk); })(window.editor.getDocument().root);
  return { crop: node.style.fill.crop, uiGone: !document.querySelector(".fmde-cropui") };
}, shapeId);
check("crop mode reopens with the saved crop", reopened);
check("Escape cancels without changing the crop", afterCancel.uiGone && JSON.stringify(afterCancel.crop) === JSON.stringify(afterCrop.crop));

// Background colors can sit above image fills with independent translucency,
// and the same palette can remove only the image while retaining that color.
await page.mouse.click(shapeCenter.x, shapeCenter.y, { button: "right" });
await page.locator('.fmde-element-context [aria-label="Background color"]').click();
await page.waitForTimeout(150);
const imageBackgroundMenu = await page.evaluate(() => ({
  opacity: !!document.querySelector('.fmde-color-menu [aria-label="Background translucency"]'),
  remove: !!document.querySelector('.fmde-color-menu .fmde-color-remove-image')
}));
check("background palette shows translucency and remove-image controls for an image fill", imageBackgroundMenu.opacity && imageBackgroundMenu.remove, imageBackgroundMenu);
await page.locator('.fmde-color-menu [data-color="#3d85c6"]').first().click();
await page.locator('.fmde-color-menu [aria-label="Background translucency"]').evaluate((slider) => {
  slider.value = "40";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(500);
const imageOverlayState = await page.evaluate((id) => {
  const found = FMDocModel.findNode(window.editor.getDocument(), id);
  const overlay = document.querySelector('[data-node-id="' + id + '"] [data-fmdoc-fill-overlay]');
  return {
    fill: found && found.node.style.fill,
    renderedColor: overlay && overlay.getAttribute("fill"),
    renderedOpacity: overlay && Number(overlay.getAttribute("fill-opacity"))
  };
}, shapeId);
check("translucent background color renders above the image", imageOverlayState.fill.type === "image" && imageOverlayState.fill.overlay_color === "#3d85c6" && Math.abs(imageOverlayState.fill.overlay_opacity - 0.6) < 0.01 && imageOverlayState.renderedColor === "#3d85c6" && Math.abs(imageOverlayState.renderedOpacity - 0.6) < 0.01, imageOverlayState);
await page.locator('.fmde-color-menu .fmde-color-remove-image').click();
await page.waitForTimeout(500);
const removedBackgroundImage = await page.evaluate((id) => {
  const found = FMDocModel.findNode(window.editor.getDocument(), id);
  return found && found.node.style.fill;
}, shapeId);
check("removing the background image retains its translucent overlay as a solid fill", removedBackgroundImage.type === "solid" && removedBackgroundImage.color === "#3d85c6" && Math.abs(removedBackgroundImage.opacity - 0.6) < 0.01 && !removedBackgroundImage.media, removedBackgroundImage);

// ---- 5. image NODE crop entry ----------------------------------------------
const imageNodeId = await page.evaluate((imgUrl) => {
  const doc = window.editor.getDocument();
  const sec = doc.root.children[0];
  const node = FMDocModel.createNode("image", {
    name: "Photo",
    frame: { x: 240, y: 12, w: 140, h: 100, z: 10 },
    props: { media: { url: imgUrl }, fit: "cover", alt: "" }
  });
  window.editor.apply({ type: "node.insert", node, parent_id: sec.id });
  return node.id;
}, IMG_URL);
await page.waitForTimeout(600);
const imgCenter = await page.evaluate((id) => {
  const r = document.querySelector('[data-node-id="' + id + '"]').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, imageNodeId);
await page.mouse.dblclick(imgCenter.x, imgCenter.y);
await page.waitForTimeout(400);
const imgCropOpen = await page.evaluate(() => !!document.querySelector(".fmde-cropui"));
// commit by clicking the gray canvas (inside .fmde-canvas, outside the page)
const grayPoint = await page.evaluate(() => {
  const c = document.querySelector(".fmde-canvas").getBoundingClientRect();
  return { x: c.x + c.width - 20, y: c.y + c.height - 20 };
});
await page.mouse.click(grayPoint.x, grayPoint.y);
await page.waitForTimeout(500);
const imgNodeCrop = await page.evaluate((id) => {
  let node = null;
  (function walk(n) { if (!n || node) return; if (n.id === id) { node = n; return; } (n.children || []).forEach(walk); })(window.editor.getDocument().root);
  const img = document.querySelector('[data-node-id="' + id + '"] img');
  return { crop: node.props.crop || null, uiGone: !document.querySelector(".fmde-cropui"), imgLeft: img ? img.style.left : null, objectFit: img ? img.style.objectFit : null };
}, imageNodeId);
check("dblclick an image node opens crop mode", imgCropOpen);
check("click outside commits props.crop on the image node", !!imgNodeCrop.crop && imgNodeCrop.uiGone, imgNodeCrop.crop);
check("image node renders with the crop placement", !!imgNodeCrop.imgLeft && /%$/.test(imgNodeCrop.imgLeft), imgNodeCrop.imgLeft);
check("cropped image nodes preserve their source aspect ratio", imgNodeCrop.objectFit === "cover", imgNodeCrop.objectFit);

// ---- 6. multi-selection appearance + grouping ------------------------------
const groupFixture = await page.evaluate(() => {
  const doc = window.editor.getDocument();
  const parent = doc.root.children[0];
  const a = FMDocModel.createNode("shape", {
    name: "Group blue", frame: { x: 280, y: 30, w: 90, h: 62, z: 20 },
    props: { shape: "rect", corner_radius: 4 },
    style: { fill: { type: "solid", color: "#2563eb" }, stroke: { color: "#111111", width_pt: 2 } }
  });
  const b = FMDocModel.createNode("shape", {
    name: "Group gold", frame: { x: 385, y: 30, w: 90, h: 62, z: 21 },
    props: { shape: "rect", corner_radius: 12 },
    style: { fill: { type: "solid", color: "#f59e0b" }, stroke: { color: "#6b21a8", width_pt: 5 } }
  });
  window.editor.apply({ type: "node.insert", node: a, parent_id: parent.id });
  window.editor.apply({ type: "node.insert", node: b, parent_id: parent.id });
  window.editor.select([a.id, b.id]);
  return { a: a.id, b: b.id };
});
await page.waitForTimeout(500);
const groupFixtureCenter = await page.evaluate((ids) => {
  const el = document.querySelector('[data-node-id="' + ids.a + '"]');
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, groupFixture);
await page.mouse.click(groupFixtureCenter.x, groupFixtureCenter.y, { button: "right" });
await page.waitForTimeout(180);
const mixedContext = await page.evaluate(() => ({
  mixed: Array.from(document.querySelectorAll(".fmde-element-context .fmde-context-style-btn.mixed")).map((el) => el.getAttribute("aria-label")),
  labels: Array.from(document.querySelectorAll(".fmde-element-context .fmde-menu-label")).map((el) => el.textContent.trim())
}));
check("multi-selection context menu shows clickable mixed appearance controls and Group", ["Background color", "Border color", "Line width", "Corners"].every((label) => mixedContext.mixed.includes(label)) && mixedContext.labels.includes("Group"), mixedContext);
await page.locator('.fmde-element-context [aria-label="Border color"]').click();
await page.locator('.fmde-color-menu [aria-label="#cc0000"]').click();
await page.waitForTimeout(450);
const sharedBorder = await page.evaluate((ids) => ids.map((id) => FMDocModel.findNode(window.editor.getDocument(), id).node.style.stroke.color), [groupFixture.a, groupFixture.b]);
check("setting a mixed border color applies it to every selected element", sharedBorder.every((color) => color === "#cc0000"), sharedBorder);
await page.mouse.click(groupFixtureCenter.x, groupFixtureCenter.y, { button: "right" });
await page.waitForTimeout(180);
const resolvedMixed = await page.evaluate(() => ({
  borderMixed: document.querySelector('.fmde-element-context [aria-label="Border color"]').classList.contains("mixed"),
  widthMixed: document.querySelector('.fmde-element-context [aria-label="Line width"]').classList.contains("mixed")
}));
check("a resolved property stops appearing mixed while other conflicts remain gray", !resolvedMixed.borderMixed && resolvedMixed.widthMixed, resolvedMixed);
await page.locator(".fmde-element-context .fmde-menu-item", { hasText: "Group" }).click();
await page.waitForTimeout(500);
const groupedState = await page.evaluate((ids) => {
  const selected = window.editor.selection();
  const group = selected.length === 1 && FMDocModel.findNode(window.editor.getDocument(), selected[0]);
  const blueOutline = document.querySelector('[data-fmde-group-member="' + ids.a + '"]');
  return {
    selected,
    marked: !!(group && group.node.props && group.node.props.fmde_group),
    members: document.querySelectorAll(".fmde-selbox.group-member").length,
    blueOutline: blueOutline && blueOutline.style.getPropertyValue("--fmde-selection-color")
  };
}, groupFixture);
check("a group selects as one object and shows dotted member outlines", groupedState.marked && groupedState.selected.length === 1 && groupedState.members === 2, groupedState);
check("selection outlines switch to a contrasting color over matching blue artwork", /255/.test(groupedState.blueOutline) || groupedState.blueOutline === "#ffffff", groupedState.blueOutline);
await page.mouse.click(groupFixtureCenter.x, groupFixtureCenter.y, { button: "right" });
await page.waitForTimeout(180);
const removeFromGroupVisible = await page.locator(".fmde-element-context .fmde-menu-item", { hasText: "Remove from group" }).count();
check("right-clicking a grouped member offers Remove from group", removeFromGroupVisible === 1, removeFromGroupVisible);
if (removeFromGroupVisible) await page.locator(".fmde-element-context .fmde-menu-item", { hasText: "Remove from group" }).click();
await page.waitForTimeout(500);
const detachedState = await page.evaluate((ids) => {
  const doc = window.editor.getDocument();
  const parentOf = (wanted) => {
    let parent = null;
    (function walk(node) { for (const child of node.children || []) { if (child.id === wanted) parent = node.id; walk(child); } })(doc.root);
    return parent;
  };
  let groups = 0;
  (function walk(node) { if (!node) return; if (node.props && node.props.fmde_group) groups += 1; (node.children || []).forEach(walk); })(doc.root);
  return { selected: window.editor.selection(), aParent: parentOf(ids.a), bParent: parentOf(ids.b), groups };
}, groupFixture);
check("Remove from group detaches the member and dissolves a two-item group", detachedState.selected[0] === groupFixture.a && detachedState.aParent === detachedState.bParent && detachedState.groups === 0, detachedState);

// ---- 7. Doc-mode crop entry -------------------------------------------------
const docImageNodeId = await page.evaluate((imgUrl) => {
  window.editor.destroy();
  const doc = FMDocModel.createBlankDocument({ metadata: { document_type: "generic" } });
  const body = doc.pages[0].children.find((node) => node.props?.page_region === "body");
  const image = FMDocModel.createNode("image", {
    name: "Doc crop photo",
    frame: { x: 0, y: 0, w: 220, h: 110, layout: "flow" },
    props: { media: { url: imgUrl }, fit: "cover", alt: "" }
  });
  body.children.push(image);
  window.editor = FMDocEditor.mount(document.getElementById("host"), {
    document: doc,
    profile: "designer",
    mode: "doc",
    media: { url: (ref) => (ref && ref.url) || "" }
  });
  return image.id;
}, IMG_URL);
await page.waitForTimeout(700);
const docImageCenter = await page.evaluate((id) => {
  const el = document.querySelector('[data-node-type="image"][data-node-id="' + id + '"], [data-node-type="image"][data-node-id="' + id + '::part0"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, docImageNodeId);
check("image remains rendered after switching to Doc mode", !!docImageCenter, docImageCenter);
if (docImageCenter) await page.mouse.dblclick(docImageCenter.x, docImageCenter.y);
await page.waitForTimeout(400);
const docCrop = await page.evaluate(() => {
  const ui = document.querySelector(".fmde-mode-doc .fmde-cropui");
  const ghost = ui && ui.querySelector(".fmde-crop-ghost");
  return {
    open: !!ui,
    ghostOpacity: ghost ? getComputedStyle(ghost).opacity : null,
    temporaryOverlay: !!document.querySelector(".fmde-mode-doc .fmde-doc-crop-overlay"),
    pageUnclipped: !!document.querySelector(".fmde-mode-doc .fmdoc-page.fmde-crop-active")
  };
});
check("dblclick an image in Doc mode opens the shared crop UI", docCrop.open, docCrop);
check("Doc crop shows the translucent full image outside its frame", Number(docCrop.ghostOpacity) < 0.6 && docCrop.temporaryOverlay && docCrop.pageUnclipped, docCrop);
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
const docCropClosed = await page.evaluate(() => !document.querySelector(".fmde-cropui,.fmde-doc-crop-overlay,.fmde-crop-active"));
check("Escape fully removes the Doc crop overlay", docCropClosed);

if (docImageCenter) await page.mouse.click(docImageCenter.x, docImageCenter.y, { button: "right" });
await page.waitForTimeout(200);
const docContextMenu = await page.evaluate(() => {
  const menu = document.querySelector(".fmde-element-context");
  return menu ? {
    labels: Array.from(menu.querySelectorAll(".fmde-menu-label")).map((el) => el.textContent.trim()),
    styleButtons: menu.querySelectorAll(".fmde-context-style-btn").length
  } : null;
});
check("Doc elements use the same right-click controls", !!docContextMenu && docContextMenu.styleButtons === 4 && docContextMenu.labels.includes("Bring forward") && docContextMenu.labels.includes("Delete"), docContextMenu);
await page.keyboard.press("Escape");

// Widget visual roots can carry a built-in radius even when the transparent
// model wrapper has no style.radius yet. The shared control must reflect that
// visible value and make its first edit authoritative.
const roundedWidgetId = await page.evaluate(() => {
  const doc = window.editor.getDocument();
  const node = FMDocModel.createNode("widget", {
    name: "Rounded payment widget",
    anchor: "page",
    frame: { x: 300, y: 300, w: 220, h: 110, z: 12, layout: "absolute" },
    props: { widget: "doc.pay_now@1", config: { label: "Pay", amount_cents: 0 } }
  });
  window.editor.apply({ type: "node.insert", node, page_id: doc.pages[0].id });
  return node.id;
});
await page.waitForTimeout(600);
const roundedWidgetCenter = await page.evaluate((id) => {
  const el = document.querySelector('[data-node-id="' + id + '"]');
  el && el.scrollIntoView({ block: "center" });
  const r = el && el.getBoundingClientRect();
  return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, roundedWidgetId);
if (roundedWidgetCenter) await page.mouse.click(roundedWidgetCenter.x, roundedWidgetCenter.y, { button: "right" });
await page.locator('.fmde-element-context [aria-label="Corners"]').click();
await page.waitForTimeout(150);
const widgetCornerInitial = await page.locator('.fmde-style-menu input[aria-label="Corner radius"]').first().inputValue();
check("corner control reads a widget's visible built-in radius", Math.abs(Number(widgetCornerInitial) - 6) < 0.1, widgetCornerInitial);
await page.locator('.fmde-style-menu input[type="range"][aria-label="Corner radius"]').evaluate((slider) => {
  slider.value = "0";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(500);
const widgetCornerAfter = await page.evaluate((id) => {
  const found = FMDocModel.findNode(window.editor.getDocument(), id);
  const el = document.querySelector('[data-node-id="' + id + '"]');
  const visual = el && el.firstElementChild;
  return {
    radius: found && found.node.style && found.node.style.radius,
    rendered: visual ? getComputedStyle(visual).borderTopLeftRadius : null
  };
}, roundedWidgetId);
check("corner slider overrides the widget's visible root live", Array.isArray(widgetCornerAfter.radius) && widgetCornerAfter.radius[0] === 0 && parseFloat(widgetCornerAfter.rendered) === 0, widgetCornerAfter);

const docShapeId = await page.evaluate((imgUrl) => {
  const doc = window.editor.getDocument();
  const pageDef = doc.pages[0];
  const shape = FMDocModel.createNode("shape", {
    name: "Doc image-fill resize",
    anchor: "page",
    frame: { x: 90, y: 300, w: 150, h: 90, z: 8, layout: "absolute" },
    props: { shape: "rect", corner_radius: 10 },
    style: { fill: { type: "image", media: { url: imgUrl }, fit: "cover" }, stroke: { color: "#0f172a", width_pt: 6 } }
  });
  window.editor.apply({ type: "node.insert", node: shape, page_id: pageDef.id });
  window.editor.select([shape.id]);
  return shape.id;
}, IMG_URL);
await page.waitForTimeout(600);
const docResizeHandle = await page.evaluate(() => {
  const handle = document.querySelector('.fmde-doc-object-chrome [data-resize-direction="se"]');
  if (!handle) return null;
  const r = handle.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (docResizeHandle) {
  await page.mouse.move(docResizeHandle.x, docResizeHandle.y);
  await page.mouse.down();
  await page.mouse.move(docResizeHandle.x + 70, docResizeHandle.y + 25, { steps: 5 });
}
const docMidResize = await page.evaluate((id) => {
  const el = document.querySelector('[data-node-id="' + id + '"]');
  const svg = el && el.querySelector("svg");
  const image = svg && svg.querySelector("pattern image");
  const shape = svg && svg.querySelector(":scope > rect");
  const rect = el && el.getBoundingClientRect();
  const viewBox = svg && svg.getAttribute("viewBox").split(" ").map(Number);
  return rect && viewBox ? {
    elementRatio: rect.width / rect.height, viewBoxRatio: viewBox[2] / viewBox[3], imageFit: image && image.getAttribute("preserveAspectRatio"),
    border: shape && { x: Number(shape.getAttribute("x")), y: Number(shape.getAttribute("y")), w: Number(shape.getAttribute("width")), h: Number(shape.getAttribute("height")), rx: Number(shape.getAttribute("rx")), stroke: Number(shape.getAttribute("stroke-width")) }
  } : null;
}, docShapeId);
if (docResizeHandle) await page.mouse.up();
await page.waitForTimeout(500);
check("Doc resize keeps image-filled shape geometry live and unstretched", !!docMidResize && Math.abs(docMidResize.elementRatio - docMidResize.viewBoxRatio) < 0.03 && docMidResize.imageFit === "xMidYMid slice", docMidResize);
const docCommittedBorder = await page.evaluate((id) => {
  const shape = document.querySelector('[data-node-id="' + id + '"] svg > rect');
  return shape && { x: Number(shape.getAttribute("x")), y: Number(shape.getAttribute("y")), w: Number(shape.getAttribute("width")), h: Number(shape.getAttribute("height")), rx: Number(shape.getAttribute("rx")), stroke: Number(shape.getAttribute("stroke-width")) };
}, docShapeId);
check("Doc live border and radius exactly match their committed geometry", !!docMidResize && JSON.stringify(docMidResize.border) === JSON.stringify(docCommittedBorder), { live: docMidResize && docMidResize.border, committed: docCommittedBorder });
const docResizedFrame = await page.evaluate((id) => {
  const found = FMDocModel.findNode(window.editor.getDocument(), id);
  return found && { ...found.node.frame };
}, docShapeId);
await page.keyboard.press("Control+z");
await page.waitForTimeout(500);
const docUndoneFrame = await page.evaluate((id) => {
  const found = FMDocModel.findNode(window.editor.getDocument(), id);
  return found && { ...found.node.frame };
}, docShapeId);
check("Ctrl+Z restores a Doc-mode resize", !!docUndoneFrame && Math.abs(docUndoneFrame.w - 150) < 0.1 && Math.abs(docUndoneFrame.h - 90) < 0.1, { resized: docResizedFrame, undone: docUndoneFrame });

// Doc mode uses the same modifier-selection and grouping semantics as Visual.
await page.evaluate(() => window.editor.setProfile("document"));
await page.waitForTimeout(350);
const movableProfilesGroupable = await page.evaluate(() => ({
  document: FMDocEditor.PROFILE_FLAGS.document.group,
  inline: FMDocEditor.PROFILE_FLAGS.inline.group
}));
check("built-in profiles never disable grouping while free movement is enabled", movableProfilesGroupable.document === true && movableProfilesGroupable.inline === true, movableProfilesGroupable);
const docObjectCenters = await page.evaluate((ids) => {
  const shape = document.querySelector('[data-node-id="' + ids.shape + '"]');
  const widget = document.querySelector('[data-node-id="' + ids.widget + '"]');
  shape && shape.scrollIntoView({ block: "center" });
  const point = (el) => { const r = el && el.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  return { shape: point(shape), widget: point(widget) };
}, { shape: docShapeId, widget: roundedWidgetId });
if (docObjectCenters.widget) { await page.keyboard.down("Shift"); await page.mouse.click(docObjectCenters.widget.x, docObjectCenters.widget.y); await page.keyboard.up("Shift"); }
await page.waitForTimeout(350);
const docShiftSelection = await page.evaluate(() => ({ selection: window.editor.selection(), memberChrome: document.querySelectorAll(".fmde-doc-object-chrome-member").length }));
check("Shift-click adds an object to the Doc-mode selection", docShiftSelection.selection.length === 2 && docShiftSelection.memberChrome === 2, docShiftSelection);
if (docObjectCenters.widget) { await page.keyboard.down("Control"); await page.mouse.click(docObjectCenters.widget.x, docObjectCenters.widget.y); await page.keyboard.up("Control"); }
await page.waitForTimeout(250);
const docCtrlRemoved = await page.evaluate(() => window.editor.selection());
check("Ctrl-click toggles an object out of the Doc-mode selection", docCtrlRemoved.length === 1 && docCtrlRemoved[0] === docShapeId, docCtrlRemoved);
if (docObjectCenters.widget) { await page.keyboard.down("Control"); await page.mouse.click(docObjectCenters.widget.x, docObjectCenters.widget.y); await page.keyboard.up("Control"); }
await page.waitForTimeout(300);
if (docObjectCenters.shape) await page.mouse.click(docObjectCenters.shape.x, docObjectCenters.shape.y, { button: "right" });
await page.waitForTimeout(180);
const docGroupAction = await page.locator(".fmde-element-context .fmde-menu-item", { hasText: "Group" }).count();
check("Doc multi-selection exposes the shared Group command", docGroupAction === 1, docGroupAction);
if (docGroupAction) await page.locator(".fmde-element-context .fmde-menu-item", { hasText: "Group" }).click();
await page.waitForTimeout(500);
const docGrouped = await page.evaluate(() => {
  const selected = window.editor.selection();
  const found = selected.length === 1 && FMDocModel.findNode(window.editor.getDocument(), selected[0]);
  return { selected, marked: !!(found && found.node.props && found.node.props.fmde_group), chrome: document.querySelectorAll(".fmde-doc-object-chrome").length, members: document.querySelectorAll(".fmde-doc-object-group-member").length };
});
check("a Doc group remains one selectable object with visible member outlines", docGrouped.marked && docGrouped.chrome >= 3 && docGrouped.members === 2, docGrouped);
const docGroupCenter = await page.evaluate(() => {
  const id = window.editor.selection()[0];
  const el = document.querySelector('[data-node-id="' + id + '"]');
  const r = el && el.getBoundingClientRect();
  return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (docGroupCenter) await page.mouse.click(docGroupCenter.x, docGroupCenter.y, { button: "right" });
await page.waitForTimeout(180);
const docUngroupAction = await page.locator(".fmde-element-context .fmde-menu-item", { hasText: "Ungroup" }).count();
check("Doc groups expose the shared Ungroup command", docUngroupAction === 1, docUngroupAction);
if (docUngroupAction) await page.locator(".fmde-element-context .fmde-menu-item", { hasText: "Ungroup" }).click();
await page.waitForTimeout(450);
const docUngrouped = await page.evaluate(() => window.editor.selection());
check("ungrouping in Doc mode restores the member selection", docUngrouped.length === 2, docUngrouped);

const nestedWidgetFixture = await page.evaluate((existingWidgetId) => {
  const doc = window.editor.getDocument();
  const pageDef = doc.pages[0];
  const container = FMDocModel.createNode("frame", {
    name: "Nested widget holder", anchor: "page",
    frame: { x: 340, y: 450, w: 250, h: 130, z: 30, layout: "absolute" }
  });
  const widget = FMDocModel.createNode("widget", {
    name: "Nested groupable widget", anchor: "flow",
    frame: { x: 12, y: 10, w: 210, h: 95, z: 1, layout: "absolute" },
    props: { widget: "doc.pay_now@1", config: { label: "Nested Pay", amount_cents: 0 } }
  });
  window.editor.apply({ type: "node.insert", node: container, page_id: pageDef.id });
  window.editor.apply({ type: "node.insert", node: widget, parent_id: container.id });
  window.editor.select([existingWidgetId, widget.id]);
  return { existing: existingWidgetId, nested: widget.id, container: container.id };
}, roundedWidgetId);
await page.waitForTimeout(550);
const existingWidgetCenter = await page.evaluate((id) => {
  const el = document.querySelector('[data-node-id="' + id + '"]');
  const r = el && el.getBoundingClientRect();
  return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, roundedWidgetId);
if (existingWidgetCenter) await page.mouse.click(existingWidgetCenter.x, existingWidgetCenter.y, { button: "right" });
await page.waitForTimeout(180);
const crossParentGroupAction = await page.locator(".fmde-element-context .fmde-menu-item", { hasText: "Group" }).count();
check("widgets remain groupable when they originated in different containers", crossParentGroupAction === 1, crossParentGroupAction);
if (crossParentGroupAction) await page.locator(".fmde-element-context .fmde-menu-item", { hasText: "Group" }).click();
await page.waitForTimeout(550);
const crossParentGrouped = await page.evaluate((fixture) => {
  const selection = window.editor.selection();
  const found = selection.length === 1 && FMDocModel.findNode(window.editor.getDocument(), selection[0]);
  const childIds = found && found.node.children ? found.node.children.map((child) => child.id) : [];
  return { selection, group: !!(found && found.node.props && found.node.props.fmde_group), childIds };
}, nestedWidgetFixture);
check("cross-container widgets are normalized and grouped as one movable block", crossParentGrouped.group && crossParentGrouped.childIds.includes(nestedWidgetFixture.existing) && crossParentGrouped.childIds.includes(nestedWidgetFixture.nested), crossParentGrouped);

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
await browser.close();
process.exit(failed ? 1 : 0);
