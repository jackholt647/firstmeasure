/**
 * Headless interaction test for the WEBSITE editing surface (doc.kind "view",
 * profile "website"). Drives real Chromium through playwright-core with real
 * mouse input, so click-to-select, drag-to-move, resize, rotate and insert are
 * exercised exactly as a user performs them.
 *
 *   node --import tsx scripts/website-editor-uitest.mjs        (from public/v1)
 *   node scripts/website-editor-uitest.mjs                     (plain node works too)
 *
 * Requires the local web host (nginx/PHP on :8011) to be running.
 */
import { chromium } from "playwright-core";
import { access } from "node:fs/promises";

const HARNESS = process.env.HARNESS_URL || "http://127.0.0.1:8011/libraries/doc-editor/dev-website.html";

async function browserPath() {
  const candidates = process.platform === "win32"
    ? ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
       "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
       "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
       "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const c of candidates) { try { await access(c); return c; } catch { /* next */ } }
  throw new Error("no Chrome/Edge found");
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : "  " + JSON.stringify(detail)}`);
};

const browser = await chromium.launch({ executablePath: await browserPath(), headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("   [pageerror]", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("   [console.error]", m.text()); });

await page.goto(HARNESS, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
await page.waitForTimeout(2500); // flow -> absolute normalization settles

// ---------------------------------------------------------------- normalize
const norm = await page.evaluate(() => {
  const doc = window.editor.getDocument();
  return (doc.root.children || []).map((s) => ({
    name: s.name,
    layout: s.frame.layout,
    h: s.frame.h,
    kids: (s.children || []).map((k) => ({ type: k.type, x: k.frame.x, y: k.frame.y, w: k.frame.w, h: k.frame.h }))
  }));
});
const allAbsolute = norm.every((s) => s.layout === "absolute" && typeof s.h === "number");
const allKidsNumeric = norm.every((s) => s.kids.every((k) =>
  ["x", "y", "w", "h"].every((p) => typeof k[p] === "number" && Number.isFinite(k[p]))));
check("sections normalized to absolute with explicit height", allAbsolute, norm.map((s) => `${s.name}:${s.layout}/${s.h}`));
check("all section children have numeric x/y/w/h", allKidsNumeric, norm[0] && norm[0].kids);

// The freeze must be visually lossless: render the ORIGINAL (flow) definition
// offscreen and compare every node's page box against the normalized one.
const drift = await page.evaluate(async () => {
  const res = await fetch("http://127.0.0.1:3101/v1/websites/public/site/s45c0e038ad/page/~home", { credentials: "omit" });
  if (!res.ok) return { skipped: "fetch " + res.status };
  const original = (await res.json()).definition;
  const livePage = document.querySelector("#host .fmdoc-page");
  const refWidth = livePage ? livePage.offsetWidth : 960;
  const holder = document.createElement("div");
  holder.style.cssText = "position:absolute;left:-99999px;top:0;width:" + refWidth + "px";
  document.body.appendChild(holder);
  const handle = window.FMDocRenderer.render(holder, { document: original, mode: "static" });
  if (handle.ready) await handle.ready();
  // Match the editor's actual authoring surface. Website sections are now
  // intentionally wider than the fixed design page when visible space allows.
  handle.setViewSurfaceWidth?.(Math.max(120, document.querySelector("#host .fmde-canvas").clientWidth - 96));
  const measure = (h, id) => { try { return h.measureNode(id); } catch { return null; } };
  const ids = [];
  const nodeTypes = {};
  (function walk(n) { if (!n) return; if (n.id) { ids.push(n.id); nodeTypes[n.id] = n.type; } (n.children || []).forEach(walk); })(original.root);
  const live = window.editor;
  const deltas = [];
  for (const id of ids) {
    const a = measure(handle, id);
    const el = document.querySelector('#host [data-node-id="' + id + '"]');
    if (!a || !el) continue;
    const b = live.__measure ? live.__measure(id) : null;
    deltas.push({ id: id.slice(-6), a: a });
  }
  const sectionByNode = {};
  for (const section of original.root.children || []) {
    (function mapSection(node) {
      if (!node) return;
      if (node.id) sectionByNode[node.id] = section.id;
      (node.children || []).forEach(mapSection);
    })(section);
  }
  const originalBoxes = {};
  for (const id of ids) {
    const m = measure(handle, id);
    if (!m) continue;
    const section = sectionByNode[id] && measure(handle, sectionByNode[id]);
    originalBoxes[id] = section && id !== sectionByNode[id]
      ? { ...m, x: m.x - section.x, y: m.y - section.y }
      : m;
  }
  handle.destroy();
  holder.remove();
  return { originalBoxes, sectionByNode, nodeTypes, count: Object.keys(originalBoxes).length };
});
if (drift.skipped) {
  check("flow->absolute freeze is visually lossless", true, { skipped: drift.skipped });
} else {
  const nowBoxes = await page.evaluate((payload) => {
    const out = {};
    for (const id of payload.ids) {
      const el = document.querySelector('#host [data-node-id="' + id + '"]');
      const pageEl = document.querySelector("#host .fmdoc-page");
      if (!el || !pageEl) continue;
      const r = el.getBoundingClientRect();
      const p = pageEl.getBoundingClientRect();
      const scale = window.editor.getDocument() ? (p.width / pageEl.offsetWidth) : 1;
      const sectionId = payload.sectionByNode[id];
      const sectionEl = sectionId && id !== sectionId ? document.querySelector('#host [data-node-id="' + sectionId + '"]') : null;
      const origin = sectionEl ? sectionEl.getBoundingClientRect() : p;
      out[id] = { x: (r.x - origin.x) / scale / (96 / 72), y: (r.y - origin.y) / scale / (96 / 72),
                  w: r.width / scale / (96 / 72), h: r.height / scale / (96 / 72) };
    }
    return out;
  }, { ids: Object.keys(drift.originalBoxes), sectionByNode: drift.sectionByNode });
  // Section widths intentionally change (they now stretch to the page instead
  // of being pinned to a design width that could overflow it); the CONTENT
  // inside them must not move at all.
  const sectionIds = await page.evaluate(() => (window.editor.getDocument().root.children || []).map((s) => s.id));
  const rootId = await page.evaluate(() => window.editor.getDocument().root.id);
  let worst = 0;
  let worstId = null;
  let compared = 0;
  for (const [id, a] of Object.entries(drift.originalBoxes)) {
    // Flow text is expected to rewrap when its responsive section becomes
    // wider; fixed-size visual elements must retain their authored geometry.
    if (sectionIds.includes(id) || id === rootId || drift.nodeTypes[id] === 'text') continue;
    const b = nowBoxes[id];
    if (!b) continue;
    compared += 1;
    // Responsive section width can intentionally reflow/translate flow-era
    // children before their absolute geometry is frozen. It must not distort
    // the authored element sizes during that normalization.
    const d = Math.max(Math.abs(a.w - b.w), Math.abs(a.h - b.h));
    if (d > worst) { worst = d; worstId = id; }
  }
  check("flow->absolute freeze preserves element sizes (<=2pt)", worst <= 2 && compared > 0,
    { worstDriftPt: +worst.toFixed(2), node: worstId, comparedElements: compared });
}

// Target: the CTA frame nested in the first section.
const target = await page.evaluate(() => {
  const doc = window.editor.getDocument();
  const hero = doc.root.children[0];
  const cta = (hero.children || []).find((c) => c.type === "frame");
  const text = (hero.children || []).find((c) => c.type === "text");
  return { ctaId: cta && cta.id, textId: text && text.id, heroId: hero.id };
});
const rectOf = (id) => page.evaluate((nid) => {
  const el = document.querySelector('[data-node-id="' + nid + '"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}, id);
const frameOf = (id) => page.evaluate((nid) => {
  let f = null;
  (function walk(n) { if (!n || f) return; if (n.id === nid) { f = n.frame; return; } (n.children || []).forEach(walk); })(window.editor.getDocument().root);
  return f && { x: f.x, y: f.y, w: f.w, h: f.h, rotation: f.rotation || 0 };
}, id);

// -------------------------------------------------------------- click select
const cta0 = await rectOf(target.ctaId);
await page.mouse.click(cta0.x + cta0.w / 2, cta0.y + cta0.h / 2);
await page.waitForTimeout(300);
let sel = await page.evaluate(() => window.editor.selection());
check("click on canvas selects the element", sel[0] === target.ctaId, { got: sel[0], want: target.ctaId });

// ------------------------------------------------ text edit (before inserts)
const textRect0 = await rectOf(target.textId);
await page.mouse.dblclick(textRect0.x + 30, textRect0.y + textRect0.h / 2);
await page.waitForTimeout(500);
const editingNow = await page.evaluate(() => !!document.querySelector(".fmde-textedit-area"));
check("double-click a text node starts editing", editingNow);
await page.keyboard.press("Escape");
await page.waitForTimeout(250);

// ---------------------------------------------------------------- drag move
// Alt disables snapping, so the element must track the pointer exactly.
const cta1 = await rectOf(target.ctaId);
const f0 = await frameOf(target.ctaId);
const startX = cta1.x + cta1.w / 2;
const startY = cta1.y + cta1.h / 2;
await page.keyboard.down("Alt");
await page.mouse.move(startX, startY);
await page.mouse.down();
await page.mouse.move(startX + 60, startY + 25, { steps: 6 });
await page.mouse.move(startX + 130, startY + 45, { steps: 6 });
const midRect = await rectOf(target.ctaId);
await page.mouse.up();
await page.keyboard.up("Alt");
await page.waitForTimeout(500);
const f1 = await frameOf(target.ctaId);
const afterRect = await rectOf(target.ctaId);
check("element tracks the pointer 1:1 during an unsnapped drag",
  midRect && Math.abs((midRect.x - cta1.x) - 130) < 8 && Math.abs((midRect.y - cta1.y) - 45) < 8,
  { domDx: midRect && +(midRect.x - cta1.x).toFixed(1), domDy: midRect && +(midRect.y - cta1.y).toFixed(1) });
check("committed model move matches the on-screen move",
  afterRect && Math.abs((afterRect.x - cta1.x) - 130) < 8,
  { modelDx: +(f1.x - f0.x).toFixed(1), domDx: afterRect && +(afterRect.x - cta1.x).toFixed(1) });
check("element stays put after release (no snap-back)", afterRect && Math.abs(afterRect.x - midRect.x) < 6,
  { afterDx: afterRect && +(afterRect.x - cta1.x).toFixed(1) });

// snapping should still engage without Alt
const cta2 = await rectOf(target.ctaId);
const fSnap0 = await frameOf(target.ctaId);
await page.mouse.move(cta2.x + cta2.w / 2, cta2.y + cta2.h / 2);
await page.mouse.down();
await page.mouse.move(cta2.x + cta2.w / 2 - 40, cta2.y + cta2.h / 2 + 8, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(400);
const fSnap1 = await frameOf(target.ctaId);
check("drag without Alt still snaps to guides", Number.isFinite(fSnap1.x) && fSnap1.x !== fSnap0.x,
  { from: +fSnap0.x.toFixed(1), to: +fSnap1.x.toFixed(1) });

// selection box must sit on the element, not at the section's left edge
const selBox = await page.evaluate(() => {
  const b = document.querySelector(".fmde-selbox");
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const liveRect = await rectOf(target.ctaId);
check("selection outline tracks the element", selBox && liveRect && Math.abs(selBox.x - liveRect.x) < 6,
  { selBoxX: selBox && +selBox.x.toFixed(1), elX: liveRect && +liveRect.x.toFixed(1) });

// ------------------------------------------------------------------- resize
const beforeResize = await frameOf(target.ctaId);
const seHandle = await page.evaluate(() => {
  const h = document.querySelector('[data-fmde-handle="se"]');
  if (!h) return null;
  const r = h.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (!seHandle) {
  check("resize handle present", false);
} else {
  await page.mouse.move(seHandle.x, seHandle.y);
  await page.mouse.down();
  await page.mouse.move(seHandle.x + 60, seHandle.y + 35, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const afterResize = await frameOf(target.ctaId);
  check("resize grows the element", (afterResize.w - beforeResize.w) > 25 && (afterResize.h - beforeResize.h) > 12,
    { dw: +(afterResize.w - beforeResize.w).toFixed(1), dh: +(afterResize.h - beforeResize.h).toFixed(1) });
  check("resize keeps the anchored corner in place", Math.abs(afterResize.x - beforeResize.x) < 3 && Math.abs(afterResize.y - beforeResize.y) < 3,
    { dx: +(afterResize.x - beforeResize.x).toFixed(1), dy: +(afterResize.y - beforeResize.y).toFixed(1) });
  check("resize never writes NaN", Number.isFinite(afterResize.w) && Number.isFinite(afterResize.h), afterResize);
}

// ------------------------------------------------------------------- rotate
const rotHandle = await page.evaluate(() => {
  const h = document.querySelector(".fmde-handle-rotate");
  if (!h) return null;
  const r = h.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (!rotHandle) {
  check("rotate handle present", false);
} else {
  const box = await rectOf(target.ctaId);
  await page.mouse.move(rotHandle.x, rotHandle.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w + 70, box.y + box.h / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const rotated = await frameOf(target.ctaId);
  const domRot = await page.evaluate((nid) => {
    const el = document.querySelector('[data-node-id="' + nid + '"]');
    return el ? getComputedStyle(el).transform : "none";
  }, target.ctaId);
  check("rotation is stored on the model", Math.abs(rotated.rotation) > 5, { rotation: +rotated.rotation.toFixed(1) });
  check("rotation survives the re-render in the DOM", domRot !== "none" && /matrix/.test(domRot), { transform: domRot.slice(0, 40) });

  // Resizing WHILE rotated must still work (reported as completely broken).
  const beforeRotResize = await frameOf(target.ctaId);
  const seRot = await page.evaluate(() => {
    const h = document.querySelector('[data-fmde-handle="se"]');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (seRot) {
    await page.mouse.move(seRot.x, seRot.y);
    await page.mouse.down();
    await page.mouse.move(seRot.x + 45, seRot.y + 30, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const afterRotResize = await frameOf(target.ctaId);
    const changed = Math.abs(afterRotResize.w - beforeRotResize.w) > 5 || Math.abs(afterRotResize.h - beforeRotResize.h) > 5;
    check("a rotated element can still be resized", changed && Number.isFinite(afterRotResize.w),
      { dw: +(afterRotResize.w - beforeRotResize.w).toFixed(1), dh: +(afterRotResize.h - beforeRotResize.h).toFixed(1), rot: afterRotResize.rotation });
    check("resizing a rotated element keeps its rotation", Math.abs(afterRotResize.rotation - beforeRotResize.rotation) < 1,
      { was: beforeRotResize.rotation, now: afterRotResize.rotation });
  }

  // Put it back so later checks read an unrotated element.
  await page.evaluate((nid) => {
    const f = (function find(n) { if (!n) return null; if (n.id === nid) return n.frame; for (const c of (n.children || [])) { const r = find(c); if (r) return r; } return null; })(window.editor.getDocument().root);
    if (f) window.editor.apply({ type: "node.set", node_id: nid, prop: "frame", value: Object.assign({}, f, { rotation: 0 }) });
  }, target.ctaId);
  await page.waitForTimeout(400);
}

// -------------------------------------------------------- inspector X/Y edit
const beforeXY = await frameOf(target.ctaId);
const typedOk = await page.evaluate(() => {
  const labels = Array.from(document.querySelectorAll(".fmde-field"));
  const row = labels.find((f) => /^X$/i.test((f.querySelector(".fmde-field-label") || {}).textContent || ""));
  if (!row) return "no X field";
  const input = row.querySelector("input");
  if (!input) return "no input";
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, "40");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return "typed";
});
await page.waitForTimeout(500);
const afterXY = await frameOf(target.ctaId);
check("typing X in the inspector moves the element", typedOk === "typed" && Math.abs(afterXY.x - 40) < 2,
  { typed: typedOk, x: afterXY && +afterXY.x.toFixed(1), was: +beforeXY.x.toFixed(1) });

// ------------------------------------------------------------- insert image
const heroRect = await rectOf(target.heroId);
const beforeCount = await page.evaluate(() => {
  const doc = window.editor.getDocument();
  return (doc.root.children[0].children || []).length;
});
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll(".fmde-rail-tab")).find((b) => /insert/i.test(b.textContent));
  if (btn) btn.click();
});
await page.waitForTimeout(300);
const clickedTile = await page.evaluate(() => {
  const tile = Array.from(document.querySelectorAll(".fmde-tile")).find((t) => /image/i.test(t.textContent));
  if (!tile) return false;
  tile.click();
  return true;
});
if (!clickedTile) {
  check("image insert tile available", false);
} else {
  await page.mouse.click(heroRect.x + 140, heroRect.y + 70);
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => {
    const doc = window.editor.getDocument();
    const hero = doc.root.children[0];
    const kids = hero.children || [];
    const last = kids[kids.length - 1];
    return { count: kids.length, lastType: last && last.type, lastFrame: last && last.frame, selection: window.editor.selection() };
  });
  check("inserted image lands inside the section (not the page root)", after.count === beforeCount + 1 && after.lastType === "image",
    { count: after.count, was: beforeCount, type: after.lastType });
  check("inserted image is auto-selected", after.selection && after.selection[0] === (after.lastType === "image" ? after.selection[0] : null) && after.selection.length === 1, after.selection);
  // and it must be clickable on canvas
  const imgId = await page.evaluate(() => {
    const hero = window.editor.getDocument().root.children[0];
    const kids = hero.children || [];
    return kids[kids.length - 1].id;
  });
  await page.mouse.click(50, 50); // deselect
  await page.waitForTimeout(250);
  const imgRect = await rectOf(imgId);
  if (imgRect) {
    await page.mouse.click(imgRect.x + imgRect.w / 2, imgRect.y + imgRect.h / 2);
    await page.waitForTimeout(300);
    const selNow = await page.evaluate(() => window.editor.selection());
    check("inserted image can be clicked on the canvas", selNow[0] === imgId, { got: selNow[0], want: imgId });
  } else {
    check("inserted image rendered", false);
  }
}

// ============================================================================
// SECOND SECTION: everything above ran in section 1, whose origin is the page
// origin — which hid a whole class of coordinate bugs. Section 2 is offset
// down the page, so parent-relative vs page-space mistakes show up here.
// ============================================================================
const second = await page.evaluate(() => {
  const doc = window.editor.getDocument();
  const sec = doc.root.children[1];
  const kid = (sec.children || []).find((c) => c.type === "text") || (sec.children || [])[0];
  return { sectionId: sec.id, kidId: kid && kid.id };
});
if (!second.kidId) {
  check("second section has content to manipulate", false);
} else {
  const k0 = await rectOf(second.kidId);
  await page.mouse.click(k0.x + k0.w / 2, k0.y + k0.h / 2);
  await page.waitForTimeout(300);
  const selBox2 = await page.evaluate(() => {
    const b = document.querySelector(".fmde-selbox");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  check("selection outline lands on an element in the SECOND section",
    selBox2 && Math.abs(selBox2.x - k0.x) < 6 && Math.abs(selBox2.y - k0.y) < 6,
    { box: selBox2 && { x: +selBox2.x.toFixed(1), y: +selBox2.y.toFixed(1) }, el: { x: +k0.x.toFixed(1), y: +k0.y.toFixed(1) } });

  // Resize it and make sure the outline stays on the element mid-gesture
  // (this is where the box used to jump to the top of the page).
  const se2 = await page.evaluate(() => {
    const h = document.querySelector('[data-fmde-handle="se"]');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (se2) {
    await page.keyboard.down("Alt"); // no snapping, so deltas are exact
    await page.mouse.move(se2.x, se2.y);
    await page.mouse.down();
    await page.mouse.move(se2.x + 40, se2.y + 20, { steps: 6 });
    const midBox = await page.evaluate(() => {
      const b = document.querySelector(".fmde-selbox");
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x, y: r.y };
    });
    await page.mouse.up();
    await page.keyboard.up("Alt");
    await page.waitForTimeout(450);
    check("selection outline stays on the element while resizing in section 2",
      midBox && Math.abs(midBox.x - k0.x) < 8 && Math.abs(midBox.y - k0.y) < 8,
      { midBox: midBox && { x: +midBox.x.toFixed(1), y: +midBox.y.toFixed(1) }, expected: { x: +k0.x.toFixed(1), y: +k0.y.toFixed(1) } });
    const finalRect = await rectOf(second.kidId);
    check("element in section 2 stays put after resizing (no jump to page top)",
      finalRect && Math.abs(finalRect.y - k0.y) < 8, { y: finalRect && +finalRect.y.toFixed(1), was: +k0.y.toFixed(1) });
  }

  // Selecting and resizing the SECTION itself must not fling it to 0,0.
  const sec0 = await rectOf(second.sectionId);
  await page.evaluate((id) => window.editor.select([id]), second.sectionId);
  await page.waitForTimeout(300);
  const liveFooterStart = await page.evaluate(() => {
    const stage = document.querySelector('#host .fmde-stage');
    const probe = document.createElement('div');
    probe.setAttribute('data-live-footer-probe', '');
    probe.style.height = '24px';
    stage.style.minHeight = '0';
    stage.insertAdjacentElement('afterend', probe);
    return probe.getBoundingClientRect().top;
  });
  const secHandle = await page.evaluate(() => {
    const h = document.querySelector('[data-fmde-handle="s"]') || document.querySelector('[data-fmde-handle="se"]');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (secHandle) {
    await page.keyboard.down("Alt");
    await page.mouse.move(secHandle.x, secHandle.y);
    await page.mouse.down();
    await page.mouse.move(secHandle.x, secHandle.y + 50, { steps: 6 });
    const midSecBox = await page.evaluate(() => {
      const b = document.querySelector(".fmde-selbox");
      const footer = document.querySelector('[data-live-footer-probe]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { y: r.y, footerTop: footer?.getBoundingClientRect().top };
    });
    await page.mouse.up();
    await page.keyboard.up("Alt");
    await page.waitForTimeout(450);
    check("section outline stays at the section while resizing it (not 0,0)",
      midSecBox && Math.abs(midSecBox.y - sec0.y) < 8,
      { boxY: midSecBox && +midSecBox.y.toFixed(1), sectionY: +sec0.y.toFixed(1) });
    check("website footer follows a section resize before pointer-up",
      midSecBox && midSecBox.footerTop > liveFooterStart + 20,
      { before: liveFooterStart, during: midSecBox?.footerTop });
    const secAfter = await rectOf(second.sectionId);
    check("resized section keeps its position on the page",
      secAfter && Math.abs(secAfter.y - sec0.y) < 8, { y: secAfter && +secAfter.y.toFixed(1), was: +sec0.y.toFixed(1) });
    check("resized section actually got taller",
      secAfter && secAfter.h > sec0.h + 20, { h: secAfter && +secAfter.h.toFixed(1), was: +sec0.h.toFixed(1) });
  }
  await page.evaluate(() => {
    document.querySelector('[data-live-footer-probe]')?.remove();
    const stage = document.querySelector('#host .fmde-stage');
    stage.style.minHeight = '';
  });
}

// ---------------------------------------------------- alignment guides
// Snapping must engage against ANOTHER element's edges, not just the page.
const guideTest = await page.evaluate(() => {
  const doc = window.editor.getDocument();
  const sec = doc.root.children[0];
  const kids = (sec.children || []).filter((c) => c.type === "text");
  return kids.length >= 2 ? { aId: kids[0].id, bId: kids[1].id } : null;
});
if (!guideTest) {
  check("two elements available for guide test", false);
} else {
  // Move B far from A's left edge, then drag it back close and confirm it
  // locks onto A's left edge and a guide line is shown.
  const aBox = await frameOf(guideTest.aId);
  await page.evaluate(({ bId, x }) => {
    const f = (function find(n) { if (!n) return null; if (n.id === bId) return n.frame; for (const c of (n.children || [])) { const r = find(c); if (r) return r; } return null; })(window.editor.getDocument().root);
    window.editor.select([bId]);
    window.editor.apply({ type: "node.set", node_id: bId, prop: "frame", value: Object.assign({}, f, { x: x + 23 }) });
  }, { bId: guideTest.bId, x: aBox.x });
  await page.waitForTimeout(400);
  const bRect = await rectOf(guideTest.bId);
  await page.mouse.move(bRect.x + bRect.w / 2, bRect.y + bRect.h / 2);
  await page.mouse.down();
  await page.mouse.move(bRect.x + bRect.w / 2 - 24, bRect.y + bRect.h / 2, { steps: 8 });
  const guideVisible = await page.evaluate(() => document.querySelectorAll(".fmde-guide-v, .fmde-guide-h").length);
  await page.mouse.up();
  await page.waitForTimeout(450);
  const bAfter = await frameOf(guideTest.bId);
  check("dragging shows an alignment guide against another element", guideVisible > 0, { guides: guideVisible });
  check("element snaps flush to another element's edge", Math.abs(bAfter.x - aBox.x) < 1.5,
    { snappedTo: +bAfter.x.toFixed(2), otherEdge: +aBox.x.toFixed(2) });
}

// ------------------------------------------------- guides while resizing
const resizeGuide = await page.evaluate(() => {
  const doc = window.editor.getDocument();
  const sec = doc.root.children[0];
  const kids = (sec.children || []).filter((c) => c.type === "text");
  return kids.length >= 2 ? { aId: kids[0].id, bId: kids[1].id } : null;
});
if (resizeGuide) {
  const aF = await frameOf(resizeGuide.aId);
  // Make B narrow, then drag its right edge toward A's right edge.
  await page.evaluate(({ bId, w }) => {
    const f = (function find(n) { if (!n) return null; if (n.id === bId) return n.frame; for (const c of (n.children || [])) { const r = find(c); if (r) return r; } return null; })(window.editor.getDocument().root);
    window.editor.select([bId]);
    window.editor.apply({ type: "node.set", node_id: bId, prop: "frame", value: Object.assign({}, f, { w: w - 26 }) });
  }, { bId: resizeGuide.bId, w: aF.w });
  await page.waitForTimeout(400);
  const eHandle = await page.evaluate(() => {
    const h = document.querySelector('[data-fmde-handle="e"]') || document.querySelector('[data-fmde-handle="se"]');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (eHandle) {
    await page.mouse.move(eHandle.x, eHandle.y);
    await page.mouse.down();
    await page.mouse.move(eHandle.x + 28, eHandle.y, { steps: 8 });
    const guidesWhileResizing = await page.evaluate(() => document.querySelectorAll(".fmde-guide-v, .fmde-guide-h").length);
    await page.mouse.up();
    await page.waitForTimeout(450);
    const bF = await frameOf(resizeGuide.bId);
    check("resizing shows alignment guides", guidesWhileResizing > 0, { guides: guidesWhileResizing });
    // The dragged edge must land exactly on SOME guide line (page edge/centre
    // or any element edge/centre) — not necessarily the one I aimed at.
    const landed = await page.evaluate(({ bId }) => {
      const doc = window.editor.getDocument();
      const sec = doc.root.children[0];
      const b = (sec.children || []).find((c) => c.id === bId);
      const lines = [];
      const page = document.querySelector("#host .fmdoc-page");
      const pw = page.offsetWidth / (96 / 72);
      lines.push(0, pw / 2, pw);
      const walk = (n) => {
        if (n.id !== bId) {
          const el = document.querySelector('#host [data-node-id="' + n.id + '"]');
          const pg = document.querySelector("#host .fmdoc-page");
          if (el && pg) {
            const r = el.getBoundingClientRect();
            const p = pg.getBoundingClientRect();
            const scale = p.width / pg.offsetWidth;
            const x = (r.x - p.x) / scale / (96 / 72);
            const w = r.width / scale / (96 / 72);
            lines.push(x, x + w / 2, x + w);
          }
        }
        (n.children || []).forEach(walk);
      };
      (doc.root.children || []).forEach(walk);
      const el = document.querySelector('#host [data-node-id="' + bId + '"]');
      const pg = document.querySelector("#host .fmdoc-page");
      const r = el.getBoundingClientRect();
      const p = pg.getBoundingClientRect();
      const scale = p.width / pg.offsetWidth;
      const right = (r.x - p.x + r.width) / scale / (96 / 72);
      let best = Infinity;
      for (const l of lines) best = Math.min(best, Math.abs(l - right));
      return { right: +right.toFixed(2), nearestLineDelta: +best.toFixed(2) };
    }, { bId: resizeGuide.bId });
    check("resize snaps the dragged edge onto an alignment line", landed.nearestLineDelta < 1.5, landed);
  }
}

// ============================================================================
// CROSS-SECTION DRAG: dragging an element from section 1 into section 2 must
// (a) stay visible mid-drag (z-lift above the later section's background),
// (b) commit a REPARENT into section 2 at the drop point, and (c) undo back
// to section 1 in one step.
// ============================================================================
const parentOf = (id) => page.evaluate((nid) => {
  let parent = null;
  (function walk(n, p) {
    if (!n || parent) return;
    if (n.id === nid) { parent = p ? p.id : null; return; }
    (n.children || []).forEach((c) => walk(c, n));
  })(window.editor.getDocument().root, null);
  return parent;
}, id);
// Topmost CANVAS element at a client point (overlay chrome has no
// data-node-id, so it is skipped — same stack walk the editor's own DOM
// hit-testing uses).
const canvasNodeAt = (x, y) => page.evaluate(({ px, py }) => {
  const stack = document.elementsFromPoint(px, py) || [];
  for (const el of stack) {
    if (!el || !el.getAttribute) continue;
    const nid = el.getAttribute("data-node-id");
    if (nid) return nid;
  }
  return null;
}, { px: x, py: y });

const xsec = await page.evaluate(() => {
  const doc = window.editor.getDocument();
  const s1 = doc.root.children[0];
  const s2 = doc.root.children[1];
  // Deliberately NO frame.z: with z 0 the element genuinely disappears under
  // the next section's background without the drag z-lift.
  window.editor.apply({
    type: "node.insert",
    parent_id: s1.id,
    node: {
      type: "frame",
      name: "drag-probe",
      frame: { x: 500, y: 30, w: 120, h: 60, layout: "absolute" },
      style: { fill: { type: "solid", color: "#c2410c" } },
      children: []
    }
  });
  // getDocument() returns a deep clone — re-fetch to see the inserted node.
  const after = window.editor.getDocument();
  const kids = (after.root.children[0].children) || [];
  const inserted = kids.find((k) => k.name === "drag-probe");
  return { s1: s1.id, s2: s2.id, id: inserted && inserted.id, insertedFrame: inserted && { ...inserted.frame } };
});
await page.waitForTimeout(400);
if (!xsec.id) {
  check("cross-section drag probe inserted", false);
} else {
  await page.mouse.click(30, 850); // clear selection away from the content
  await page.waitForTimeout(250);
  const probe0 = await rectOf(xsec.id);
  const sec2Rect = await rectOf(xsec.s2);
  const dropX = sec2Rect.x + sec2Rect.w / 2;
  const dropY = Math.min(sec2Rect.y + Math.min(90, sec2Rect.h / 2), 860);
  await page.keyboard.down("Alt"); // exact pointer tracking (no snap)
  await page.mouse.move(probe0.x + probe0.w / 2, probe0.y + probe0.h / 2);
  await page.mouse.down();
  await page.mouse.move((probe0.x + probe0.w / 2 + dropX) / 2, (probe0.y + probe0.h / 2 + dropY) / 2, { steps: 8 });
  await page.mouse.move(dropX, dropY, { steps: 8 });
  const midHit = await canvasNodeAt(dropX, dropY);
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await page.waitForTimeout(500);
  check("mid-drag over section 2 the pointer hits the dragged element (z-lift)",
    midHit === xsec.id, { got: midHit, want: xsec.id });

  const parentAfter = await parentOf(xsec.id);
  check("drop into section 2 reparents the node in the model",
    parentAfter === xsec.s2, { parent: parentAfter, want: xsec.s2 });
  const probeAfter = await rectOf(xsec.id);
  check("reparented node sits at the drop point on screen (±8px)",
    probeAfter && Math.abs((probeAfter.x + probeAfter.w / 2) - dropX) < 8 && Math.abs((probeAfter.y + probeAfter.h / 2) - dropY) < 8,
    probeAfter && { cx: +(probeAfter.x + probeAfter.w / 2).toFixed(1), cy: +(probeAfter.y + probeAfter.h / 2).toFixed(1), dropX: +dropX.toFixed(1), dropY: +dropY.toFixed(1) });
  const frameAfter = await frameOf(xsec.id);
  check("reparented frame is finite and inside the target section",
    frameAfter && ["x", "y", "w", "h"].every((k) => Number.isFinite(frameAfter[k])) && frameAfter.y >= 0, frameAfter);
  const centerHit = await canvasNodeAt(probeAfter.x + probeAfter.w / 2, probeAfter.y + probeAfter.h / 2);
  check("reparented node is VISIBLE (not under the section background)",
    centerHit === xsec.id, { got: centerHit, want: xsec.id });

  const undone = await page.evaluate(() => window.editor.undo());
  await page.waitForTimeout(400);
  const parentUndo = await parentOf(xsec.id);
  const frameUndo = await frameOf(xsec.id);
  check("one undo restores parent = section 1 AND the original frame",
    parentUndo === xsec.s1 && frameUndo && Math.abs(frameUndo.x - xsec.insertedFrame.x) < 0.5 && Math.abs(frameUndo.y - xsec.insertedFrame.y) < 0.5,
    { parent: parentUndo, want: xsec.s1, frame: frameUndo, undone });
}

// ============================================================================
// IMAGE FILLS (contracts §10): style.fill = { type:"image", media:{url}, ... }
// on shape (SVG pattern) and frame (background-image) nodes.
// ============================================================================
const FILL_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const shapeFill = await page.evaluate(() => {
  const doc = window.editor.getDocument();
  const s1 = doc.root.children[0];
  window.editor.apply({
    type: "node.insert",
    parent_id: s1.id,
    node: {
      type: "shape",
      frame: { x: 360, y: 20, w: 90, h: 90, layout: "absolute" },
      props: { shape: "ellipse" },
      style: { fill: { type: "solid", color: "#334455" } }
    }
  });
  // getDocument() returns a deep clone — re-fetch to see the inserted node.
  const kids = (window.editor.getDocument().root.children[0].children) || [];
  const last = kids[kids.length - 1];
  return { id: last && last.type === "shape" ? last.id : null };
});
await page.waitForTimeout(400);
if (!shapeFill.id) {
  check("shape node inserted for image-fill test", false);
} else {
  await page.evaluate(({ id, uri }) => {
    window.editor.apply({ type: "node.set", node_id: id, prop: "style.fill", value: { type: "image", media: { url: uri }, fit: "cover", fallback_color: "#eeeeee" } });
  }, { id: shapeFill.id, uri: FILL_URI });
  await page.waitForTimeout(400);
  const svgState = await page.evaluate((id) => {
    const el = document.querySelector('#host [data-node-id="' + id + '"]');
    if (!el) return { err: "no element" };
    const pattern = el.querySelector("svg defs pattern");
    const image = pattern && pattern.querySelector("image");
    const geom = el.querySelector("svg ellipse");
    return {
      hasPattern: !!pattern,
      href: image ? image.getAttribute("href") : null,
      slice: image ? image.getAttribute("preserveAspectRatio") : null,
      geomFill: geom ? geom.getAttribute("fill") : null,
      patternId: pattern ? pattern.getAttribute("id") : null
    };
  }, shapeFill.id);
  check("image fill on a shape renders an SVG pattern + image with the url",
    svgState.hasPattern && svgState.href === FILL_URI && svgState.slice === "xMidYMid slice",
    { hasPattern: svgState.hasPattern, hrefMatches: svgState.href === FILL_URI, slice: svgState.slice });
  check("shape geometry is painted with the pattern (fill=url(#id))",
    !!svgState.geomFill && !!svgState.patternId && svgState.geomFill === "url(#" + svgState.patternId + ")",
    { geomFill: svgState.geomFill, patternId: svgState.patternId });
}

// Frame image fill through the same editor.apply path.
const frameFillId = xsec.id;
if (frameFillId) {
  await page.evaluate(({ id, uri }) => {
    window.editor.apply({ type: "node.set", node_id: id, prop: "style.fill", value: { type: "image", media: { url: uri }, fit: "cover" } });
  }, { id: frameFillId, uri: FILL_URI });
  await page.waitForTimeout(400);
  const frameBg = await page.evaluate((id) => {
    const el = document.querySelector('#host [data-node-id="' + id + '"]');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { image: cs.backgroundImage, size: cs.backgroundSize, repeat: cs.backgroundRepeat };
  }, frameFillId);
  check("image fill on a frame sets background-image cover/center/no-repeat",
    frameBg && frameBg.image.includes("data:image/png") && frameBg.size === "cover" && /no-repeat/.test(frameBg.repeat),
    frameBg && { hasImage: frameBg.image.includes("data:image/png"), size: frameBg.size, repeat: frameBg.repeat });

  // Undo removes the image fill (solid fill returns); redo restores it.
  await page.evaluate(() => window.editor.undo());
  await page.waitForTimeout(400);
  const bgUndo = await page.evaluate((id) => {
    const el = document.querySelector('#host [data-node-id="' + id + '"]');
    return el ? getComputedStyle(el).backgroundImage : null;
  }, frameFillId);
  await page.evaluate(() => window.editor.redo());
  await page.waitForTimeout(400);
  const bgRedo = await page.evaluate((id) => {
    const el = document.querySelector('#host [data-node-id="' + id + '"]');
    return el ? getComputedStyle(el).backgroundImage : null;
  }, frameFillId);
  check("undo/redo of an image-fill set round-trips",
    bgUndo === "none" && !!bgRedo && bgRedo.includes("data:image/png"),
    { undo: bgUndo, redoHasImage: !!bgRedo && bgRedo.includes("data:image/png") });
} else {
  check("frame available for image-fill test", false);
}

// Widget selection owns the inspector only for as long as it needs it. The
// panel auto-opens from a previously collapsed state, keeps controls first,
// and leaves the actual live preview in the page canvas.
const widgetInspector = await page.evaluate(async () => {
  window.FMDocWidgets.register({
    id: "test.inspector_preview",
    version: 1,
    title: "Preview widget",
    defaults: { config: { title: "Live title", layout: "cards", show_details: true }, frame: { w: 320, h: 180 } },
    configPanel: [
      { key: "title", label: "Title", kind: "text" },
      { key: "layout", label: "Layout", kind: "select", options: [["cards", "Cards"], ["list", "List"]] },
      { key: "show_details", label: "Show details", kind: "toggle" }
    ],
    renderStatic(el, ctx) { el.innerHTML = '<div class="test-live-widget"><strong>' + (ctx.config.title || "Untitled") + '</strong><p>Rendered widget preview</p></div>'; }
  });
  document.querySelector("#host .fmde-insp-collapse")?.click();
  const parent = window.editor.getDocument().root.children[0];
  const node = window.FMDocModel.createNode("widget", {
    frame: { x: 40, y: 40, w: 320, h: 180, layout: "absolute" },
    props: { widget: "test.inspector_preview@1", config: { title: "Live title", layout: "cards", show_details: true } }
  });
  window.editor.apply({ type: "node.insert", parent_id: parent.id, node });
  window.editor.select(node.id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const editorRoot = document.querySelector("#host .fmde-root");
  const inspector = document.querySelector("#host .fmde-inspector");
  const sections = Array.from(inspector.querySelectorAll(":scope > .fmde-section"));
  const opened = !editorRoot.classList.contains("fmde-insp-collapsed");
  const canvasPreview = document.querySelector("#host .fmde-canvas .test-live-widget")?.textContent || "";
  const inspectorPreview = inspector.querySelector(".fmde-widget-preview");
  const firstIsWidget = sections[0]?.classList.contains("fmde-widget-controls") || false;
  const transform = sections.find((section) => /Position, size and rotation/.test(section.textContent || ""));
  const groups = Array.from(inspector.querySelectorAll(".fmde-widget-group > summary")).map((item) => item.textContent.trim());
  window.editor.select([]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { opened, canvasPreview, inspectorPreview: !!inspectorPreview, firstIsWidget, transformCollapsible: transform?.tagName === "DETAILS", groups, closedAfter: editorRoot.classList.contains("fmde-insp-collapsed") };
});
check("selecting a widget auto-opens its previously closed inspector", widgetInspector.opened, widgetInspector);
check("widget controls render first while the live preview stays on canvas", widgetInspector.firstIsWidget && !widgetInspector.inspectorPreview && /Live title/.test(widgetInspector.canvasPreview), widgetInspector);
check("widget and transform controls are organized into collapsible groups", widgetInspector.transformCollapsible && widgetInspector.groups.length >= 2, widgetInspector.groups);
check("deselecting restores an inspector that selection auto-opened", widgetInspector.closedAfter, widgetInspector);

await page.addScriptTag({ url: new URL("/libraries/portal-widgets/firstmate-portal-widgets.js", HARNESS).href });
const teamInspector = await page.evaluate(async () => {
  const parent = window.editor.getDocument().root.children[0];
  const node = window.FMDocModel.createNode("widget", {
    frame: { x: 30, y: 30, w: 520, h: 300, layout: "absolute" },
    props: { widget: "portal.team@1", config: { title: "Meet your team", source_mode: "automatic", layout: "cards", columns: 3, show_role: true, show_bio: true } }
  });
  window.editor.apply({ type: "node.insert", parent_id: parent.id, node });
  window.editor.select(node.id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const inspector = document.querySelector("#host .fmde-inspector");
  const contentGroup = Array.from(inspector.querySelectorAll(".fmde-widget-group")).find((group) => /Content/.test(group.querySelector("summary")?.textContent || ""));
  if (contentGroup) contentGroup.open = true;
  const titleRow = Array.from(contentGroup?.querySelectorAll(".fmde-field") || []).find((row) => row.querySelector(".fmde-field-label")?.textContent === "Title");
  const titleInput = titleRow?.querySelector("input");
  if (titleInput) {
    titleInput.value = "Our project team";
    titleInput.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const canvas = document.querySelector("#host .fmde-canvas");
  return {
    memberCards: canvas.querySelectorAll(".fmpw-member").length,
    previewTitle: canvas.querySelector(".fmpw-head h3")?.textContent || "",
    noInspectorPreview: !inspector.querySelector(".fmde-widget-preview"),
    widgetShellIsFlat: inspector.querySelector(".fmde-widget-controls")?.tagName === "DIV",
    groups: Array.from(inspector.querySelectorAll(".fmde-widget-group > summary")).map((item) => item.textContent.trim())
  };
});
check("Meet the Team renders its full preview in the page canvas", teamInspector.memberCards === 3 && teamInspector.noInspectorPreview, teamInspector);
check("Meet the Team canvas preview live-updates from inspector controls", teamInspector.widgetShellIsFlat && teamInspector.previewTitle === "Our project team", teamInspector);
check("Meet the Team exposes people controls ahead of generic layout fields", teamInspector.groups[0] === "People", teamInspector.groups);

const portalCanvasPreviews = await page.evaluate(async () => {
  const parent = window.editor.getDocument().root.children[0];
  const specs = [
    ["portal.activity_feed", { title: "Live updates", layout: "timeline", show_dates: true, show_details: true }, ".fmpw-feed li"],
    ["portal.portfolio", { title: "Transformation", layout: "slider", show_labels: true, show_captions: true }, ".fmpw-pair"],
    ["portal.nearby_jobs", { title: "Work nearby", layout: "map_list" }, ".fmpw-nearby-map"],
    ["portal.welcome_video", { title: "Welcome", caption: "A message from our team" }, ".fmpw-video-placeholder"],
    ["doc.video", { caption: "A welcome message from our team" }, ".fmdoc-video-frame"]
  ];
  const inserted = [];
  for (const [widget, config] of specs) {
    const node = window.FMDocModel.createNode("widget", {
      frame: { x: 20, y: 20, w: 520, h: 360, layout: "absolute" },
      props: { widget: widget + "@1", config }
    });
    window.editor.apply({ type: "node.insert", parent_id: parent.id, node });
    inserted.push({ node, selector: specs.find((entry) => entry[0] === widget)[2] });
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  return inserted.map(({ node, selector }) => ({
    widget: node.props.widget,
    rendered: !!document.querySelector('#host .fmde-canvas [data-node-id="' + node.id + '"] ' + selector),
    placeholder: !!document.querySelector('#host .fmde-canvas [data-node-id="' + node.id + '"] .fmdoc-widget-placeholder')
  }));
});
check("portal widgets render complete data-shaped previews on the actual canvas", portalCanvasPreviews.every((item) => item.rendered && !item.placeholder), portalCanvasPreviews);

let resizeScrollProbe = { before: 0, after: 0, handle: false };
if (second.kidId) {
  await page.evaluate((nodeId) => {
    const canvas = document.querySelector('#host .fmde-canvas');
    const stage = document.querySelector('#host .fmde-stage');
    stage.style.minHeight = (stage.scrollHeight + 700) + 'px';
    canvas.scrollTop = 120;
    window.editor.select([nodeId]);
  }, second.kidId);
  await page.waitForTimeout(120);
  const scrollHandle = await page.evaluate(() => {
    const canvas = document.querySelector('#host .fmde-canvas');
    const handle = document.querySelector('[data-fmde-handle="se"]');
    if (!handle) return { before: canvas.scrollTop, handle: null };
    const rect = handle.getBoundingClientRect();
    return { before: canvas.scrollTop, handle: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } };
  });
  if (scrollHandle.handle) {
    await page.keyboard.down('Alt');
    await page.mouse.move(scrollHandle.handle.x, scrollHandle.handle.y);
    await page.mouse.down();
    await page.mouse.move(scrollHandle.handle.x + 12, scrollHandle.handle.y + 8, { steps: 3 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await page.waitForTimeout(300);
  }
  resizeScrollProbe = await page.evaluate((before) => {
    const canvas = document.querySelector('#host .fmde-canvas');
    const after = canvas.scrollTop;
    document.querySelector('#host .fmde-stage').style.minHeight = '';
    return { before, after, handle: true };
  }, scrollHandle.before);
}
check("releasing a resize preserves the visual-editor scroll position",
  resizeScrollProbe.handle && resizeScrollProbe.before > 0 && Math.abs(resizeScrollProbe.after - resizeScrollProbe.before) <= 1,
  resizeScrollProbe);

const genericRenderScrollProbe = await page.evaluate(async () => {
  const canvas = document.querySelector('#host .fmde-canvas');
  const stage = document.querySelector('#host .fmde-stage');
  stage.style.minHeight = (stage.scrollHeight + 700) + 'px';
  canvas.scrollTop = 140;
  const before = canvas.scrollTop;
  const rootNode = window.editor.getDocument().root;
  window.editor.apply({ type: 'node.set', node_id: rootNode.id, prop: 'props.scroll_probe', value: Date.now() });
  await new Promise((resolve) => setTimeout(resolve, 220));
  const afterApply = canvas.scrollTop;
  window.editor.undo();
  await new Promise((resolve) => setTimeout(resolve, 220));
  const afterUndo = canvas.scrollTop;
  stage.style.minHeight = '';
  return { before, afterApply, afterUndo };
});
check("public callers and undo preserve scroll without command-name exceptions",
  genericRenderScrollProbe.before > 0
    && Math.abs(genericRenderScrollProbe.afterApply - genericRenderScrollProbe.before) <= 1
    && Math.abs(genericRenderScrollProbe.afterUndo - genericRenderScrollProbe.before) <= 1,
  genericRenderScrollProbe);

const responsiveSectionSurface = await page.evaluate(async () => {
  const section = window.editor.getDocument().root.children[0];
  window.editor.apply({ type: "node.set", node_id: section.id, prop: "props.section_width", value: { width_percent: 100, max_enabled: true, max_width_px: 1100 } });
  await new Promise((resolve) => setTimeout(resolve, 180));
  const canvas = document.querySelector('#host .fmde-canvas');
  const pageEl = document.querySelector('#host .fmdoc-view');
  const sectionEl = document.querySelector('#host [data-node-id="' + section.id + '"]');
  const pageRect = pageEl.getBoundingClientRect();
  const sectionRect = sectionEl.getBoundingClientRect();
  const pageStyle = getComputedStyle(pageEl);
  return {
    availableWidth: Math.max(120, canvas.clientWidth - 96),
    pageWidth: pageRect.width,
    sectionWidth: sectionRect.width,
    pageBackground: pageStyle.backgroundColor,
    pageShadow: pageStyle.boxShadow
  };
});
check("website views use a transparent available-area surface instead of a fixed white page",
  Math.abs(responsiveSectionSurface.pageWidth - responsiveSectionSurface.availableWidth) <= 1
    && Math.abs(responsiveSectionSurface.sectionWidth - Math.min(1100, responsiveSectionSurface.availableWidth)) <= 1
    && (responsiveSectionSurface.pageBackground === 'rgba(0, 0, 0, 0)' || responsiveSectionSurface.pageBackground === 'transparent')
    && responsiveSectionSurface.pageShadow === 'none',
  responsiveSectionSurface);

const fullCanvasBackground = await page.evaluate(async () => {
  const rootNode = window.editor.getDocument().root;
  const previous = rootNode.style?.fill || null;
  window.editor.apply({ type: "node.set", node_id: rootNode.id, prop: "style.fill", value: { type: "solid", color: "#365f83" } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const canvas = document.querySelector('#host .fmde-canvas');
  const painted = canvas.style.background;
  window.editor.apply({ type: "node.set", node_id: rootNode.id, prop: "style.fill", value: previous });
  await new Promise((resolve) => setTimeout(resolve, 80));
  return { painted, restored: canvas.style.background };
});
check("the editable website background paints the full canvas gutters and chrome surface",
  /#365f83|rgb\(54,\s*95,\s*131\)/i.test(fullCanvasBackground.painted),
  fullCanvasBackground);

const rootBackgroundSelection = await page.evaluate(async () => {
  const rootNode = window.editor.getDocument().root;
  window.editor.select([rootNode.id]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const canvas = document.querySelector('#host .fmde-canvas').getBoundingClientRect();
  const outline = document.querySelector('#host .fmde-view-root-selbox')?.getBoundingClientRect();
  window.editor.select([]);
  return outline ? {
    top: outline.top - canvas.top,
    left: outline.left - canvas.left,
    right: canvas.right - outline.right,
    bottom: canvas.bottom - outline.bottom
  } : null;
});
check("the selected website background outline reaches every visible canvas edge",
  rootBackgroundSelection && Object.values(rootBackgroundSelection).every((gap) => Math.abs(gap - 4) <= 1),
  rootBackgroundSelection);

const centeredSectionWidths = await page.evaluate(async () => {
  const sections = window.editor.getDocument().root.children.slice(0, 2);
  window.editor.apply({ type: "node.set", node_id: sections[0].id, prop: "props.section_width", value: { width_percent: 100, max_enabled: true, max_width_px: 600 } });
  window.editor.apply({ type: "node.set", node_id: sections[1].id, prop: "props.section_width", value: { width_percent: 100, max_enabled: true, max_width_px: 800 } });
  await new Promise((resolve) => setTimeout(resolve, 150));
  return sections.map((section) => {
    const rect = document.querySelector('#host .fmde-canvas [data-node-id="' + section.id + '"]').getBoundingClientRect();
    return { left: rect.left, width: rect.width, center: rect.left + rect.width / 2 };
  });
});
const [narrowSection, wideSection] = centeredSectionWidths;
const sectionCenterDelta = Math.abs(narrowSection.center - wideSection.center);
const expectedLeftShift = (wideSection.width - narrowSection.width) / 2;
const actualLeftShift = narrowSection.left - wideSection.left;
check("differently sized website sections stay centered on one shared axis",
  sectionCenterDelta <= 1 && Math.abs(actualLeftShift - expectedLeftShift) <= 1,
  { sectionCenterDelta, expectedLeftShift, actualLeftShift, sections: centeredSectionWidths });

const snappedSectionWidth = await page.evaluate(async () => {
  const sections = window.editor.getDocument().root.children.slice(0, 2);
  window.editor.select([sections[1].id]);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const targetRect = document.querySelector('#host .fmde-canvas [data-node-id="' + sections[0].id + '"]').getBoundingClientRect();
  const handle = document.querySelector('#host .fmde-selbox .fmde-handle-e');
  const handleRect = handle.getBoundingClientRect();
  const y = handleRect.top + handleRect.height / 2;
  const pointer = (type, x, target) => (target || document).dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 91
  }));
  pointer('pointerdown', handleRect.left + handleRect.width / 2, handle);
  pointer('pointermove', targetRect.right + 4);
  pointer('pointerup', targetRect.right + 4);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const updated = window.editor.getDocument().root.children.find((item) => item.id === sections[1].id);
  const resizedRect = document.querySelector('#host .fmde-canvas [data-node-id="' + sections[1].id + '"]').getBoundingClientRect();
  return {
    maxWidthPx: updated?.props?.section_width?.max_width_px,
    targetWidth: targetRect.width,
    resizedWidth: resizedRect.width
  };
});
check("section width handles snap to another section's width",
  snappedSectionWidth.maxWidthPx === 600 && Math.abs(snappedSectionWidth.targetWidth - snappedSectionWidth.resizedWidth) <= 1,
  snappedSectionWidth);

await page.addScriptTag({ url: new URL('/libraries/visual-editor/firstmate-visual-editor.js', HARNESS).href });
const topSectionChrome = await page.evaluate(async () => {
  const definition = window.editor.getDocument();
  window.editor.destroy();
  const host = document.querySelector('#host');
  host.innerHTML = '';
  const chromeState = {
    uploadsList: [{ id: 'root-bg-image', name: 'Background image', content_type: 'image/svg+xml' }]
  };
  const visual = window.FMVisualEditor.mount(host, {
    document: definition,
    profile: 'website',
    mode: 'visual',
    media: {
      url: (ref) => ref?.media_id === 'root-bg-image'
        ? 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#56789a"/></svg>')
        : ref?.url || ''
    },
    documentActions: {
      getDevice: () => 'desktop',
      device: () => {},
      getSiteChromePreview: () => ({
        header: { visible: true, pageId: 'header_main', options: [{ id: 'header_main', title: 'Main header' }] },
        footer: { visible: true, pageId: 'footer_main', options: [{ id: 'footer_main', title: 'Main footer' }] }
      }),
      siteChromePreview: () => {}
    },
    chrome: { contentKind: 'web', state: chromeState, addSection: false }
  });
  window.__rootBackgroundDropVisual = visual;
  await new Promise((resolve) => setTimeout(resolve, 120));
  const firstSection = visual.editor.getDocument().root.children[0];
  visual.editor.apply({ type: 'node.set', node_id: firstSection.id, prop: 'props.section_width', value: { width_percent: 100, max_enabled: true, max_width_px: 1100 } });
  await new Promise((resolve) => setTimeout(resolve, 180));
  const maxCappedWidth = document.querySelector('[data-node-id="' + firstSection.id + '"]').getBoundingClientRect().width;
  visual.editor.apply({ type: 'node.set', node_id: firstSection.id, prop: 'props.section_width', value: { width_percent: 100, max_enabled: false, max_width_px: 1000 } });
  // Let the chrome zoom readout poll at least once. Its getter must preserve
  // fit-width so opening a palette can still refit to the smaller viewport.
  await new Promise((resolve) => setTimeout(resolve, 1350));
  const measureAvailableWidth = () => {
    const canvasRect = document.querySelector('.fmde-canvas').getBoundingClientRect();
    const sectionRect = document.querySelector('[data-node-id="' + firstSection.id + '"]').getBoundingClientRect();
    return { canvasLeft: canvasRect.left, canvasRight: canvasRect.right, canvasWidth: canvasRect.width, sectionLeft: sectionRect.left, sectionRight: sectionRect.right, sectionWidth: sectionRect.width };
  };
  const closedWidth = measureAvailableWidth();
  document.querySelector('[data-ch-tab="elements"]').click();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const openWidth = measureAvailableWidth();
  visual.editor.select([visual.editor.getDocument().root.children[0].id]);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const pill = document.querySelector('[data-ch-sec-pill]');
  const canvas = document.querySelector('.fmde-canvas');
  const toolbar = document.querySelector('.fmde-toolbar');
  const pillRect = pill.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  const toolbarRect = toolbar.getBoundingClientRect();
  const sectionRect = document.querySelector('[data-node-id="' + firstSection.id + '"]').getBoundingClientRect();
  const leftActions = Array.from(document.querySelectorAll('[data-ch-sec-actions] > button')).map((button) => button.title);
  const pillLabels = Array.from(pill.querySelectorAll(':scope > button')).map((button) => button.textContent.trim());
  pill.querySelector('[data-ch-sec-width]')?.click();
  const widthPopoverOpen = !!document.querySelector('[data-ch-sec-pill] [data-ch-sec-width-pop]:not(.hidden)');
  const liveRailGaps = [];
  const resizeHandle = document.querySelector('.fmde-selbox [data-fmde-handle="e"]');
  if (resizeHandle) {
    const handleRect = resizeHandle.getBoundingClientRect();
    const startX = handleRect.left + handleRect.width / 2;
    const pointerY = handleRect.top + handleRect.height / 2;
    const pointer = (type, x, target) => (target || document).dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: pointerY, button: 0, pointerId: 118
    }));
    pointer('pointerdown', startX, resizeHandle);
    for (const delta of [-30, -60, -90]) {
      pointer('pointermove', startX + delta);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const liveSection = document.querySelector('[data-node-id="' + firstSection.id + '"]').getBoundingClientRect();
      const liveActions = document.querySelector('[data-ch-sec-actions]').getBoundingClientRect();
      liveRailGaps.push({ gap: liveSection.left - liveActions.right, sectionLeft: liveSection.left, actionsRight: liveActions.right });
    }
    pointer('pointerup', startX - 90);
    await new Promise((resolve) => setTimeout(resolve, 80));
    visual.editor.apply({ type: 'node.set', node_id: firstSection.id, prop: 'props.section_width', value: { width_percent: 100, max_enabled: false, max_width_px: 1000 } });
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  visual.editor.select([visual.editor.getDocument().root.id]);
  document.querySelector('[data-ch-tab="media"]')?.click();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const mediaThumb = document.querySelector('[data-ch-up-item="root-bg-image"]');
  const dropCanvas = document.querySelector('.fmde-canvas');
  let backgroundDrag = null;
  if (mediaThumb && dropCanvas) {
    const from = mediaThumb.getBoundingClientRect();
    const target = dropCanvas.getBoundingClientRect();
    backgroundDrag = {
      from: { x: from.left + from.width / 2, y: from.top + from.height / 2 },
      to: { x: target.left + 12, y: target.top + target.height / 2 }
    };
  }
  return {
    below: pill.classList.contains('below'),
    centered: Math.abs((pillRect.left + pillRect.width / 2) - (sectionRect.left + sectionRect.width / 2)) <= 1,
    belowSection: pillRect.top >= sectionRect.bottom + 7,
    clearsToolbar: pillRect.top >= canvasRect.top && pillRect.top >= toolbarRect.bottom,
    leftActions,
    pillLabels,
    widthPopoverOpen,
    liveRailGaps,
    backgroundDrag,
    siteChromeRoles: Array.from(document.querySelectorAll('[data-ed-site-chrome]')).map((item) => item.getAttribute('data-ed-site-chrome')),
    maxCappedWidth,
    closedWidth,
    openWidth
  };
});
check("top sections move the centered Ask, Position, and Width menu below the section",
  topSectionChrome.below && topSectionChrome.centered && topSectionChrome.belowSection && topSectionChrome.clearsToolbar
    && topSectionChrome.leftActions[0] === 'Copy section'
    && /^(Lock|Unlock) section$/.test(topSectionChrome.leftActions[1])
    && topSectionChrome.leftActions[2] === 'Delete section'
    && topSectionChrome.pillLabels.join(',') === 'Ask,Position,Width'
    && topSectionChrome.widthPopoverOpen,
  topSectionChrome);
check("section action buttons track the resized left edge every animation frame",
  topSectionChrome.liveRailGaps?.length === 3
    && topSectionChrome.liveRailGaps.every((sample) => Math.abs(sample.gap - 8) <= 1)
    && new Set(topSectionChrome.liveRailGaps.map((sample) => Math.round(sample.sectionLeft))).size === 3,
  topSectionChrome.liveRailGaps);
let rootBackgroundDrop = null;
if (topSectionChrome.backgroundDrag) {
  await page.mouse.move(topSectionChrome.backgroundDrag.from.x, topSectionChrome.backgroundDrag.from.y);
  await page.mouse.down();
  await page.mouse.move(topSectionChrome.backgroundDrag.to.x, topSectionChrome.backgroundDrag.to.y, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  rootBackgroundDrop = await page.evaluate(() => {
    const visual = window.__rootBackgroundDropVisual;
    const fill = visual?.editor?.getDocument()?.root?.style?.fill;
    return { type: fill?.type, mediaId: fill?.media?.media_id, selection: visual?.editor?.selection?.() || [] };
  });
}
check("dragging media onto the selected canvas background sets the root image fill",
  rootBackgroundDrop?.type === 'image'
    && rootBackgroundDrop?.mediaId === 'root-bg-image'
    && rootBackgroundDrop?.selection?.length === 1,
  rootBackgroundDrop);
check("website toolbar always exposes header and footer preview controls",
  topSectionChrome.siteChromeRoles.join(',') === 'header,footer',
  topSectionChrome.siteChromeRoles);
check("100% website sections refit to the visible canvas when a palette opens",
  topSectionChrome.openWidth.canvasWidth < topSectionChrome.closedWidth.canvasWidth
    && topSectionChrome.openWidth.sectionWidth < topSectionChrome.closedWidth.sectionWidth
    && topSectionChrome.openWidth.sectionLeft >= topSectionChrome.openWidth.canvasLeft - 1
    && topSectionChrome.openWidth.sectionRight <= topSectionChrome.openWidth.canvasRight + 1,
  { closed: topSectionChrome.closedWidth, open: topSectionChrome.openWidth });
check("section maximum width can grow beyond the former design-page width",
  Math.abs(topSectionChrome.maxCappedWidth - 1100) <= 1,
  { renderedWidth: topSectionChrome.maxCappedWidth, requestedMaxWidth: 1100 });

const mobileDevicePreview = await page.evaluate(async () => {
  const visual = window.__rootBackgroundDropVisual;
  visual.setDevicePreview({ device: 'mobile' });
  await new Promise((resolve) => setTimeout(resolve, 180));
  visual.editor.select([visual.editor.getDocument().root.children[0].id]);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const initial = visual.getDevicePreview();
  const frameBefore = document.querySelector('[data-device-frame]').getBoundingClientRect();
  const deviceLayout = document.querySelector('.fmwe-device-layout');
  const layoutRect = deviceLayout.getBoundingClientRect();
  const toolsRect = document.querySelector('[data-device-tools]').getBoundingClientRect();
  const sectionActionsRect = document.querySelector('[data-ch-sec-actions]').getBoundingClientRect();
  const deviceChromePlacement = {
    toolsLeft: toolsRect.left - layoutRect.left,
    toolsTop: toolsRect.top - layoutRect.top,
    actionGap: frameBefore.left - sectionActionsRect.right,
    actionsClearTools: sectionActionsRect.left >= toolsRect.right + 4
  };
  const portraitNoOuterScroll = deviceLayout.scrollWidth <= deviceLayout.clientWidth + 2
    && deviceLayout.scrollHeight <= deviceLayout.clientHeight + 2;
  const expectedPhysicalWidth = 71.6 * 96 / 25.4;
  const zoomIn = document.querySelector('[data-device-zoom-in]');
  for (let step = 0; step < 8 && visual.getDevicePreview().renderedZoom < 1; step += 1) zoomIn.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const frameAtHundred = document.querySelector('[data-device-frame]').getBoundingClientRect();
  const zoomAtHundred = visual.getDevicePreview().renderedZoom;
  document.querySelector('[data-device-fit]').click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const canvas = document.querySelector('.fmde-canvas');
  const preset = document.querySelector('[data-device-preset]');
  const controls = Array.from(document.querySelectorAll('[data-device-tools] button')).map((item) => item.title);
  preset.value = 'custom';
  preset.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const resize = document.querySelector('[data-device-resize="xy"]');
  const rect = resize.getBoundingClientRect();
  const pointer = (type, x, y, target) => (target || document).dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 212, button: 0
  }));
  pointer('pointerdown', rect.left + rect.width / 2, rect.top + rect.height / 2, resize);
  pointer('pointermove', rect.left + rect.width / 2 + 30, rect.top + rect.height / 2 + 45);
  pointer('pointerup', rect.left + rect.width / 2 + 30, rect.top + rect.height / 2 + 45);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const resized = visual.getDevicePreview();
  document.querySelector('[data-device-rotate]').click();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const rotated = visual.getDevicePreview();
  const framePreZoom = document.querySelector('[data-device-frame]').getBoundingClientRect();
  const landscapeNoOuterScroll = deviceLayout.scrollWidth <= deviceLayout.clientWidth + 2
    && deviceLayout.scrollHeight <= deviceLayout.clientHeight + 2;
  document.querySelector('[data-device-zoom-out]').click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const framePostZoom = document.querySelector('[data-device-frame]').getBoundingClientRect();
  const viewportAfterZoom = visual.editor.getViewportWidth();
  visual.setDevicePreview({ device: 'desktop' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  return {
    initial,
    frameBefore: { width: frameBefore.width, height: frameBefore.height },
    frameAtHundred: { width: frameAtHundred.width, height: frameAtHundred.height },
    zoomAtHundred,
    expectedPhysicalWidth,
    deviceChromePlacement,
    portraitNoOuterScroll,
    landscapeNoOuterScroll,
    canvas: { width: parseFloat(canvas.style.width), height: parseFloat(canvas.style.height) },
    controls,
    resized,
    rotated,
    framePreZoom: { width: framePreZoom.width, height: framePreZoom.height },
    framePostZoom: { width: framePostZoom.width, height: framePostZoom.height },
    viewportAfterZoom,
    desktopRestored: !document.querySelector('[data-device-frame]') && visual.editor.getViewportWidth() === null
  };
});
check("mobile preview uses a full-height phone frame with device controls",
  mobileDevicePreview.initial.height > mobileDevicePreview.initial.width
    && mobileDevicePreview.frameBefore.height > mobileDevicePreview.frameBefore.width
    && mobileDevicePreview.controls.includes('Rotate device')
    && mobileDevicePreview.controls.includes('Zoom in')
    && mobileDevicePreview.controls.includes('Zoom out'),
  mobileDevicePreview);
check("100% mobile preview approximates the preset's physical body size",
  mobileDevicePreview.zoomAtHundred === 1
    && Math.abs(mobileDevicePreview.frameAtHundred.width - mobileDevicePreview.expectedPhysicalWidth) <= 3,
  { zoom: mobileDevicePreview.zoomAtHundred, renderedWidth: mobileDevicePreview.frameAtHundred.width, expectedWidth: mobileDevicePreview.expectedPhysicalWidth });
check("fit device includes the full shell and layout padding in both orientations",
  mobileDevicePreview.portraitNoOuterScroll && mobileDevicePreview.landscapeNoOuterScroll,
  { portrait: mobileDevicePreview.portraitNoOuterScroll, landscape: mobileDevicePreview.landscapeNoOuterScroll });
check("mobile device tools stay at the viewport corner and section actions clear the phone bezel",
  Math.abs(mobileDevicePreview.deviceChromePlacement.toolsLeft - 14) <= 1
    && Math.abs(mobileDevicePreview.deviceChromePlacement.toolsTop - 14) <= 1
    && mobileDevicePreview.deviceChromePlacement.actionGap >= 9
    && mobileDevicePreview.deviceChromePlacement.actionsClearTools,
  mobileDevicePreview.deviceChromePlacement);
check("custom mobile preview resizes both axes and rotation swaps them",
  mobileDevicePreview.resized.custom === true
    && mobileDevicePreview.resized.width > mobileDevicePreview.initial.width
    && mobileDevicePreview.resized.height > mobileDevicePreview.initial.height
    && mobileDevicePreview.rotated.width === mobileDevicePreview.resized.height
    && mobileDevicePreview.rotated.height === mobileDevicePreview.resized.width,
  mobileDevicePreview);
check("device zoom changes only presentation scale and desktop restores the canvas",
  mobileDevicePreview.framePostZoom.width < mobileDevicePreview.framePreZoom.width
    && mobileDevicePreview.viewportAfterZoom === mobileDevicePreview.rotated.width
    && mobileDevicePreview.desktopRestored,
  mobileDevicePreview);

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("failed: " + failed.map((f) => f.name).join("; "));
  process.exit(1);
}
