/* public/libraries/apps/settings/report-preview.js
 * Live HTML replica of the measurement report PDF for Settings > Reports.
 *
 * Every page is laid out in PDF millimetres (letter, 215.9 x 279.4 mm) with the constants of
 * measure/internal/editor_scripts/pdf.js, and text sits on the same baselines jsPDF uses, so a page
 * reads like the PDF it stands for. The data is the website's sample report (9210 NE 37th Pl,
 * Yarrow Point); its diagrams and imagery are cut from that report's page renders
 * (output/report-preview-20261014/crop.py) and placed where the PDF places them.
 *
 * Two documents: the customer PDF ("summary" mode, shaped by the customer report settings) and the
 * internal PDF ("full" mode, every page). The customer PDF carries the organization's colours and logo; the
 * internal PDF is not branded: pdf.js's default red (200,40,40 and 150,0,0) and the FirstMate logo.
 *
 * API: FirstMateReportPreview.render(host, { settings, logo })
 *   settings  the customer report settings (cover_show_*, page_*)
 *   logo      the organization's logo URL, or empty for the default FirstMate logo in the primary colour
 */
(function(){
  if (window.FirstMateReportPreview) return;
  const ASSETS = '/libraries/apps/settings/report-preview/';
  const ASSET_VERSION = '20261014-1';
  const MM = 4;                       // px per mm on an unscaled page
  // Portrait letter unless render() is given orientation 'landscape' (Company > Reports > Layout), when
  // every page is laid out as pdf.js lays out a landscape PDF: the drawing on the left (MAIN_W) and
  // tables and boxes in the side panel (SIDE_X, SIDE_W).
  let PAGE_W = 215.9, PAGE_H = 279.4, LANDSCAPE = false;
  const MARGIN = 25;
  let AVAIL_W = PAGE_W - 40, BOX_TOP = PAGE_H - 18 - 58, FOOTER_Y = PAGE_H - 16;
  let SIDE_W = AVAIL_W, MAIN_W = AVAIL_W, SIDE_X = MARGIN;
  function setOrientation(value){
    LANDSCAPE = value === 'landscape';
    PAGE_W = LANDSCAPE ? 279.4 : 215.9; PAGE_H = LANDSCAPE ? 215.9 : 279.4;
    AVAIL_W = PAGE_W - 40; BOX_TOP = PAGE_H - 18 - 58; FOOTER_Y = PAGE_H - 16;
    SIDE_W = LANDSCAPE ? Math.round(AVAIL_W * 0.36) : AVAIL_W; MAIN_W = LANDSCAPE ? AVAIL_W - SIDE_W - 8 : AVAIL_W; SIDE_X = LANDSCAPE ? MARGIN + MAIN_W + 8 : MARGIN;
  }
  // Portrait-designed positions stretched across the wider landscape page (pages whose PDF layout follows the width).
  const wideX = (x) => LANDSCAPE ? MARGIN + (x - MARGIN) * (AVAIL_W / 175.9) : x;
  const wideW = (w) => LANDSCAPE ? w * (AVAIL_W / 175.9) : w;

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const n = (value) => (Math.round(value * 100) / 100).toString();
  const mm = (value) => `${n(value * MM)}px`;
  const ptPx = (size) => size * 0.352778 * MM;
  const grey = (g) => `rgb(${g},${g},${g})`;

  // ---- jsPDF-like primitives ----
  // Text at a baseline (x, y) in mm; align is left, right or center like jsPDF.
  function text(x, y, value, o = {}){
    const size = ptPx(o.size || 9);
    const shift = o.align === 'right' ? '-100%' : o.align === 'center' ? '-50%' : '0';
    return `<span class="rpv-t" style="left:${mm(x)};top:${n(y * MM - size * 0.8585)}px;font-size:${n(size)}px;${o.bold ? 'font-weight:700;' : ''}color:${o.color || '#000'};transform:translateX(${shift})">${esc(value)}</span>`;
  }
  // Wrapped text whose first line sits on baseline y.
  function para(x, y, w, value, o = {}){
    const size = ptPx(o.size || 9), line = (o.lineH || 4) * MM;
    return `<div class="rpv-p" style="left:${mm(x)};top:${n(y * MM - (line / 2 + 0.3585 * size))}px;width:${mm(w)};font-size:${n(size)}px;line-height:${n(line)}px;${o.bold ? 'font-weight:700;' : ''}color:${o.color || '#000'}">${esc(value)}</div>`;
  }
  const rect = (x, y, w, h, style = '') => `<div class="rpv-b" style="left:${mm(x)};top:${mm(y)};width:${mm(w)};height:${mm(h)};${style}"></div>`;
  const hline = (x1, y, x2, color, width = 0.2) => rect(x1, y - width / 2, x2 - x1, width, `background:${color}`);
  const vline = (x, y1, y2, color, width = 0.1) => rect(x - width / 2, y1, width, y2 - y1, `background:${color}`);
  const image = (name, x, y, w, h, style = '') => `<img class="rpv-i" alt="" src="${ASSETS}${name}.webp?v=${ASSET_VERSION}" style="left:${mm(x)};top:${mm(y)};width:${mm(w)};height:${mm(h)};${style}">`;
  // An image fitted (not stretched) into a box, as placeImageCentered does on landscape pages.
  const fitImage = (name, x, y, w, h, style = '') => image(name, x, y, w, h, `object-fit:contain;${style}`);
  // drawPdfCard / drawSummaryBox: shadow offset 1.5, white card with a 0.3 border, radius 3, optional
  // 2 mm primary strip and an uppercase grey title.
  function card(x, y, w, h, o = {}){
    const radius = o.radius ?? 3;
    let out = rect(x + 1.5, y + 1.5, w, h, `background:${grey(230)};border-radius:${mm(radius)}`);
    out += `<div class="rpv-b rpv-card" style="left:${mm(x)};top:${mm(y)};width:${mm(w)};height:${mm(h)};border-radius:${mm(radius)};border:${mm(o.border ?? 0.3)} solid ${grey(220)}">${o.strip ? `<div class="rpv-strip" style="width:${mm(2)}"></div>` : ''}</div>`;
    if (o.title) out += text(x + 8, y + (o.titleY ?? 8), String(o.title).toUpperCase(), { size:9, bold:true, color:grey(150) });
    return out;
  }

  // ---- Sample report (website sample, 9210 NE 37th Pl) ----
  const SAMPLE = {
    address:'9210 NE 37th Pl, Yarrow Point, WA 98004, USA',
    date:'6/17/2026',
    customer:'Homeowner',
    facets:19, pitch:'4/12', netSquares:48.53, roofSqFt:4853.07, waste:14, wasteSquares:55.32,
    pitches:[['0/12', 0.25], ['4/12', 30.35], ['5/12', 11.57], ['6/12', 3.88], ['8/12', 2.48]],
    // The order the internal cover lists them in.
    linear:[['Eave', 303], ['Hip', 231], ['Ridge', 98], ['Valley', 176], ['Rake', 62], ['Headwall Flashing', 2], ['Sidewall Flashing', 14], ['Transition', 21]],
    // drawDynamicCoverPage's order and labels.
    coverLines:[['Ridge', 98], ['Hip', 231], ['Valley', 176], ['Rake', 62], ['Eave', 303], ['Headwall', 2], ['Sidewall', 14], ['Transition', 21]],
    stats:[['Roof Area', '4853 sq ft'], ['Facets', '19'], ['Pitch', '4 / 12'], ['Skylights', '4'], ['Chimneys', '2'], ['Ridge', '98 ft'], ['Hip', '231 ft'], ['Valley', '176 ft'], ['Rake', '62 ft'], ['Eave', '303 ft'], ['Headwall Flashing', '2 ft'], ['Sidewall Flashing', '14 ft'], ['Transition', '21 ft'], ['Chimney Back Pan', '3 ft'], ['Chimney Step', '9 ft'], ['Chimney Apron', '5 ft'], ['Counter Flashing', '16 ft']],
    steepWastes:[0, 9, 14, 19],
    steep1:[
      ['Shingle Products', 'bundle', [['GAF Timberline HDZ', 145, 159, 166, 173], ['OC TruDef Duration', 145, 159, 166, 173], ['CertainTeed Landmark', 145, 159, 166, 173], ['Malarkey Vista AR', 145, 159, 166, 173]]],
      ['Starter Strip', 'bundle', [['GAF Pro-Start', 4, 5, 5, 5], ['OC Starter Strip', 4, 5, 5, 5], ['CertainTeed SwiftStart', 4, 5, 5, 5], ['Malarkey Starter Strip', 4, 5, 5, 5]]],
      ['Hip & Ridge Cap', 'bundle', [['GAF Seal-A-Ridge', 14, 16, 16, 17], ['OC ProEdge', 10, 11, 12, 12], ['CertainTeed Shadow Ridge', 11, 12, 13, 14], ['Malarkey EZ-Ridge', 14, 16, 16, 17]]],
      ['Synthetic Underlayment', 'roll', [['GAF FeltBuster', 6, 7, 7, 8], ['OC ProArmor', 6, 7, 7, 8], ['CertainTeed RoofRunner', 6, 7, 7, 8], ['Malarkey Secure Start Plus', 6, 7, 7, 8]]]
    ],
    iceWater:[
      ['36\u201D perimeter application (2017 sq ft)', [['GAF WeatherWatch', 11, 12, 13, 14], ['OC WeatherLock Flex', 9, 10, 11, 11], ['CertainTeed WinterGuard', 11, 12, 13, 14], ['Malarkey Secure Start I&W', 11, 12, 13, 14]]],
      ['18\u201D perimeter application (1470 sq ft)', [['GAF WeatherWatch', 8, 9, 10, 10], ['OC WeatherLock Flex', 7, 8, 8, 9], ['CertainTeed WinterGuard', 8, 9, 10, 10], ['Malarkey Secure Start I&W', 8, 9, 10, 10]]]
    ],
    steep2:[
      ['Metals & Flashing', null, [['Eave Drip Edge (10 ft)', 'piece', 31, 34, 36, 37], ['Rake Drip Edge (10 ft)', 'piece', 7, 8, 8, 9], ['Valley Metal W (10 ft)', 'piece', 18, 20, 21, 22], ['Step Flashing (5x7)', 'piece', 94, 103, 108, 112], ['Counter Flashing (10 ft)', 'piece', 4, 5, 5, 5], ['Headwall Flashing (10 ft)', 'piece', 3, 4, 4, 4], ['Chimney Apron (front)', 'ea', 2, 3, 3, 3], ['Chimney Back Pan / Cricket', 'ea', 2, 3, 3, 3], ['Chimney Step Flashing', 'piece', 19, 21, 22, 23], ['Chimney Counter Flash (10 ft)', 'piece', 2, 3, 3, 3], ['Skylight Flashing Kit', 'kit', 4, 5, 5, 5]]],
      ['Ventilation', null, [['Ridge Vent (4 ft sections)', 'piece', 25, 28, 29, 30]]],
      ['Accessories', null, [['Coil Nails (1.25 in, 50 lb)', 'box', 3, 4, 4, 4], ['Plastic Cap Nails', 'box', 1, 2, 2, 2], ['Roofing Caulk (Tube)', 'tube', 3, 4, 4, 4]]]
    ],
    flat:[
      ['Membrane System', [['Membrane / Cap Sheet', 'roll', 2, 2, 2, 2, 2], ['Bonding Adhesive', 'gal', 2, null, 2, 2, null]]],
      ['Insulation & Cover Board', [['1/2" 4x8 Cover Board', 'SQ', 1, 1, 1, 1, 1], ["Cover Board (4'\u00D78')", 'sheet', 2, 2, 2, 2, 2], ["Polyiso Insulation (4'\u00D78')", 'sheet', 2, 2, 2, 2, 2], ['3" Insulation Plates', 'ea', 370, 370, 370, 370, 370], ['2" HD Fasteners', '1000', 1, 1, 1, 1, 1]]],
      ['Mechanically-Fastened (TPO Only)', [['2-3/8" Membrane Plates', '1000', null, 0, null, null, null], ['Seam Fasteners (for membrane plates)', '1000', null, 0, null, null, null]]],
      ['Edge & Termination', [['Termination Bar (10 ft)', 'piece', null, null, null, null, null], ['Edge Metal (10 ft)', 'piece', 43, 43, 43, 43, 43]]],
      ['Sealant & Accessories', [['Walk Pad (34"\u00D750\')', 'roll', 2, 2, 2, 2, null], ['TPO Cut Edge Sealant', 'each', 2, 2, null, null, null], ['Cleaner', 'each', 1, 1, null, null, null], ['Universal Single Ply Sealant', 'tube', 13, 13, 13, 13, null], ['Sealant / Caulk', 'tube', 2, 2, 2, 2, 2]]]
    ],
    layerLegend:[['Ridge', '#FF0000', 25.1, 186], ['Hip', '#E67300', 55.4, 186], ['Valley', '#800080', 82, 186], ['Rake', '#006400', 112.5, 186], ['Eave', '#FFD400', 141.2, 186], ['Headwall Flashing', '#A0522D', 25.1, 196], ['Sidewall Flashing', '#FF00FF', 75.4, 196], ['Transition', '#808080', 124.2, 196]],
    layerItems:[["Eave: 303'", 33, 228.3], ["Hip: 231'", 56.4, 228.3], ["Ridge: 98'", 77, 228.3], ["Valley: 176'", 100.3, 228.3], ["Rake: 62'", 125, 228.3], ["Headwall Flashing: 2'", 146.8, 228.3], ["Sidewall Flashing: 14'", 33, 236.4], ["Transition: 21'", 74, 236.4]]
  };

  // ---- Page frame (drawReportTemplate) ----
  function frame(ctx, page, number){
    let out = rect(0, 0, 8, PAGE_H, 'background:var(--rpv-primary)') + rect(8, 0, 2, PAGE_H, 'background:var(--rpv-secondary)');
    out += ctx.unbranded
      ? `<img class="rpv-logo" alt="" src="/images/logo_red.png" style="left:${mm(20)};top:${mm(10)};height:${mm(12)}">`
      : ctx.logo
      ? `<img class="rpv-logo" alt="" src="${esc(ctx.logo)}" style="left:${mm(20)};top:${mm(10)};height:${mm(12)}">`
      : `<div class="rpv-logo rpv-logo-default" style="left:${mm(20)};top:${mm(10)};height:${mm(12)};width:${mm(12 * 661 / 251)}"></div>`;
    if (page.cover) {
      out += text(PAGE_W - 20, 15, SAMPLE.address, { size:9, color:grey(100), align:'right' });
      out += text(PAGE_W - 20, 20, SAMPLE.date, { size:9, color:grey(100), align:'right' });
    } else {
      out += text(PAGE_W - 20, 18, page.title, { size:12, bold:true, color:grey(50), align:'right' });
      out += text(25, FOOTER_Y, `${SAMPLE.address}  |  ${SAMPLE.date}`, { size:8, color:grey(150) });
      out += text(PAGE_W - 15, FOOTER_Y, `Page ${number}`, { size:8, color:grey(150), align:'right' });
    }
    return out;
  }

  // ---- Pages ----
  // Landscape: the outline fills the left at full height (cover map 40 mm to the bottom margin).
  const COVER_H = () => PAGE_H - 18 - 40;
  const outlineCard = () => LANDSCAPE
    ? card(MARGIN, 40, MAIN_W, COVER_H()) + fitImage('outline', MARGIN + 1.5, 41.5, MAIN_W - 3, COVER_H() - 3)
    : card(MARGIN, 40, AVAIL_W, BOX_TOP - 10 - 40) + image('outline', 26.5, 41.5, 172.9, 150.4);

  function coverInternal(){
    // Portrait: two boxes side by side under the outline. Landscape: stacked in the side panel.
    const boxW = LANDSCAPE ? SIDE_W : AVAIL_W / 2 - 3, boxH = LANDSCAPE ? (COVER_H() - 6) / 2 : 58;
    const box1X = LANDSCAPE ? SIDE_X : MARGIN, box1Y = LANDSCAPE ? 40 : BOX_TOP, box2X = LANDSCAPE ? SIDE_X : MARGIN + boxW + 6, box2Y = LANDSCAPE ? 40 + boxH + 6 : BOX_TOP;
    let out = outlineCard();
    out += card(box1X, box1Y, boxW, boxH, { strip:true, title:'Project Summary' });
    let y = box1Y + 16;
    out += text(box1X + 8, y, `Total Facets: ${SAMPLE.facets}`); y += 5;
    out += text(box1X + 8, y, `Predominant Pitch: ${SAMPLE.pitch}`); y += 10;
    out += text(box1X + 8, y, `Total Squares (Net): ${SAMPLE.netSquares}`); y += 5;
    out += text(box1X + 8, y, `Total Squares (${SAMPLE.waste}% Waste): ${SAMPLE.wasteSquares}`);
    out += card(box2X, box2Y, boxW, boxH, { strip:true, title:'Measurement Breakdown' });
    y = box2Y + 16;
    SAMPLE.linear.forEach(([label, value]) => {
      out += text(box2X + 8, y, `${label}:`) + text(box2X + boxW - 8, y, `${value}'`, { align:'right' });
      y += 5;
    });
    return out;
  }

  // drawDynamicCoverPage: what the customer report settings put under the outline.
  function coverCustomer(s){
    const showCustomer = !!s.cover_show_customer;
    const showStats = !!(s.cover_show_squares || s.cover_show_waste || s.cover_show_pitch || s.cover_show_facets);
    const showLines = !!s.cover_show_breakdown;
    // Landscape (drawDynamicCoverPage stacked): Prepared For above Roof Measurements in the side
    // panel, and the line lengths under the totals.
    const gap = 8, w = LANDSCAPE ? SIDE_W : AVAIL_W, x = LANDSCAPE ? SIDE_X : MARGIN, y = LANDSCAPE ? 40 : BOX_TOP, h = LANDSCAPE ? COVER_H() : 58;
    let leftW = 0, rightW = w, rightX = x;
    if (showCustomer) {
      leftW = w * 0.4 - gap / 2; rightW = w * 0.6 - gap / 2; rightX = x + leftW + gap;
      if (!showStats && !showLines) leftW = w;
    }
    let custH = h, rightY = y, rightH = h;
    if (LANDSCAPE) { leftW = w; rightW = w; rightX = x; if (showCustomer && (showStats || showLines)) { custH = 50; rightY = y + 56; rightH = h - 56; } }
    let out = outlineCard();
    if (showCustomer) {
      out += card(x, y, leftW, custH, { strip:true, title:'Prepared For', titleY:7 });
      out += text(x + 8, y + 14, SAMPLE.customer, { size:11, bold:true, color:grey(50) });
      out += para(x + 8, y + 19, leftW - 16, SAMPLE.address, { size:10, lineH:4, color:grey(50) });
    }
    if (showStats || showLines) {
      out += card(rightX, rightY, rightW, rightH, { strip:true, title:'Roof Measurements', titleY:7 });
      const leftColX = rightX + 8;
      const rightColX = showStats && showLines && !LANDSCAPE ? rightX + rightW * 0.62 : rightX + 8;
      let statsEnd = rightY + 14;
      if (showStats) {
        let cy = rightY + 14;
        if (s.cover_show_squares) {
          out += text(leftColX, cy, s.cover_show_waste ? `Total Squares (+${SAMPLE.waste}% Waste)` : 'Total Squares', { size:10, bold:true, color:grey(50) });
          cy += 9;
          out += `<span class="rpv-t" style="left:${mm(leftColX)};top:${n(cy * MM - ptPx(28) * 0.8585)}px;font-size:${n(ptPx(28))}px;font-weight:700;color:var(--rpv-primary)">${s.cover_show_waste ? SAMPLE.wasteSquares : SAMPLE.netSquares}</span>`;
          cy += 7;
        }
        if (s.cover_show_pitch) { out += text(leftColX, cy, `Pitch: ${SAMPLE.pitch}`, { color:grey(80) }); cy += 4.5; }
        if (s.cover_show_waste) { out += text(leftColX, cy, `Waste: ${SAMPLE.waste}%`, { color:grey(80) }); cy += 4.5; }
        if (s.cover_show_facets) { out += text(leftColX, cy, `Facets: ${SAMPLE.facets}`, { color:grey(80) }); cy += 4.5; }
        statsEnd = cy + 4;
      }
      if (showLines) {
        let cy = LANDSCAPE && showStats ? statsEnd + 2 : rightY + 14;
        SAMPLE.coverLines.forEach(([label, value]) => {
          out += text(rightColX + 2, cy, label, { color:grey(80) }) + text(rightX + rightW - 8, cy, `${value}'`, { bold:true, align:'right' });
          cy += 5;
        });
      }
    }
    return out;
  }

  // A square as large as fits (the page height limits it in landscape), centred.
  const imageryPage = () => { const size = Math.min(AVAIL_W, PAGE_H - 35 - 30), x = MARGIN + (AVAIL_W - size) / 2; return card(x, 35, size, size, { border:0.4 }) + image('imagery', x + 0.5, 35.5, size - 1, size - 1, `border-radius:${mm(2.6)}`); };

  const VIEWS = [['north', 'North View'], ['south', 'South View'], ['east', 'East View'], ['west', 'West View']];
  // drawQuadGridPage: 2x2 cards with a grey header bar.
  function facetsPage(){
    // The cells are as tall as wide plus the header; in landscape the height limits the grid width.
    const gridW = Math.min(AVAIL_W, 2 * ((PAGE_H - 55 - 10) / 2 - 8) + 10), gridX = MARGIN + (AVAIL_W - gridW) / 2;
    const cellW = (gridW - 10) / 2, cellH = cellW + 8;
    let out = '';
    VIEWS.forEach(([name, label], i) => {
      const px = gridX + (i % 2) * (cellW + 10), py = 35 + Math.floor(i / 2) * (cellH + 10);
      out += card(px, py, cellW, cellH);
      out += rect(px, py, cellW, 8, `background:#676767;border-radius:${mm(3)} ${mm(3)} 0 0`);
      out += text(px + cellW / 2, py + 5, label, { size:10, bold:true, color:'#fff', align:'center' });
      out += image(`view-${name}`, px + 1.5, py + 8.3, cellW - 3, cellH - 9.8);
    });
    return out;
  }

  // drawSummaryPageLayout at y 30.
  // drawSummaryPageLayout on a landscape page: the pitch and waste tables share the top band (row
  // labels 22 mm wide), then the outline and the totals card, whose rows tighten to fit.
  function summaryPageLandscape(){
    let out = '';
    const pitches = SAMPLE.pitches, total = pitches.reduce((sum, [, v]) => sum + v, 0), dom = SAMPLE.pitch, top = 38;
    const tableW = Math.min(AVAIL_W * 0.42, (pitches.length + 1) * 25), tableX = MARGIN, labelW = 22, valW = (tableW - labelW) / pitches.length, valX = (i) => tableX + labelW + i * valW + valW / 2;
    out += card(tableX, top - 2, tableW, 27);
    out += text(tableX + 4, top + 5, 'Pitch', { bold:true }) + text(tableX + 4, top + 13, 'Area (sq ft)', { bold:true }) + text(tableX + 4, top + 21, 'Percent', { bold:true });
    pitches.forEach(([p, v], i) => {
      out += text(valX(i), top + 5, p, { bold:true, align:'center' });
      out += text(valX(i), top + 13, Math.round(v * 100).toLocaleString('en-US'), { bold:p === dom, align:'center' });
      out += text(valX(i), top + 21, `${Math.round(v / total * 100)}%`, { bold:p === dom, align:'center' });
    });
    const wastes = [0, SAMPLE.waste - 5, SAMPLE.waste - 2, SAMPLE.waste, SAMPLE.waste + 2, SAMPLE.waste + 5, SAMPLE.waste + 10];
    const suggested = wastes.indexOf(SAMPLE.waste), wX = tableX + tableW + 6, wW = AVAIL_W - tableW - 6, innerW = wW - 12, contentX = wX + 6, wValW = (innerW - labelW) / wastes.length, wValX = (i) => contentX + labelW + i * wValW + wValW / 2;
    out += card(wX, top - 2, wW, 28);
    for (let i = 1; i <= wastes.length; i++) out += vline(contentX + labelW + (i - 1) * wValW, top, top + 24, grey(230));
    out += hline(contentX, top + 8, contentX + innerW, grey(230), 0.1) + hline(contentX, top + 16, contentX + innerW, grey(230), 0.1);
    out += rect(contentX + labelW + suggested * wValW, top - 1, wValW, 26, `border:${mm(0.7)} solid rgb(200,40,40);border-radius:${mm(1)};box-sizing:border-box`);
    out += text(contentX + 2, top + 5, 'Waste', { bold:true }) + text(contentX + 2, top + 13, 'Area (sq ft)', { bold:true }) + text(contentX + 2, top + 21, 'Squares', { bold:true });
    wastes.forEach((v, i) => {
      out += text(wValX(i), top + 5, `${v}%`, { bold:true, align:'center' });
      out += text(wValX(i), top + 13, Math.round(SAMPLE.roofSqFt * (1 + v / 100)).toLocaleString('en-US'), { bold:i === suggested, align:'center' });
      out += text(wValX(i), top + 21, String(Math.ceil(total * (1 + v / 100))), { bold:i === suggested, align:'center' });
    });
    const imageTop = top + 40, statsW = Math.max(40, AVAIL_W * 0.3 - 15), imgAvail = AVAIL_W - statsW - 15;
    out += fitImage('summary-outline', MARGIN, imageTop, imgAvail, Math.min(130, PAGE_H - 34 - imageTop));
    const statsX = MARGIN + imgAvail + 10, rows = SAMPLE.stats.length;
    let statsY = imageTop + 8;
    const rowH = Math.max(5.5, Math.min(8, (PAGE_H - 34 - statsY) / Math.max(1, rows - 1))), size = rowH < 7 ? 8 : 9;
    out += card(statsX - 2, statsY - 6, statsW + 4, 12 + (rows - 1) * rowH);
    SAMPLE.stats.forEach(([label, value], i) => {
      out += text(statsX, statsY, label, { bold:true, size }) + text(statsX + statsW, statsY, value, { align:'right', size });
      if (i < rows - 1) out += hline(statsX, statsY + 2, statsX + statsW, grey(230), 0.2);
      statsY += rowH;
    });
    return out + text(MARGIN, PAGE_H - 28, 'Measurements rounded. Waste guidance only. Installer to verify.', { size:6, color:grey(80) });
  }
  function summaryPage(){
    if (LANDSCAPE) return summaryPageLandscape();
    let out = '';
    const pitches = SAMPLE.pitches, total = pitches.reduce((sum, [, v]) => sum + v, 0);
    const dom = SAMPLE.pitch;
    const colCount = pitches.length + 1, tableW = Math.min(AVAIL_W, colCount * 25), tableX = MARGIN + (AVAIL_W - tableW) / 2, colW = tableW / colCount;
    let cy = 38;
    out += card(tableX, cy - 2, tableW, 27);
    out += text(tableX + 4, cy + 5, 'Pitch', { bold:true });
    pitches.forEach(([p], i) => { out += text(tableX + (i + 1) * colW + colW / 2, cy + 5, p, { bold:true, align:'center' }); });
    cy += 8;
    out += text(tableX + 4, cy + 5, 'Area (sq ft)', { bold:true });
    pitches.forEach(([p, v], i) => { out += text(tableX + (i + 1) * colW + colW / 2, cy + 5, Math.round(v * 100).toLocaleString('en-US'), { bold:p === dom, align:'center' }); });
    cy += 8;
    out += text(tableX + 4, cy + 5, 'Percent', { bold:true });
    pitches.forEach(([p, v], i) => { out += text(tableX + (i + 1) * colW + colW / 2, cy + 5, `${Math.round(v / total * 100)}%`, { bold:p === dom, align:'center' }); });
    cy += 16;
    const wastes = [0, SAMPLE.waste - 5, SAMPLE.waste - 2, SAMPLE.waste, SAMPLE.waste + 2, SAMPLE.waste + 5, SAMPLE.waste + 10];
    const suggested = wastes.indexOf(SAMPLE.waste), innerW = AVAIL_W - 12, wColW = innerW / (wastes.length + 1), contentX = MARGIN + 6;
    out += card(MARGIN, cy - 2, AVAIL_W, 28);
    for (let i = 1; i <= wastes.length; i++) out += vline(contentX + i * wColW, cy, cy + 24, grey(230));
    out += hline(contentX, cy + 8, contentX + innerW, grey(230), 0.1) + hline(contentX, cy + 16, contentX + innerW, grey(230), 0.1);
    out += rect(contentX + (suggested + 1) * wColW, cy - 1, wColW, 26, `border:${mm(0.7)} solid rgb(200,40,40);border-radius:${mm(1)};box-sizing:border-box`);
    // The report's exact roof area; the per-pitch squares above are rounded.
    const sqft = SAMPLE.roofSqFt;
    out += text(contentX + 2, cy + 5, 'Waste', { bold:true });
    wastes.forEach((v, i) => { out += text(contentX + (i + 1) * wColW + wColW / 2, cy + 5, `${v}%`, { bold:true, align:'center' }); });
    out += text(contentX + 2, cy + 13, 'Area (sq ft)', { bold:true });
    wastes.forEach((v, i) => { out += text(contentX + (i + 1) * wColW + wColW / 2, cy + 13, Math.round(sqft * (1 + v / 100)).toLocaleString('en-US'), { bold:i === suggested, align:'center' }); });
    out += text(contentX + 2, cy + 21, 'Squares', { bold:true });
    wastes.forEach((v, i) => { out += text(contentX + (i + 1) * wColW + wColW / 2, cy + 21, String(Math.ceil(total * (1 + v / 100))), { bold:i === suggested, align:'center' }); });
    out += image('summary-outline', 25, 103, 127, 145);
    const statsX = MARGIN + (AVAIL_W - 55) + 10, statsW = 40;
    let statsY = 110;
    out += card(statsX - 2, statsY - 6, statsW + 4, 12 + (SAMPLE.stats.length - 1) * 8);
    SAMPLE.stats.forEach(([label, value], i) => {
      out += text(statsX, statsY, label, { bold:true }) + text(statsX + statsW, statsY, value, { align:'right' });
      if (i < SAMPLE.stats.length - 1) out += hline(statsX, statsY + 2, statsX + statsW, grey(230), 0.2);
      statsY += 8;
    });
    out += text(MARGIN, PAGE_H - 28, 'Measurements rounded. Waste guidance only. Installer to verify.', { size:6, color:grey(80) });
    return out;
  }

  // drawMaterialTable: waste columns from 45% of the width, the suggested column boxed in red.
  // The column the material table is drawn in: the page width in portrait; in landscape the left or
  // right half, with 58% for the product names and 8 pt rows (pdf.js drawMaterialTable setColumn).
  let COL = { x:MARGIN, w:AVAIL_W, share:0.45, size:9 };
  const useColumn = (half) => { const w = LANDSCAPE ? (AVAIL_W - 8) / 2 : AVAIL_W; COL = { x:MARGIN + (half ? w + 8 : 0), w, share:LANDSCAPE ? 0.58 : 0.45, size:LANDSCAPE ? 8 : 9 }; };
  function steepColumns(){
    const colStart = COL.x + COL.w * COL.share, colW = (COL.w * (1 - COL.share) - 8) / SAMPLE.steepWastes.length;
    return { colStart, colW, centre:(i) => colStart + colW / 2 + i * colW };
  }
  function steepHeader(){
    const { colStart, centre } = steepColumns();
    let out = text(colStart - 15, 40, 'Waste', { size:10, bold:true });
    SAMPLE.steepWastes.forEach((w, i) => { out += text(centre(i), 40, `${w}%`, { size:10, bold:true, align:'center' }); });
    return out + hline(COL.x + 8, 45, COL.x + COL.w - 8, grey(200), 0.2);
  }
  function steepRow(label, unit, values, y){
    const { colStart, centre } = steepColumns(), suggested = SAMPLE.steepWastes.indexOf(SAMPLE.waste);
    let out = text(COL.x + 8, y, label, { size:COL.size }) + text(colStart - 10, y, unit, { align:'right', size:COL.size });
    values.forEach((v, i) => { out += text(centre(i), y, String(v), { bold:i === suggested, align:'center', size:COL.size }); });
    return out;
  }
  function steepBox(bottom){
    const { colStart, colW } = steepColumns(), suggested = SAMPLE.steepWastes.indexOf(SAMPLE.waste);
    return rect(colStart + suggested * colW - 0.4, 35 - 0.4, colW + 0.8, bottom - 36 + 0.8, `border:${mm(0.8)} solid rgb(200,40,40);box-sizing:border-box`);
  }
  // Landscape draws page 1 as shingles, starter and hip & ridge on the left, underlayment and ice &
  // water on the right; page 2 as metals on the left and the rest on the right.
  function steepPage1(){
    useColumn(false);
    let out = steepHeader(), y = 50;
    SAMPLE.steep1.forEach(([section, unit, rows], s) => {
      if (LANDSCAPE && s === 3) { out += steepBox(y - 4); useColumn(true); out += steepHeader(); y = 50; }
      out += text(COL.x + 8, y, section, { bold:true }); y += 6;
      rows.forEach(([label, ...values]) => { out += steepRow(label, unit, values, y); y += 6; });
      y += 4;
    });
    out += text(COL.x + 8, y, 'Ice & Water Shield', { bold:true }); y += 6;
    SAMPLE.iceWater.forEach(([note, rows], i) => {
      if (i) y += 2;
      out += text(COL.x + 10, y, note, { size:8, color:grey(100) }); y += 5;
      rows.forEach(([label, ...values]) => { out += steepRow(label, 'roll', values, y); y += 6; });
    });
    out += steepBox(y);
    useColumn(false);
    return out;
  }
  function steepPage2(){
    useColumn(false);
    let out = steepHeader(), y = 50;
    SAMPLE.steep2.forEach(([section, , rows], i) => {
      if (LANDSCAPE && i === 1) { out += steepBox(y); useColumn(true); out += steepHeader(); y = 50; }
      else if (i) y += 4;
      out += text(COL.x + 8, y, section, { bold:true }); y += 6;
      rows.forEach(([label, unit, ...values]) => { out += steepRow(label, unit, values, y); y += 6; });
    });
    out += steepBox(y);
    useColumn(false);
    return out;
  }

  // drawFlatMaterialTable.
  // The flat table follows the page width; a row that would reach the footer starts a new page with
  // the headers repeated (landscape), as drawFlatMaterialTable does. Returns one HTML string per page.
  function flatPages(){
    const fx = (x) => LANDSCAPE ? 33 + (x - 33) * ((AVAIL_W - 16) / 159.9) : x, right = fx(192.9), cols = [118.6, 134.6, 151.4, 168, 184.6].map(fx);
    const headers = () => text(33, 47, 'Material', { size:8, bold:true, color:grey(80) }) + text(fx(99), 47, 'Unit', { size:8, bold:true, color:grey(80) })
      + ['TPO (Adh)', 'TPO (MF)', 'EPDM', 'PVC', 'Mod Bit'].map((label, i) => text(cols[i], 47, label, { size:8, bold:true, color:grey(80), align:'center' })).join('') + hline(33, 50.3, right, grey(200), 0.2);
    const pages = [];
    let out = text(33, 40, `Flat Roof Area: 24.708 sq ft  (0.25 sq)  |  Waste: ${SAMPLE.waste}%`, { size:10, bold:true }) + headers(), y = 55;
    const room = (needed) => { if (y + needed <= PAGE_H - 26) return; pages.push(out); out = headers(); y = 55; };
    SAMPLE.flat.forEach(([section, rows]) => {
      room(6.1 + 5.5);
      out += text(33, y, section, { size:8.5, bold:true, color:'#222' }) + hline(33, y + 2.5, right, grey(210), 0.2);
      y += 6.1;
      rows.forEach(([label, unit, ...values], i) => {
        room(5.5);
        if (i % 2) out += rect(33, y - 3.8, right - 33, 5.5, `background:${grey(248)}`);
        out += text(33, y, label, { size:8.5, color:'#333' }) + text(fx(99), y, unit, { size:8.5, color:grey(150) });
        values.forEach((v, c) => { out += v == null ? text(cols[c], y, '\u2014', { size:8.5, color:grey(200), align:'center' }) : text(cols[c], y, String(v), { size:8.5, bold:true, align:'center' }); });
        y += 5.5;
      });
      y += 1.9;
    });
    pages.push(out + text(33, y + 3.6, `Sections at 2/12 or below classified as low-slope. Quantities include ${SAMPLE.waste}% waste where applicable. Numbers are estimates only.`, { size:6, color:grey(130) }));
    return pages;
  }

  // drawVentilationPage.
  function ventilationPage(){
    const red = 'rgb(217,48,37)', blue = 'rgb(26,115,232)', green = 'rgb(52,168,83)';
    // drawVentilationPage follows the page width, so landscape stretches the x positions (wideX/wideW);
    // the map shrinks to stay above the footer note.
    const X = wideX, W = wideW;
    let out = card(MARGIN, 35, AVAIL_W, 24, { strip:true, title:'Ventilation Summary' });
    out += text(33, 47.6, 'Estimated Attic Area', { size:8, color:grey(120) });
    out += text(33, 55, '4,435 sq ft', { size:15, bold:true, color:red });
    out += text(X(83), 54.6, 'Footprint: 4,526 sq ft  |  Surface: 4,853 sq ft', { size:6, color:grey(130) });
    out += text(X(193), 40, 'Recommended Exhaust', { size:7, color:grey(120), align:'right' }) + text(X(193), 45.5, '2129 sq in', { size:12, bold:true, color:red, align:'right' });
    out += text(X(193), 50, 'Recommended Intake', { size:7, color:grey(120), align:'right' }) + text(X(193), 55.5, '2129 sq in', { size:12, bold:true, color:red, align:'right' });
    const table = (x, w, title, cells) => {
      let t = card(x, 64, w, 32) + rect(x + 0.3, 64.3, w - 0.6, 7, `background:${grey(245)};border-radius:${mm(2.7)} ${mm(2.7)} 0 0`) + hline(x, 71.2, x + w, grey(220), 0.2);
      t += text(x + 4, 69.1, title, { size:8, bold:true, color:grey(60) });
      cells.forEach(([head, lines, tone, flag], i) => {
        const cx = x + i * w / 2;
        if (tone) t += rect(cx, 71.3, w / 2 - 0.3, 24.4, `background:${tone[0]};border-radius:0 0 ${mm(2.7)} 0`);
        if (i) t += vline(cx, 71.3, 95.7, grey(220), 0.2);
        t += text(cx + 3, 76.6, head, { size:10, bold:true, color:tone ? tone[1] : grey(50) });
        lines.forEach((line, l) => { t += text(cx + 3, 81.6 + l * 3.6, line, { size:8, color:grey(60) }); });
        if (flag) t += text(cx + 3, 93.2, flag, { size:6.5, bold:true, color:tone[1] });
      });
      return t;
    };
    out += table(MARGIN, W(77), 'NFVA Requirement', [['1/300', ['NFVA: 2129 sq in', 'Exhaust: 1064 sq in', 'Intake: 1064 sq in']], ['1/150', ['NFVA: 4258 sq in', 'Exhaust: 2129 sq in', 'Intake: 2129 sq in'], ['rgb(235,245,255)', blue], 'Recommended']]);
    out += table(X(107), W(93.9), 'Exhaust Options', [['Ridge Vent', ["Needed: 118' (@ 18\"/lf)", "Available: 98'", 'Deficit: 360 sq in']], ['Box Vents', ['Needed: 43 vents', '50 sq in NFA each', 'Total: 2150 sq in'], ['rgb(240,252,243)', green], 'Recommended']]);
    out += card(MARGIN, 101, AVAIL_W, 40, { strip:true, title:'Recommended Intake Products' });
    out += rect(31, 112.8, W(167.9), 6.1, `background:${grey(245)}`);
    [['Product', 33], ['Rating', 98], ['Qty Needed', 143]].forEach(([label, x]) => { out += text(X(x), 116.9, label, { size:8.5, bold:true, color:grey(50) }); });
    [['Vented Drip Edge', '9 sq in/ft', '237 ft', 125.2], ['Soffit Vent', '9 sq in/ft', '237 ft', 130.6], ['Bird Blocks', '~3.5 sq in', '609 ea', 136.1]].forEach(([product, rating, qty, y]) => {
      out += text(33, y, product, { color:grey(60) }) + text(X(98), y, rating, { color:grey(60) }) + text(X(143), y, qty, { bold:true });
    });
    const mapY = LANDSCAPE ? 146 : 153.4, mapH = LANDSCAPE ? PAGE_H - 24.1 - 16 - mapY : 69.4, mapW = mapH * 110 / 69.4, keyY = LANDSCAPE ? mapY + 4 : 175.6;
    out += text(37.3, keyY, 'Key', { size:9, bold:true });
    out += rect(37.3, keyY + 6.4, 9.9, 1.4, 'background:rgb(230,0,0)') + text(50.3, keyY + 8.2, 'Ridge Vent', { size:7, color:grey(60) });
    out += rect(37.3, keyY + 12.6, 4.9, 4.9, 'background:rgb(255,152,0)') + text(50.3, keyY + 16, 'Box Vent', { size:7, color:grey(60) });
    out += card(X(79.6) + (W(110) - mapW) / 2, mapY, mapW, mapH, { radius:2 }) + image('ventilation', X(79.6) + (W(110) - mapW) / 2 + 1, mapY + 1, mapW - 2, mapH - 2, `border-radius:${mm(1.4)}`);
    out += `<div class="rpv-p" style="left:${mm(MARGIN)};bottom:${mm(24.1)};width:${mm(AVAIL_W)};font-size:${n(ptPx(6))}px;line-height:${n(3.24 * MM)}px;color:${grey(90)}">${esc('Note: The estimated quantity of attic ventilation products in this report is based on the estimated attic floor area and is meant for estimating purposes only. It is the responsibility of the installer to verify the correct quantity and type of attic ventilation products prior to commencement of work. Installer must always review job-specific attic ventilation needs such as local code requirements, attic floor square footage, roof design, and conditioned spaces under the roof. GAF recommends a minimum of 1 square foot of attic ventilation (evenly split between intake and exhaust) for every 150\u2013300 square feet of attic floor space depending on vapor barrier status. The amount of exhaust ventilation at or near the ridge must never exceed the amount of intake ventilation at or near the soffit. See gaf.com/ventcalculator for details.')}</div>`;
    return out;
  }

  // Pitch and area diagram pages with drawPitchTable underneath.
  // Landscape: the diagram fills the left and the breakdown sits centred in the side panel.
  const DIAGRAM_BOTTOM = () => PAGE_H - 25;
  function breakdownTable(title, boldDominant){
    const x = LANDSCAPE ? SIDE_X : MARGIN, w = LANDSCAPE ? SIDE_W : AVAIL_W, y = LANDSCAPE ? 35 + (DIAGRAM_BOTTOM() - 35 - 55) / 2 : 200, total = SAMPLE.pitches.reduce((sum, [, v]) => sum + v, 0);
    let out = card(x, y, w, 55, { strip:true, title });
    out += text(x + 18, y + 15, 'Pitch', { bold:true, align:'center' }) + text(x + w / 2, y + 15, 'Area', { bold:true, align:'center' }) + text(x + w - 18, y + 15, 'Percent', { bold:true, align:'center' });
    out += hline(x + 8, y + 17, x + w - 8, grey(220), 0.2);
    let cy = y + 23;
    [...SAMPLE.pitches].sort((a, b) => b[1] - a[1]).slice(0, 6).forEach(([p, v]) => {
      const bold = boldDominant && p === SAMPLE.pitch;
      out += text(x + 18, cy, p, { bold, align:'center' }) + text(x + w / 2, cy, v.toFixed(2), { bold, align:'center' }) + text(x + w - 18, cy, `${Math.round(v / total * 100)}%`, { bold, align:'right' });
      cy += 5;
    });
    return out;
  }
  const diagram = (name) => LANDSCAPE ? fitImage(name, MARGIN, 35, MAIN_W, DIAGRAM_BOTTOM() - 35) : image(name, MARGIN, 35, AVAIL_W, 160);
  const pitchPage = () => text(MARGIN, 30, `Total Facets: ${SAMPLE.facets}`, { bold:true }) + diagram('pitch') + breakdownTable('Pitch Breakdown', true);
  const areaPage = () => diagram('area') + breakdownTable('Area Breakdown', false);

  // Landscape: the layer drawing on the left; the details box (totals one per line, then the line
  // lengths) and the legend below it in the side panel.
  function layerPageLandscape(){
    let out = fitImage('layer', MARGIN, 35, MAIN_W, DIAGRAM_BOTTOM() - 35);
    out += card(SIDE_X, 35, SIDE_W, 80, { strip:true, title:'Layer 1 Details' });
    out += text(SIDE_X + 8, 51, `Facets: ${SAMPLE.facets}`, { bold:true }) + text(SIDE_X + 8, 57, 'Squares Without Waste: 48.5', { bold:true }) + text(SIDE_X + 8, 63, 'Squares With Waste: 55.3', { bold:true });
    out += hline(SIDE_X + 8, 67, SIDE_X + SIDE_W - 8, grey(220), 0.2);
    let x = SIDE_X + 8, y = 71;
    SAMPLE.layerItems.forEach(([label]) => { const w = label.length * 1.75; if (x + w > SIDE_X + SIDE_W - 8 && x > SIDE_X + 8) { x = SIDE_X + 8; y += 8; } out += text(x, y, label); x += w + 8; });
    x = SIDE_X; y = 125;
    SAMPLE.layerLegend.forEach(([label, colour]) => { const w = 4 + 2 + label.length * 1.75; if (x + w > SIDE_X + SIDE_W && x > SIDE_X) { x = SIDE_X; y += 10; } out += rect(x, y - 3.4, 4, 4, `background:${colour}`) + text(x + 6.5, y, label, { size:9, color:grey(50) }); x += w + 15; });
    return out;
  }
  function layerPage(){
    if (LANDSCAPE) return layerPageLandscape();
    let out = image('layer', MARGIN, 45, AVAIL_W, 136);
    SAMPLE.layerLegend.forEach(([label, colour, x, y]) => { out += rect(x, y - 3.4, 4, 4, `background:${colour}`) + text(x + 6.5, y, label, { size:9, color:grey(50) }); });
    out += card(MARGIN, PAGE_H - 75, AVAIL_W, 50, { strip:true, title:'Layer 1 Details' });
    out += text(33, 219.4, `Facets: ${SAMPLE.facets}`, { bold:true }) + text(67, 219.4, 'Squares Without Waste: 48.5', { bold:true }) + text(123, 219.4, 'Squares With Waste: 55.3', { bold:true });
    out += hline(33, 224.3, 192.9, grey(220), 0.2);
    SAMPLE.layerItems.forEach(([label, x, y]) => { out += text(x, y, label); });
    return out;
  }

  // drawGutterPage, laid out from the gutter sample page.
  function guttersPage(){
    const primary = 'var(--rpv-primary)';
    const metric = (x, w, title, value) => card(x, 35, w, 28, { strip:true }) + text(x + w / 2 + 1, 43, title.toUpperCase(), { size:9, bold:true, color:grey(150), align:'center' })
      + `<span class="rpv-t" style="left:${mm(x + w / 2 + 1)};top:${n(55.6 * MM - ptPx(16) * 0.8585)}px;font-size:${n(ptPx(16))}px;font-weight:700;color:${primary};transform:translateX(-50%)">${esc(value)}</span>`;
    // drawGutterPage follows the page width and height: landscape stretches x (X/W) and moves the
    // stories card up by dy, shortening the diagram card between them.
    const X = wideX, W = wideW, dy = PAGE_H - 279.4;
    let out = metric(25, W(37.9), 'Active Gutter', '255 ft') + metric(X(68), W(38), 'Downspouts', '10');
    out += card(X(111.4), 35, W(89.5), 28, { strip:true, title:'Miter Counts' });
    [['Outside 90', '9', '#2e7d32', 119.2], ['Inside 90', '5', '#d93025', 149], ['Non-90', '3', '#f9ab00', 179]].forEach(([label, value, colour, px], i) => {
      const x = X(px);
      if (i) out += vline(x - 8, 44, 59.6, grey(225), 0.2);
      out += rect(x - 1.7, 47.2, 3.4, 3.4, `background:${colour};border-radius:50%`) + text(x + 4, 50, label, { size:7.5, color:grey(90) });
      out += `<span class="rpv-t" style="left:${mm(x - 1.7)};top:${n(58.4 * MM - ptPx(16) * 0.8585)}px;font-size:${n(ptPx(16))}px;font-weight:700;color:${colour}">${value}</span>`;
    });
    out += card(25, 68, W(175.6), 153.2 + dy, { strip:true, title:'Gutter Diagram' });
    out += rect(32.9, 78.5, 8, 0.8, 'background:#1e6fd9') + text(43.9, 80.1, 'Run', { size:7, color:grey(90) });
    [['Out 90', '#2e7d32', 59.1], ['In 90', '#d93025', 82], ['Non-90', '#f9ab00', 102.9]].forEach(([label, colour, x]) => {
      out += rect(x - 1.6, 77.3, 3.2, 3.2, `background:${colour};border-radius:50%`) + text(x + 4.5, 80.1, label, { size:7, color:grey(90) });
    });
    out += LANDSCAPE ? fitImage('gutters', 27, 81, W(172), 134 + dy) : image('gutters', 27, 81, 172, 134);
    out += card(25, 226.3 + dy, W(175.6), 27.7, { strip:true, title:'Stories By Direction' });
    [['North', 46.8], ['South', 90.9], ['East', 134.8], ['West', 178.7]].forEach(([label, px], i) => {
      const x = X(px);
      if (i) out += vline(x - W(21.9), 234.3 + dy, 249.2 + dy, grey(225), 0.2);
      out += text(x, 241 + dy, label, { size:8.5, bold:true, color:grey(60), align:'center' });
      out += `<span class="rpv-t" style="left:${mm(x)};top:${n((248.8 + dy) * MM - ptPx(16) * 0.8585)}px;font-size:${n(ptPx(16))}px;font-weight:700;color:${primary};transform:translateX(-50%)">2</span>`;
    });
    return out;
  }

  // drawNotesPage: diagram card (60%), then the ruled notes card (the page height sets availH).
  function notesPage(){
    const x = MARGIN, w = AVAIL_W, availH = LANDSCAPE ? PAGE_H - 50 : 231, diagH = Math.round(availH * 0.6), notesY = 35 + diagH + 5, notesH = availH - diagH - 5;
    let out = card(x, 35, w, diagH) + (LANDSCAPE ? fitImage('notes', x + 1.5, 36.5, w - 3, diagH - 3) : image('notes', 26.5, 36.5, 172.9, 125));
    out += `<div class="rpv-pill" style="right:${mm(PAGE_W - (x + w - 3))};top:${mm(35 + diagH - 3 - 7)};height:${mm(7)};padding:0 ${mm(5)};border-radius:${mm(3)};font-size:${n(ptPx(7.5))}px">${esc(`${SAMPLE.wasteSquares} sq  \u00B7  ${SAMPLE.pitch}  \u00B7  ${SAMPLE.facets} facets`)}</div>`;
    out += card(x, notesY, w, notesH, { strip:true, title:'Notes' });
    out += hline(x + 8, notesY + 12, x + w - 8, grey(235), 0.2);
    for (let ry = notesY + 22; ry <= notesY + notesH - 5; ry += 8) out += hline(x + 8, ry, x + w - 8, 'rgb(220,228,240)', 0.2);
    return out;
  }

  // ---- Documents ----
  const ALL_PAGES = {
    cover_show_customer:true, cover_show_squares:true, cover_show_waste:true, cover_show_breakdown:true, cover_show_pitch:true, cover_show_facets:true,
    page_top_view:true, page_3d:true, page_pitch:true, page_area:true, page_layers:true, page_summary:true, page_materials:true, page_ventilation:true, page_gutters:true, page_notes:true
  };
  // The page sequence and titles generatePDFFromState gives a roof-only report (Full House reports use the
  // roof-prefixed layout). The sample has a flat section and gutters ordered, so every setting shows its page.
  // It has no elevation imagery, so the 3D views page is the "3D Facets" page.
  function documentPages(mode, settings){
    const s = mode === 'internal' ? ALL_PAGES : { ...ALL_PAGES, ...settings };
    const pages = [{ key:'cover', label:'Cover', cover:true, draw:() => mode === 'internal' ? coverInternal() : coverCustomer(s) }];
    const add = (flag, key, label, title, draw) => { if (s[flag] !== false) pages.push({ key, label, title, draw }); };
    add('page_top_view', 'imagery', 'Imagery', 'Top View', imageryPage);
    add('page_3d', 'facets', 'Facets', '3D Facets', facetsPage);
    add('page_pitch', 'pitch', 'Pitch', 'Pitch Diagram', pitchPage);
    add('page_area', 'area', 'Area', 'Area Diagram', areaPage);
    add('page_layers', 'layer', 'Layer 1', 'Layer 1 Measurements', layerPage);
    add('page_summary', 'summary', 'Summary', 'Project Summary', summaryPage);
    add('page_materials', 'steep-1', 'Materials', 'Steep-Slope Materials', steepPage1);
    add('page_materials', 'steep-2', 'Materials', 'Steep-Slope Materials', steepPage2);
    // A landscape flat table that reaches the footer continues on another page, as the PDF does.
    if (s.page_materials !== false) flatPages().forEach((html, i) => pages.push({ key:i ? `flat-${i + 1}` : 'flat', label:'Flat Roof', title:'Flat Roof Materials', draw:() => html }));
    add('page_ventilation', 'ventilation', 'Ventilation', 'Ventilation', ventilationPage);
    if (mode === 'internal' || s.page_gutters) pages.push({ key:'gutters', label:'Gutters', title:'Gutters', draw:guttersPage });
    add('page_notes', 'notes', 'Notes', 'Notes', notesPage);
    return pages;
  }
  function pageHtml(ctx, page, number){
    return `<div class="rpv-page${ctx.unbranded ? ' rpv-unbranded' : ''}" data-page="${number - 1}">${frame(ctx, page, number)}${page.draw()}</div>`;
  }

  // ---- Viewer ----
  const CSS = `
    @font-face{font-family:'FM Report Montserrat';src:url('/fonts/Montserrat-Regular.ttf') format('truetype');font-weight:400;font-display:swap}
    @font-face{font-family:'FM Report Montserrat';src:url('/fonts/Montserrat-Bold.ttf') format('truetype');font-weight:700;font-display:swap}
    .rpv{--rpv-pw:${215.9 * MM}px;--rpv-ph:${279.4 * MM}px;--rpv-thumb-s:${(56 / (215.9 * MM)).toFixed(5)};--rpv-primary:var(--primary,#c82828);--rpv-secondary:var(--secondary,#960000);display:flex;flex-direction:column;min-height:0;height:100%;border:1px solid rgba(15,23,42,.10);border-radius:12px;background:#eef1f5;overflow:hidden}
    .rpv-bar{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#fff;border-bottom:1px solid rgba(15,23,42,.08)}
    .rpv-tabs{display:inline-flex;gap:2px;padding:2px;border-radius:9px;background:#f2f4f7}
    .rpv-tab{appearance:none;border:0;border-radius:7px;background:transparent;padding:6px 11px;font:inherit;font-size:12px;font-weight:850;color:#667085;cursor:pointer}
    .rpv-tab[aria-selected=true]{background:#fff;color:#101828;box-shadow:0 1px 3px rgba(15,23,42,.12)}
    .rpv-nav{margin-left:auto;display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:850;color:#667085;white-space:nowrap}
    .rpv-nav button{appearance:none;width:26px;height:26px;border:1px solid rgba(15,23,42,.12);border-radius:7px;background:#fff;color:#344054;cursor:pointer;display:grid;place-items:center}
    .rpv-nav button:disabled{opacity:.4;cursor:default}
    .rpv-body{flex:1 1 auto;min-height:0;display:flex}
    .rpv-viewer{position:relative;flex:1 1 auto;min-width:0;min-height:0;overflow:auto;padding:12px 16px var(--rpv-pad,16px);display:grid;gap:18px;justify-items:center;align-content:start;scroll-behavior:smooth}
    .rpv-sheet{position:relative;width:calc(var(--rpv-pw) * var(--rpv-s,0.5));height:calc(var(--rpv-ph) * var(--rpv-s,0.5));box-shadow:0 6px 18px rgba(15,23,42,.14);background:#fff;flex:none}
    .rpv-page{position:absolute;left:0;top:0;width:var(--rpv-pw);height:var(--rpv-ph);transform-origin:0 0;transform:scale(var(--rpv-s,0.5));overflow:hidden;background:#fff;font-family:'FM Report Montserrat',Montserrat,sans-serif;color:#000;-webkit-font-smoothing:antialiased}
    .rpv-strip-col{position:relative;flex:none;width:96px;overflow-y:auto;display:flex;flex-direction:column;align-items:center;gap:16px;padding:16px 0;background:#fff;border-left:1px solid rgba(15,23,42,.08);scrollbar-width:thin;scrollbar-color:#d0d5dd transparent;scroll-behavior:smooth}
    .rpv-thumb{appearance:none;flex:none;display:grid;gap:7px;justify-items:center;padding:0;border:0;background:none;cursor:pointer;font:inherit}
    .rpv-thumb .rpv-sheet{--rpv-s:var(--rpv-thumb-s);outline:2px solid transparent;outline-offset:3px;border-radius:1px;box-shadow:0 1px 3px rgba(15,23,42,.16)}
    .rpv-thumb:hover .rpv-sheet{outline-color:#d0d5dd}
    .rpv-thumb[aria-current=true] .rpv-sheet{outline-color:var(--rpv-primary)}
    .rpv-thumb>span{max-width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:600;color:#98a2b3}
    .rpv-thumb[aria-current=true]>span{color:#344054;font-weight:700}
    .rpv-t{position:absolute;line-height:1;white-space:pre}
    .rpv-p{position:absolute;white-space:normal}
    .rpv-b,.rpv-i,.rpv-logo{position:absolute;display:block;box-sizing:border-box}
    .rpv-i{object-fit:fill}
    .rpv-card{background:#fff;overflow:hidden}
    .rpv-strip{position:absolute;left:0;top:0;bottom:0;background:var(--rpv-primary)}
    .rpv-logo{width:auto;object-fit:contain}
    .rpv-unbranded{--rpv-primary:rgb(200,40,40);--rpv-secondary:rgb(150,0,0)}
    .rpv-logo-default{background:var(--rpv-primary);-webkit-mask:url(/images/logo_red.png) left center/contain no-repeat;mask:url(/images/logo_red.png) left center/contain no-repeat}
    .rpv-pill{position:absolute;display:flex;align-items:center;white-space:pre;background:var(--rpv-primary);color:#fff;font-weight:700}
  `;
  function injectCss(){
    if (document.getElementById('fm-report-preview-css')) return;
    const style = document.createElement('style');
    style.id = 'fm-report-preview-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function render(host, options = {}){
    if (!host) return null;
    injectCss();
    const view = host.__fmReportPreview || (host.__fmReportPreview = { mode:'customer', index:0 });
    view.settings = options.settings || {};
    view.logo = String(options.logo || '').trim();
    view.orientation = options.orientation === 'landscape' ? 'landscape' : 'portrait';
    if (!host.querySelector('.rpv')) mount(host, view);
    draw(host, view);
    return { setMode:(mode) => { view.mode = mode === 'internal' ? 'internal' : 'customer'; draw(host, view); } };
  }

  function mount(host, view){
    host.innerHTML = `<div class="rpv">
      <div class="rpv-bar">
        <div class="rpv-tabs" role="tablist" aria-label="Report">
          <button type="button" class="rpv-tab" role="tab" data-rpv-mode="customer">Customer PDF</button>
          <button type="button" class="rpv-tab" role="tab" data-rpv-mode="internal">Internal PDF</button>
        </div>
        <div class="rpv-nav"><button type="button" data-rpv-step="-1" aria-label="Previous page"><i class="fas fa-chevron-up"></i></button><span data-rpv-count></span><button type="button" data-rpv-step="1" aria-label="Next page"><i class="fas fa-chevron-down"></i></button></div>
      </div>
      <div class="rpv-body">
        <div class="rpv-viewer" data-rpv-viewer tabindex="0" aria-label="Report pages"></div>
        <div class="rpv-strip-col" data-rpv-strip aria-label="Pages"></div>
      </div>
    </div>`;
    const viewer = host.querySelector('[data-rpv-viewer]');
    host.querySelectorAll('[data-rpv-mode]').forEach((tab) => tab.addEventListener('click', () => {
      if (view.mode === tab.dataset.rpvMode) return;
      view.mode = tab.dataset.rpvMode;
      draw(host, view);
    }));
    host.querySelectorAll('[data-rpv-step]').forEach((button) => button.addEventListener('click', () => goTo(host, view, view.index + Number(button.dataset.rpvStep))));
    host.querySelector('[data-rpv-strip]').addEventListener('click', (event) => {
      const thumb = event.target.closest('[data-rpv-thumb]');
      if (thumb) goTo(host, view, Number(thumb.dataset.rpvThumb));
    });
    viewer.addEventListener('scroll', () => {
      if (view.scrollFrame) return;
      view.scrollFrame = requestAnimationFrame(() => { view.scrollFrame = 0; trackScroll(host, view); });
    }, { passive:true });
    viewer.addEventListener('keydown', (event) => {
      if (event.key === 'PageDown' || event.key === 'ArrowRight') { event.preventDefault(); goTo(host, view, view.index + 1); }
      if (event.key === 'PageUp' || event.key === 'ArrowLeft') { event.preventDefault(); goTo(host, view, view.index - 1); }
    });
    // A page takes most of the viewer's height, so the pages above and below it show at the edges;
    // the first page starts at the top, and the bottom padding lets the last page come to the middle.
    const fit = () => {
      const width = viewer.clientWidth - 32, height = viewer.clientHeight;
      if (width <= 0 || height <= 0) return;
      const scale = Math.min(width / (PAGE_W * MM), height * 0.8 / (PAGE_H * MM));
      const root = host.querySelector('.rpv');
      root.style.setProperty('--rpv-s', scale.toFixed(5));
      root.style.setProperty('--rpv-pad', `${Math.max(16, Math.round((height - PAGE_H * MM * scale) / 2))}px`);
    };
    view.resize?.disconnect?.();
    view.resize = new ResizeObserver(fit);
    view.resize.observe(viewer);
    view.fit = fit;
    fit();
  }

  function draw(host, view){
    // The page size follows the orientation; thumbnails keep the strip's width.
    setOrientation(view.orientation);
    const root = host.querySelector('.rpv');
    root.dataset.orientation = view.orientation;
    root.style.setProperty('--rpv-pw', `${n(PAGE_W * MM)}px`);
    root.style.setProperty('--rpv-ph', `${n(PAGE_H * MM)}px`);
    root.style.setProperty('--rpv-thumb-s', ((LANDSCAPE ? 72 : 56) / (PAGE_W * MM)).toFixed(5));
    view.fit?.();
    const ctx = { logo:view.logo, unbranded:view.mode === 'internal' };
    const pages = documentPages(view.mode, view.settings);
    view.count = pages.length;
    view.index = Math.min(view.index, pages.length - 1);
    const html = pages.map((page, i) => pageHtml(ctx, page, i + 1));
    host.querySelectorAll('[data-rpv-mode]').forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.rpvMode === view.mode)));
    const viewer = host.querySelector('[data-rpv-viewer]');
    viewer.setAttribute('aria-label', `${view.mode === 'internal' ? 'Internal' : 'Customer'} PDF pages`);
    viewer.innerHTML = html.map((page, i) => `<div class="rpv-sheet" data-rpv-sheet="${i}" aria-label="Page ${i + 1}: ${esc(pages[i].label)}">${page}</div>`).join('');
    host.querySelector('[data-rpv-strip]').innerHTML = html.map((page, i) => `<button type="button" class="rpv-thumb" data-rpv-thumb="${i}" aria-label="Page ${i + 1}: ${esc(pages[i].label)}"><div class="rpv-sheet">${page}</div><span>${esc(pages[i].label)}</span></button>`).join('');
    goTo(host, view, view.index, { instant:true });
  }

  function goTo(host, view, index, options = {}){
    view.index = Math.max(0, Math.min(view.count - 1, index));
    const viewer = host.querySelector('[data-rpv-viewer]'), sheet = viewer?.querySelector(`[data-rpv-sheet="${view.index}"]`);
    if (sheet) {
      view.programmatic = Date.now();
      viewer.scrollTo({ top:view.index === 0 ? 0 : sheet.offsetTop - (viewer.clientHeight - sheet.offsetHeight) / 2, behavior:options.instant ? 'instant' : 'smooth' });
    }
    mark(host, view);
  }

  function trackScroll(host, view){
    // A smooth scroll that goTo started settles on its own page.
    if (Date.now() - (view.programmatic || 0) < 600) return;
    // The current page is the one nearest the middle of the viewer.
    const viewer = host.querySelector('[data-rpv-viewer]'), mid = viewer.scrollTop + viewer.clientHeight / 2;
    let index = 0, best = Infinity;
    viewer.querySelectorAll('[data-rpv-sheet]').forEach((sheet, i) => {
      const distance = Math.abs(sheet.offsetTop + sheet.offsetHeight / 2 - mid);
      if (distance < best) { best = distance; index = i; }
    });
    if (index !== view.index) { view.index = index; mark(host, view); }
  }

  function mark(host, view){
    const count = host.querySelector('[data-rpv-count]');
    if (count) count.textContent = `Page ${view.index + 1} of ${view.count}`;
    host.querySelectorAll('[data-rpv-step]').forEach((button) => { button.disabled = Number(button.dataset.rpvStep) < 0 ? view.index <= 0 : view.index >= view.count - 1; });
    const strip = host.querySelector('[data-rpv-strip]');
    host.querySelectorAll('[data-rpv-thumb]').forEach((thumb) => {
      const current = Number(thumb.dataset.rpvThumb) === view.index;
      thumb.setAttribute('aria-current', String(current));
      // The current page's thumbnail stays in the middle of the column, with its neighbours above and below.
      if (current && strip) strip.scrollTo({ top:thumb.offsetTop - (strip.clientHeight - thumb.offsetHeight) / 2 });
    });
  }

  window.FirstMateReportPreview = { render, documentPages };
})();
