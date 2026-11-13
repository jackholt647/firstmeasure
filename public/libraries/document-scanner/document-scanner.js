/* FirstMate document scanner (FM-432): paper into a PDF with the phone camera.
 *
 * The camera is FirstMateCamera (camera-capture.js), full screen, with the page it sees outlined live. Done opens
 * the review: each photo is cropped to the page it shows (found automatically; drag the corners to correct it),
 * straightened, cleaned up (Document, Grey, Black & white or Original), and can be rotated, reordered or removed.
 * Back returns to the camera for more pages. Save makes one PDF and hands it to `save`.
 *
 *   const result = await FirstMateDocumentScanner.open({
 *     title: 'Scan paper', subtitle: 'Project name',       // optional camera heading
 *     save: async (file, { pages, name }) => value,      // required: where the PDF goes; throw to keep the scan open
 *   });
 *   // result: what `save` returned, or null when the person discarded the scan or closed the camera with no pages
 *
 * Gated by the organization flag documents.scanner; the caller decides (documents/project.js). Everything here
 * runs on the device: nothing is uploaded until `save`.
 *
 * Pure helpers (no DOM) are exported on FirstMateDocumentScanner._internals for tests (tests/document-scanner.test.mjs).
 */
(function(root){
  'use strict';
  if (root.FirstMateDocumentScanner) return;
  const fill = (text, vars) => (vars && typeof text === 'string')
    ? text.replace(/\{(\w+)\}/g, (match, name) => Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match)
    : text;
  const T = (key, fallback, vars) => fill(globalThis.PlatformLanguage?.text?.('document-scanner', key, fallback, vars) ?? fallback, vars);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  const DETECT_SIZE = 256;   // long side the page is looked for at
  const SOURCE_MAX = 3200;   // long side a photo is read at when saving
  const PAGE_MAX = 2200;     // long side of a saved page
  const PREVIEW_MAX = 1280;  // long side of the photo shown while cropping
  const JPEG_QUALITY = 0.85;
  const FILTERS = ['document', 'grey', 'bw', 'original'];

  // ------------------------------------------------------------------ geometry
  // A quad is four {x, y} points in the order top-left, top-right, bottom-right, bottom-left.
  function polygonArea(points){
    let sum = 0;
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i], b = points[(i + 1) % points.length];
      sum += a.x * b.y - b.x * a.y;
    }
    return Math.abs(sum) / 2;
  }
  const triangleArea = (a, b, c) => Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  /** Any four points, as top-left, top-right, bottom-right, bottom-left. */
  function orderQuad(points){
    const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
    const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
    const sorted = points.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    let first = 0;
    sorted.forEach((p, i) => { if (p.x + p.y < sorted[first].x + sorted[first].y) first = i; });
    return sorted.slice(first).concat(sorted.slice(0, first)).map((p) => ({ x: p.x, y: p.y }));
  }

  /** Convex hull (monotone chain), counter-clockwise. */
  function convexHull(points){
    const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    if (pts.length < 3) return pts;
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [], upper = [];
    for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
    for (let i = pts.length - 1; i >= 0; i -= 1) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  /** The largest quadrilateral with its corners on the hull: start from the extreme corners, then move each corner
   *  along the hull while the area grows. */
  function largestQuad(hull){
    const n = hull.length;
    if (n < 4) return null;
    const pick = (score) => hull.reduce((best, p, i) => (score(p) > score(hull[best]) ? i : best), 0);
    let idx = [pick((p) => -(p.x + p.y)), pick((p) => p.x - p.y), pick((p) => p.x + p.y), pick((p) => -(p.x - p.y))];
    idx = [...new Set(idx)].sort((a, b) => a - b);
    for (let i = 0; idx.length < 4 && i < n; i += 1) if (!idx.includes(i)) idx = [...idx, i].sort((a, b) => a - b);
    for (let round = 0; round < 12; round += 1) {
      let moved = false;
      for (let k = 0; k < 4; k += 1) {
        const prev = idx[(k + 3) % 4], next = idx[(k + 1) % 4];
        let best = idx[k], bestArea = triangleArea(hull[prev], hull[best], hull[next]);
        for (let j = (prev + 1) % n; j !== next; j = (j + 1) % n) {
          const area = triangleArea(hull[prev], hull[j], hull[next]);
          if (area > bestArea + 1e-9) { best = j; bestArea = area; }
        }
        if (best !== idx[k]) { idx[k] = best; moved = true; }
      }
      if (!moved) break;
    }
    return orderQuad(idx.map((i) => hull[i]));
  }

  function cornerAngles(quad){
    return quad.map((p, i) => {
      const a = quad[(i + 3) % 4], b = quad[(i + 1) % 4];
      const v1 = { x: a.x - p.x, y: a.y - p.y }, v2 = { x: b.x - p.x, y: b.y - p.y };
      const cos = (v1.x * v2.x + v1.y * v2.y) / Math.max(1e-9, Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y));
      return Math.acos(clamp(cos, -1, 1)) * 180 / Math.PI;
    });
  }

  /** The whole picture, as a quad in 0..1 coordinates. */
  const fullQuad = () => [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

  // ------------------------------------------------------------------ finding the page
  /** Look for a sheet of paper in RGBA pixels: the largest bright, unsaturated region, as a quad in 0..1
   *  coordinates. Returns { quad, found }; when nothing page-shaped stands out, the whole picture and found: false. */
  function detectPage(data, width, height){
    const n = width * height;
    if (!n) return { quad: fullQuad(), found: false };
    // Paper is light and nearly colourless; a wooden table or a hand is darker or more saturated.
    const score = new Uint8Array(n);
    const hist = new Uint32Array(256);
    for (let i = 0, p = 0; i < n; i += 1, p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const value = clamp(Math.round(0.299 * r + 0.587 * g + 0.114 * b - 0.7 * (max - min)), 0, 255);
      score[i] = value;
      hist[value] += 1;
    }
    // Otsu's threshold between paper and the rest.
    let total = 0;
    for (let v = 0; v < 256; v += 1) total += v * hist[v];
    let below = 0, belowSum = 0, bestVariance = 0, threshold = 128, backgroundMean = 0;
    for (let v = 0; v < 256; v += 1) {
      below += hist[v];
      if (!below) continue;
      const above = n - below;
      if (!above) break;
      belowSum += v * hist[v];
      const meanBelow = belowSum / below, meanAbove = (total - belowSum) / above;
      const variance = below * above * (meanBelow - meanAbove) * (meanBelow - meanAbove);
      if (variance > bestVariance) { bestVariance = variance; threshold = v; backgroundMean = meanBelow; }
    }
    const mean = total / n;
    let spread = 0;
    for (let v = 0; v < 256; v += 1) spread += hist[v] * (v - mean) * (v - mean);
    // A picture with no contrast to speak of has no edge to find.
    if (spread / n < 120) return { quad: fullQuad(), found: false };
    // Connected bright regions (4-neighbour); keep the largest.
    const labels = new Int32Array(n);
    const stack = new Int32Array(n);
    let label = 0, bestLabel = 0, bestSize = 0;
    for (let start = 0; start < n; start += 1) {
      if (labels[start] || score[start] <= threshold) continue;
      label += 1;
      let size = 0, top = 0;
      stack[top++] = start; labels[start] = label;
      while (top) {
        const i = stack[--top];
        size += 1;
        const x = i % width;
        if (x > 0 && !labels[i - 1] && score[i - 1] > threshold) { labels[i - 1] = label; stack[top++] = i - 1; }
        if (x < width - 1 && !labels[i + 1] && score[i + 1] > threshold) { labels[i + 1] = label; stack[top++] = i + 1; }
        if (i >= width && !labels[i - width] && score[i - width] > threshold) { labels[i - width] = label; stack[top++] = i - width; }
        if (i < n - width && !labels[i + width] && score[i + width] > threshold) { labels[i + width] = label; stack[top++] = i + width; }
      }
      if (size > bestSize) { bestSize = size; bestLabel = label; }
    }
    // Too small to be the page, or everything is bright (white paper on a white desk): no edge.
    if (!bestLabel || bestSize < n * 0.1 || bestSize > n * 0.97) return { quad: fullQuad(), found: false };
    const page = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) if (labels[i] === bestLabel) page[i] = 1;
    const bright = pageQuad(page, bestSize, width, height);
    // A shadow across the paper (the phone, a hand) falls below the threshold. Follow the paper into it: from the
    // bright region, through small steps of a lightly blurred image, while still lighter than the table. The edge of
    // the sheet is a step, so the growth stops there; when it spills over the table anyway, keep the bright region.
    const soft = new Uint8Array(n);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      let sum = 0, count = 0;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height) { sum += score[ny * width + nx]; count += 1; }
      }
      soft[y * width + x] = sum / count;
    }
    const floor = backgroundMean + (threshold - backgroundMean) * 0.35;
    let top = 0, grown = bestSize;
    for (let i = 0; i < n; i += 1) if (page[i]) stack[top++] = i;
    while (top) {
      const i = stack[--top];
      const x = i % width;
      const visit = (j) => {
        if (page[j] || soft[j] < floor || Math.abs(soft[j] - soft[i]) > 4) return;
        page[j] = 1; grown += 1; stack[top++] = j;
      };
      if (x > 0) visit(i - 1);
      if (x < width - 1) visit(i + 1);
      if (i >= width) visit(i - width);
      if (i < n - width) visit(i + width);
    }
    const shaded = grown > bestSize && grown <= n * 0.95 ? pageQuad(page, grown, width, height) : null;
    const quad = shaded || bright;
    if (!quad) return { quad: fullQuad(), found: false };
    // Pull each corner a pixel and a half inside, so no sliver of the table survives along the edges.
    const cx = quad.reduce((sum, p) => sum + p.x, 0) / 4, cy = quad.reduce((sum, p) => sum + p.y, 0) / 4;
    const inset = (p) => { const d = Math.max(1, Math.hypot(cx - p.x, cy - p.y)); return { x: p.x + (cx - p.x) * 1.5 / d, y: p.y + (cy - p.y) * 1.5 / d }; };
    return { quad: quad.map(inset).map((p) => ({ x: clamp(p.x / width, 0, 1), y: clamp(p.y / height, 0, 1) })), found: true };
  }

  /** The page-shaped quad around a region (a 0/1 mask of `size` pixels), or null when it is not page-shaped. */
  function pageQuad(mask, size, width, height){
    // The hull of a region is the hull of each row's outermost pixels.
    const points = [];
    for (let y = 0; y < height; y += 1) {
      let first = -1, last = -1;
      for (let x = 0, i = y * width; x < width; x += 1, i += 1) if (mask[i]) { if (first < 0) first = x; last = x; }
      if (first >= 0) { points.push({ x: first, y }); if (last !== first) points.push({ x: last + 1, y }); points.push({ x: first, y: y + 1 }); if (last !== first) points.push({ x: last + 1, y: y + 1 }); }
    }
    const quad = largestQuad(convexHull(points));
    if (!quad) return null;
    const area = polygonArea(quad);
    // A page seen at an angle is still roughly a rectangle; anything else is not a page.
    if (area < width * height * 0.12 || size < area * 0.6 || cornerAngles(quad).some((a) => a < 45 || a > 135)) return null;
    return quad;
  }

  // ------------------------------------------------------------------ straightening
  /** The perspective transform taking the rectangle 0..w × 0..h onto `quad` (pixels). */
  function homography(w, h, quad){
    const from = [[0, 0], [w, 0], [w, h], [0, h]];
    const rows = [], rhs = [];
    for (let i = 0; i < 4; i += 1) {
      const [x, y] = from[i], { x: u, y: v } = quad[i];
      rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); rhs.push(u);
      rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]); rhs.push(v);
    }
    // Gaussian elimination with partial pivoting.
    for (let c = 0; c < 8; c += 1) {
      let pivot = c;
      for (let r = c + 1; r < 8; r += 1) if (Math.abs(rows[r][c]) > Math.abs(rows[pivot][c])) pivot = r;
      [rows[c], rows[pivot]] = [rows[pivot], rows[c]]; [rhs[c], rhs[pivot]] = [rhs[pivot], rhs[c]];
      const div = rows[c][c] || 1e-12;
      for (let r = 0; r < 8; r += 1) {
        if (r === c) continue;
        const factor = rows[r][c] / div;
        if (!factor) continue;
        for (let k = c; k < 8; k += 1) rows[r][k] -= factor * rows[c][k];
        rhs[r] -= factor * rhs[c];
      }
    }
    const m = rhs.map((value, i) => value / (rows[i][i] || 1e-12));
    return [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], 1];
  }

  /** Output size for a quad (pixels): the longer of each pair of opposite sides, no larger than `max`. */
  function pageSize(quad, max){
    const w = Math.max(distance(quad[0], quad[1]), distance(quad[3], quad[2]));
    const h = Math.max(distance(quad[0], quad[3]), distance(quad[1], quad[2]));
    const scale = Math.min(1, max / Math.max(1, w, h));
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
  }

  /** Straighten the quad (pixels in `src`) into a width × height RGBA image. */
  function warp(src, quad, width, height){
    const { width: sw, height: sh, data: sd } = src;
    const H = homography(width, height, quad);
    const out = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      const py = y + 0.5;
      for (let x = 0; x < width; x += 1) {
        const px = x + 0.5;
        const den = H[6] * px + H[7] * py + 1;
        const u = clamp((H[0] * px + H[1] * py + H[2]) / den - 0.5, 0, sw - 1);
        const v = clamp((H[3] * px + H[4] * py + H[5]) / den - 0.5, 0, sh - 1);
        const x0 = u | 0, y0 = v | 0, x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
        const fx = u - x0, fy = v - y0;
        const a = (y0 * sw + x0) * 4, b = (y0 * sw + x1) * 4, c = (y1 * sw + x0) * 4, d = (y1 * sw + x1) * 4;
        const o = (y * width + x) * 4;
        for (let k = 0; k < 3; k += 1) {
          const top = sd[a + k] + (sd[b + k] - sd[a + k]) * fx;
          const bottom = sd[c + k] + (sd[d + k] - sd[c + k]) * fx;
          out[o + k] = top + (bottom - top) * fy;
        }
        out[o + 3] = 255;
      }
    }
    return { width, height, data: out };
  }

  // ------------------------------------------------------------------ cleaning up
  /** Even out the light (shadows, a dim corner) so the paper reads white, then apply the filter, in place.
   *  'document' keeps colour, 'grey' and 'bw' drop it, 'original' leaves the pixels alone. */
  function enhance(image, filter){
    if (filter === 'original') return image;
    const { width: w, height: h, data: d } = image;
    // The paper's brightness, estimated per block from its lightest pixels, then spread over dark content
    // (text, a logo) and smoothed so the correction has no seams.
    const block = Math.max(12, Math.round(Math.max(w, h) / 36));
    const gw = Math.ceil(w / block), gh = Math.ceil(h / block);
    let bg = new Float32Array(gw * gh);
    const bins = new Uint32Array(32);
    for (let by = 0; by < gh; by += 1) for (let bx = 0; bx < gw; bx += 1) {
      bins.fill(0);
      let count = 0;
      const x1 = Math.min(w, (bx + 1) * block), y1 = Math.min(h, (by + 1) * block);
      for (let y = by * block; y < y1; y += 2) for (let x = bx * block; x < x1; x += 2) {
        const p = (y * w + x) * 4;
        bins[(0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) >> 3] += 1; count += 1;
      }
      let seen = 0, value = 255;
      for (let bin = 31; bin >= 0; bin -= 1) { seen += bins[bin]; if (seen >= count * 0.1) { value = bin * 8 + 4; break; } }
      bg[by * gw + bx] = value;
    }
    const pass = (reduce) => {
      const next = new Float32Array(bg.length);
      for (let y = 0; y < gh; y += 1) for (let x = 0; x < gw; x += 1) {
        const around = [];
        for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < gw && ny < gh) around.push(bg[ny * gw + nx]);
        }
        next[y * gw + x] = reduce(around);
      }
      bg = next;
    };
    pass((v) => Math.max(...v)); pass((v) => Math.max(...v));
    pass((v) => v.reduce((s, x) => s + x, 0) / v.length); pass((v) => v.reduce((s, x) => s + x, 0) / v.length);
    const level = (v, black, white) => clamp((v - black) * 255 / (white - black), 0, 255);
    const rowBg = new Float32Array(w);
    for (let y = 0; y < h; y += 1) {
      const gy = clamp((y + 0.5) / block - 0.5, 0, gh - 1), y0 = gy | 0, y1 = Math.min(y0 + 1, gh - 1), fy = gy - y0;
      for (let x = 0; x < w; x += 1) {
        const gx = clamp((x + 0.5) / block - 0.5, 0, gw - 1), x0 = gx | 0, x1 = Math.min(x0 + 1, gw - 1), fx = gx - x0;
        const top = bg[y0 * gw + x0] + (bg[y0 * gw + x1] - bg[y0 * gw + x0]) * fx;
        const bottom = bg[y1 * gw + x0] + (bg[y1 * gw + x1] - bg[y1 * gw + x0]) * fx;
        rowBg[x] = top + (bottom - top) * fy;
      }
      for (let x = 0; x < w; x += 1) {
        const p = (y * w + x) * 4;
        const gain = clamp(248 / Math.max(48, rowBg[x]), 1, 4);
        if (filter === 'document') {
          for (let k = 0; k < 3; k += 1) d[p + k] = level(d[p + k] * gain, 28, 240);
        } else {
          const v = (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) * gain;
          // Black & white: a steep curve that keeps strokes solid and the paper clean, without hard jaggies.
          const out = filter === 'bw' ? level(v, 150, 205) : level(v, 30, 238);
          d[p] = d[p + 1] = d[p + 2] = out;
        }
      }
    }
    return image;
  }

  // ------------------------------------------------------------------ PDF
  /** One PDF with a page per JPEG ({ bytes: Uint8Array, width, height }), each page sized to 8.5 in across its
   *  shorter side so a letter sheet prints at its own size. */
  function buildPdf(pages){
    const encoder = new TextEncoder();
    const chunks = [];
    let length = 0;
    const offsets = [];
    const push = (part) => { const bytes = typeof part === 'string' ? encoder.encode(part) : part; chunks.push(bytes); length += bytes.length; };
    const object = (id, body, stream) => {
      offsets[id] = length;
      push(`${id} 0 obj\n${body}\n`);
      if (stream) { push('stream\n'); push(stream); push('\nendstream\n'); }
      push('endobj\n');
    };
    push('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
    const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
    object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    object(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
    pages.forEach((page, i) => {
      const id = 3 + i * 3;
      const scale = 612 / Math.max(1, Math.min(page.width, page.height));
      const w = Math.round(page.width * scale * 100) / 100, h = Math.round(page.height * scale * 100) / 100;
      const content = encoder.encode(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`);
      object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);
      object(id + 1, `<< /Length ${content.length} >>`, content);
      object(id + 2, `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>`, page.bytes);
    });
    const count = 3 + pages.length * 3;
    const xref = length;
    let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let id = 1; id < count; id += 1) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    push(table);
    push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
    return out;
  }

  // ------------------------------------------------------------------ images in the browser
  async function decode(file, max){
    let image = null, close = () => {};
    try {
      image = await createImageBitmap(file, { imageOrientation: 'from-image' });
      close = () => image.close?.();
    } catch (_) {
      const url = URL.createObjectURL(file);
      try {
        image = await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = url; });
      } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
    }
    const iw = image.width || image.naturalWidth, ih = image.height || image.naturalHeight;
    const scale = Math.min(1, max / Math.max(1, iw, ih));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(iw * scale)); canvas.height = Math.max(1, Math.round(ih * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    close();
    return canvas;
  }
  function pixels(source, max){
    const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
    const scale = Math.min(1, max / Math.max(1, sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * scale)); canvas.height = Math.max(1, Math.round(sh * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }
  /** Crop, straighten, clean and rotate one page from a canvas; returns a canvas. */
  function renderPage(sourceCanvas, page, max){
    const src = sourceCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
    const quad = page.quad.map((p) => ({ x: p.x * src.width, y: p.y * src.height }));
    const size = pageSize(quad, max);
    const straight = enhance(warp(src, quad, size.width, size.height), page.filter);
    const flat = document.createElement('canvas');
    flat.width = size.width; flat.height = size.height;
    flat.getContext('2d').putImageData(new ImageData(straight.data, size.width, size.height), 0, 0);
    const turns = ((page.rotation / 90) % 4 + 4) % 4;
    if (!turns) return flat;
    const out = document.createElement('canvas');
    out.width = turns % 2 ? size.height : size.width; out.height = turns % 2 ? size.width : size.height;
    const ctx = out.getContext('2d');
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(turns * Math.PI / 2);
    ctx.drawImage(flat, -size.width / 2, -size.height / 2);
    return out;
  }
  const toBlob = (canvas, type, quality) => new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode'))), type, quality));

  // ------------------------------------------------------------------ styles
  function styles(){
    if (document.getElementById('fm-document-scanner-style')) return;
    const style = document.createElement('style');
    style.id = 'fm-document-scanner-style';
    style.textContent = `
.fmds-guide{position:absolute;inset:0;z-index:2;width:100%;height:100%;pointer-events:none}
.fmds-guide polygon{fill:rgba(var(--primary-rgb,217,48,37),.16);stroke:var(--primary,#d93025);stroke-width:3;stroke-linejoin:round;transition:opacity .2s ease}
.fmds-guide.lost polygon{opacity:0}
.fmds-hint{position:absolute;left:50%;top:12px;z-index:3;transform:translateX(-50%);padding:6px 12px;border-radius:999px;background:rgba(16,24,40,.7);color:#fff;font-size:12px;font-weight:600;white-space:nowrap;pointer-events:none}
.fmds-hint:empty{display:none}
.fmds{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;color:#101828;font-size:14px}
.fmds *{box-sizing:border-box}
.fmds-scroll{flex:1;min-height:0;overflow:auto;padding:14px 12px}
.fmds-pages{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:12px}
.fmds-page,.fmds-add{position:relative;display:flex;align-items:center;justify-content:center;aspect-ratio:3/4;padding:8px;border:1px solid #e4e7ec;border-radius:14px;background:#fff;color:#344054;font:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}
.fmds-page img{max-width:100%;max-height:100%;box-shadow:0 1px 4px rgba(16,24,40,.18);background:#fff}
.fmds-page .fmds-num{position:absolute;left:8px;bottom:8px;min-width:22px;height:22px;padding:0 6px;border-radius:999px;background:rgba(16,24,40,.78);color:#fff;font-size:12px;font-weight:700;display:grid;place-items:center}
.fmds-page .fmds-edit-mark{position:absolute;right:8px;bottom:8px;width:28px;height:28px;border-radius:50%;background:#fff;color:#344054;display:grid;place-items:center;box-shadow:0 1px 4px rgba(16,24,40,.2);font-size:12px}
.fmds-page .fmds-loose{position:absolute;right:8px;top:8px;width:24px;height:24px;border-radius:50%;background:#fdb022;color:#101828;display:grid;place-items:center;font-size:11px}
.fmds-page.busy img{opacity:.35}
.fmds-add{flex-direction:column;gap:8px;border-style:dashed;background:transparent;color:#475467;font-weight:600}
.fmds-add i{font-size:22px}
.fmds-foot{flex:none;display:flex;flex-direction:column;gap:10px;padding:12px 12px calc(env(safe-area-inset-bottom,0px) + 12px);background:#fff;border-top:1px solid #e4e7ec}
.fmds-filters{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none}
.fmds-filters::-webkit-scrollbar{display:none}
.fmds-chip{flex:none;height:34px;padding:0 14px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#344054;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.fmds-chip[aria-checked=true]{background:#101828;border-color:#101828;color:#fff}
.fmds-name{display:flex;align-items:center;gap:8px}
.fmds-name span{flex:none;font-size:12px;font-weight:600;color:#475467}
.fmds-name input{flex:1;min-width:0;height:40px;padding:0 12px;border:1px solid #d0d5dd;border-radius:10px;font:inherit;font-size:16px;color:#101828;background:#fff}
.fmds-actions{display:flex;gap:8px}
.fmds-btn{height:44px;padding:0 16px;border:1px solid #d0d5dd;border-radius:12px;background:#fff;color:#344054;font:inherit;font-size:14px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;gap:8px;cursor:pointer}
.fmds-btn.primary{flex:1;border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:var(--fmdx-on-primary,#fff)}
.fmds-btn:disabled{opacity:.5;cursor:default}
.fmds-error{margin:0;color:#b42318;font-size:13px}
.fmds-error:empty{display:none}
.fmds-crop{flex:1;min-height:0;position:relative;display:flex;align-items:center;justify-content:center;padding:22px;background:#101828;touch-action:none;user-select:none;-webkit-user-select:none}
.fmds-crop-box{position:relative;flex:none}
.fmds-crop-box canvas{display:block;width:100%;height:100%}
.fmds-crop-box svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
.fmds-crop-box path{fill:rgba(16,24,40,.55);fill-rule:evenodd}
.fmds-crop-box polygon{fill:none;stroke:var(--primary,#d93025);stroke-width:2.5;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.fmds-handle{position:absolute;width:44px;height:44px;margin:-22px 0 0 -22px;border:0;border-radius:50%;background:transparent;touch-action:none;cursor:grab;padding:0}
.fmds-handle::after{content:"";position:absolute;inset:11px;border-radius:50%;background:#fff;border:3px solid var(--primary,#d93025);box-shadow:0 1px 6px rgba(0,0,0,.4)}
.fmds-handle:focus-visible::after{outline:3px solid #fff;outline-offset:2px}
.fmds-tools{flex:none;display:flex;gap:6px;overflow-x:auto;padding:10px 12px 0;scrollbar-width:none}
.fmds-tools::-webkit-scrollbar{display:none}
.fmds-tool{flex:none;min-width:64px;height:56px;padding:0 10px;border:0;border-radius:12px;background:#f2f4f7;color:#344054;font:inherit;font-size:11px;font-weight:600;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;cursor:pointer}
.fmds-tool i{font-size:16px}
.fmds-tool:disabled{opacity:.4;cursor:default}
.fmds-tool.danger{color:#b42318}
.fmds-progress{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:rgba(255,255,255,.88);font-weight:600;color:#344054}
.fmds-progress i{width:28px;height:28px;border:3px solid #d0d5dd;border-top-color:var(--primary,#d93025);border-radius:50%;animation:fmdsSpin .8s linear infinite}
@keyframes fmdsSpin{to{transform:rotate(360deg)}}
@media(min-width:761px){.fmds-scroll{padding:20px}.fmds-foot{flex-direction:row;align-items:center;flex-wrap:wrap}.fmds-name{flex:1}.fmds-actions{flex:none}}
@media(prefers-reduced-motion:reduce){.fmds-progress i{animation-duration:2s}}
`;
    document.head.append(style);
  }

  // ------------------------------------------------------------------ the live outline in the camera
  function liveGuide({ stage, video }){
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'fmds-guide lost');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = '<polygon points=""></polygon>';
    const hint = document.createElement('div');
    hint.className = 'fmds-hint';
    hint.setAttribute('aria-live', 'polite');
    stage.append(svg, hint);
    const polygon = svg.querySelector('polygon');
    let found = false;
    const tick = () => {
      if (!stage.classList.contains('live') || !video.videoWidth || document.hidden) { svg.classList.add('lost'); hint.textContent = ''; return; }
      let result;
      try { const img = pixels(video, 200); result = detectPage(img.data, img.width, img.height); } catch (_) { return; }
      // The preview fills the stage (object-fit: cover): map the frame's coordinates onto it.
      const sw = stage.clientWidth, sh = stage.clientHeight, vw = video.videoWidth, vh = video.videoHeight;
      const scale = Math.max(sw / vw, sh / vh), ox = (sw - vw * scale) / 2, oy = (sh - vh * scale) / 2;
      svg.setAttribute('viewBox', `0 0 ${sw} ${sh}`);
      polygon.setAttribute('points', result.quad.map((p) => `${(ox + p.x * vw * scale).toFixed(1)},${(oy + p.y * vh * scale).toFixed(1)}`).join(' '));
      svg.classList.toggle('lost', !result.found);
      if (result.found !== found || !hint.textContent) {
        found = result.found;
        hint.textContent = found ? T('page_found', 'Page found. Take the photo') : T('aim_at_page', 'Hold the camera over the page');
      }
    };
    const timer = setInterval(tick, 300);
    return () => { clearInterval(timer); svg.remove(); hint.remove(); };
  }

  // ------------------------------------------------------------------ the review
  const FILTER_LABELS = () => ({
    document: T('filter_document', 'Document'),
    grey: T('filter_grey', 'Gray'),
    bw: T('filter_bw', 'Black & white'),
    original: T('filter_original', 'Original')
  });

  // The crop shows the photo as taken; the button says how far the saved page is turned.
  const rotateLabel = (page) => (page.rotation ? T('rotated', 'Rotate · {degrees}°', { degrees: page.rotation }) : T('rotate', 'Rotate'));

  function defaultName(){
    const now = new Date();
    let stamp;
    try { stamp = now.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }); }
    catch (_) { stamp = now.toISOString().slice(0, 16).replace('T', ' '); }
    return T('default_name', 'Scan {date}', { date: stamp });
  }
  const safeFileName = (name) => (String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Scan') + '.pdf';

  function open(options = {}){
    if (typeof options.save !== 'function') throw new Error('FirstMateDocumentScanner.open needs save(file).');
    const Camera = root.FirstMateCamera;
    if (!Camera?.open) return Promise.reject(new Error('The camera is not available.'));
    styles();
    // Review state that outlives a trip back to the camera: entry id -> page.
    const pages = new Map();
    let order = [];
    let filter = 'document';
    let name = '';
    let saved;

    function pageFor(entry){
      let page = pages.get(entry.id);
      if (!page) {
        page = { entry, quad: fullQuad(), found: false, rotation: 0, filter, preview: null, thumb: '', ready: null, edited: false };
        page.ready = (async () => {
          const file = await entry.ready;
          if (!file) throw new Error('missing');
          page.preview = await decode(file, PREVIEW_MAX);
          const img = pixels(page.preview, DETECT_SIZE);
          const result = detectPage(img.data, img.width, img.height);
          if (!page.edited) { page.quad = result.quad; page.found = result.found; }
          return page;
        })();
        pages.set(entry.id, page);
      }
      return page;
    }

    async function thumbnail(page){
      await page.ready;
      const canvas = renderPage(page.preview, page, 420);
      page.thumb = canvas.toDataURL('image/jpeg', 0.8);
      return page.thumb;
    }

    const next = (entries, step) => new Promise((resolve) => {
      const live = new Set(entries.map((entry) => entry.id));
      entries.forEach((entry) => { pageFor(entry); if (!order.includes(entry.id)) order.push(entry.id); });
      order = order.filter((id) => live.has(id));
      const body = step.body;
      // The review fills the step panel edge to edge; its footer stays put while the pages scroll.
      Object.assign(body.style, { padding: '0', display: 'flex', flexDirection: 'column', overflow: 'hidden' });
      step.element.style.background = '#f2f4f7';
      let busy = false;

      const removeEntry = (id) => {
        const page = pages.get(id);
        pages.delete(id); order = order.filter((entry) => entry !== id);
        if (page) step.remove?.(page.entry);
      };

      function renderList(){
        step.setTitle(T('review_title', 'Review scan'));
        const labels = FILTER_LABELS();
        const count = order.length;
        body.innerHTML = `
          <div class="fmds">
            <div class="fmds-scroll">
              <div class="fmds-pages">
                ${order.map((id, i) => `<button type="button" class="fmds-page busy" data-fmds-page="${esc(id)}" aria-label="${esc(T('edit_page_n', 'Page {number}: crop, rotate or remove', { number: i + 1 }))}"><img alt=""><span class="fmds-num">${i + 1}</span><span class="fmds-edit-mark" aria-hidden="true"><i class="fas fa-crop-simple"></i></span></button>`).join('')}
                <button type="button" class="fmds-add" data-fmds-more><i class="fas fa-camera" aria-hidden="true"></i><span>${esc(T('add_pages', 'Add pages'))}</span></button>
              </div>
            </div>
            <div class="fmds-foot">
              <div class="fmds-filters" role="radiogroup" aria-label="${esc(T('filter', 'Look'))}">
                ${FILTERS.map((key) => `<button type="button" class="fmds-chip" role="radio" data-fmds-filter="${key}" aria-checked="${filter === key}">${esc(labels[key])}</button>`).join('')}
              </div>
              <label class="fmds-name"><span>${esc(T('name', 'Name'))}</span><input type="text" data-fmds-name maxlength="120" value="${esc(name || defaultName())}" autocomplete="off"></label>
              <div class="fmds-actions">
                <button type="button" class="fmds-btn" data-fmds-discard>${esc(T('discard', 'Discard'))}</button>
                <button type="button" class="fmds-btn primary" data-fmds-save ${count ? '' : 'disabled'}><i class="fas fa-file-pdf" aria-hidden="true"></i>${esc(count === 1 ? T('save_one', 'Save 1 page') : T('save_many', 'Save {count} pages', { count }))}</button>
              </div>
              <p class="fmds-error" role="alert" data-fmds-error></p>
            </div>
          </div>`;
        const input = body.querySelector('[data-fmds-name]');
        if (!name) name = input.value;
        input.addEventListener('input', () => { name = input.value; });
        order.forEach((id) => {
          const page = pages.get(id);
          const tile = body.querySelector(`[data-fmds-page="${CSS.escape(id)}"]`);
          if (!page || !tile) return;
          if (!page.found && !page.edited) page.ready.then(() => { if (!page.found && !page.edited && tile.isConnected) tile.insertAdjacentHTML('beforeend', `<span class="fmds-loose" title="${esc(T('no_edge', 'No page edge found. Tap to crop it yourself.'))}"><i class="fas fa-exclamation" aria-hidden="true"></i></span>`); }).catch(() => null);
          const show = (url) => { const img = tile.querySelector('img'); if (img && url) { img.src = url; tile.classList.remove('busy'); } };
          if (page.thumb) show(page.thumb);
          else thumbnail(page).then(show).catch(() => { removeEntry(id); renderList(); });
          tile.addEventListener('click', () => { if (!busy) page.ready.then(() => renderEditor(id)).catch(() => null); });
        });
        body.querySelector('[data-fmds-more]').addEventListener('click', () => { if (!busy) resolve(false); });
        body.querySelectorAll('[data-fmds-filter]').forEach((chip) => chip.addEventListener('click', () => {
          if (busy || filter === chip.dataset.fmdsFilter) return;
          filter = chip.dataset.fmdsFilter;
          pages.forEach((page) => { page.filter = filter; page.thumb = ''; });
          renderList();
        }));
        body.querySelector('[data-fmds-discard]').addEventListener('click', () => {
          if (busy) return;
          if (order.length && !root.confirm(T('discard_confirm', 'Discard this scan? The pages are not saved anywhere.'))) return;
          resolve({ discarded: true });
        });
        body.querySelector('[data-fmds-save]').addEventListener('click', () => save());
      }

      function progress(text){
        let el = body.querySelector('.fmds-progress');
        if (!text) { el?.remove(); return; }
        if (!el) { el = document.createElement('div'); el.className = 'fmds-progress'; el.setAttribute('role', 'status'); el.innerHTML = '<i aria-hidden="true"></i><span></span>'; body.querySelector('.fmds')?.append(el); }
        el.querySelector('span').textContent = text;
      }

      async function save(){
        if (busy || !order.length) return;
        busy = true;
        const error = body.querySelector('[data-fmds-error]');
        error.textContent = '';
        body.querySelectorAll('button,input').forEach((el) => { el.disabled = true; });
        try {
          const out = [];
          for (let i = 0; i < order.length; i += 1) {
            progress(T('preparing_page', 'Preparing page {number} of {count}…', { number: i + 1, count: order.length }));
            const page = pages.get(order[i]);
            await page.ready;
            const source = await decode(page.entry.file, SOURCE_MAX);
            const canvas = renderPage(source, page, PAGE_MAX);
            source.width = source.height = 0;
            const blob = await toBlob(canvas, 'image/jpeg', JPEG_QUALITY);
            out.push({ bytes: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height });
            canvas.width = canvas.height = 0;
          }
          progress(T('saving', 'Saving…'));
          const fileName = safeFileName(name || defaultName());
          const file = new File([buildPdf(out)], fileName, { type: 'application/pdf', lastModified: Date.now() });
          saved = await options.save(file, { pages: out.length, name: fileName.replace(/\.pdf$/, '') });
          resolve({ saved: true });
        } catch (failure) {
          console.warn('Document scan could not be saved', failure);
          busy = false;
          progress('');
          body.querySelectorAll('button,input').forEach((el) => { el.disabled = false; });
          error.textContent = failure?.message && failure.message !== 'encode' ? failure.message : T('save_failed', 'The scan could not be saved. Try again.');
        }
      }

      function renderEditor(id){
        const page = pages.get(id);
        if (!page) return renderList();
        const index = order.indexOf(id);
        step.setTitle(T('page_n', 'Page {number}', { number: index + 1 }));
        body.innerHTML = `
          <div class="fmds">
            <div class="fmds-crop" data-fmds-crop>
              <div class="fmds-crop-box">
                <canvas aria-hidden="true"></canvas>
                <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true"><path></path><polygon></polygon></svg>
                ${['top_left', 'top_right', 'bottom_right', 'bottom_left'].map((corner, i) => `<button type="button" class="fmds-handle" data-fmds-corner="${i}" aria-label="${esc(T('corner_' + corner, ['Top left', 'Top right', 'Bottom right', 'Bottom left'][i] + ' corner'))}"></button>`).join('')}
              </div>
            </div>
            <div class="fmds-tools">
              <button type="button" class="fmds-tool" data-fmds-detect><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i>${esc(T('find_edges', 'Find edges'))}</button>
              <button type="button" class="fmds-tool" data-fmds-whole><i class="fas fa-expand" aria-hidden="true"></i>${esc(T('whole_photo', 'Whole photo'))}</button>
              <button type="button" class="fmds-tool" data-fmds-rotate><i class="fas fa-rotate-right" aria-hidden="true"></i><span>${esc(rotateLabel(page))}</span></button>
              <button type="button" class="fmds-tool" data-fmds-earlier ${index > 0 ? '' : 'disabled'}><i class="fas fa-arrow-left" aria-hidden="true"></i>${esc(T('move_earlier', 'Earlier'))}</button>
              <button type="button" class="fmds-tool" data-fmds-later ${index < order.length - 1 ? '' : 'disabled'}><i class="fas fa-arrow-right" aria-hidden="true"></i>${esc(T('move_later', 'Later'))}</button>
              <button type="button" class="fmds-tool danger" data-fmds-remove><i class="fas fa-trash" aria-hidden="true"></i>${esc(T('remove_page', 'Remove'))}</button>
            </div>
            <div class="fmds-foot"><div class="fmds-actions"><button type="button" class="fmds-btn primary" data-fmds-done>${esc(T('done', 'Done'))}</button></div></div>
          </div>`;
        const crop = body.querySelector('[data-fmds-crop]'), box = body.querySelector('.fmds-crop-box'), canvas = box.querySelector('canvas');
        const preview = page.preview;
        canvas.width = preview.width; canvas.height = preview.height;
        canvas.getContext('2d').drawImage(preview, 0, 0);
        const fit = () => {
          const pad = 44, cw = Math.max(40, crop.clientWidth - pad), ch = Math.max(40, crop.clientHeight - pad);
          const scale = Math.min(cw / preview.width, ch / preview.height);
          box.style.width = `${Math.round(preview.width * scale)}px`; box.style.height = `${Math.round(preview.height * scale)}px`;
        };
        const draw = () => {
          const q = page.quad;
          box.querySelector('polygon').setAttribute('points', q.map((p) => `${p.x},${p.y}`).join(' '));
          box.querySelector('path').setAttribute('d', `M0 0H1V1H0Z M${q.map((p) => `${p.x} ${p.y}`).join(' L')}Z`);
          box.querySelectorAll('[data-fmds-corner]').forEach((handle) => {
            const p = q[Number(handle.dataset.fmdsCorner)];
            handle.style.left = `${p.x * 100}%`; handle.style.top = `${p.y * 100}%`;
          });
        };
        const changed = () => { page.thumb = ''; draw(); };
        fit(); draw();
        const resize = new ResizeObserver(() => fit());
        resize.observe(crop);
        box.querySelectorAll('[data-fmds-corner]').forEach((handle) => {
          const corner = Number(handle.dataset.fmdsCorner);
          handle.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            handle.setPointerCapture(event.pointerId);
            const move = (e) => {
              const rect = box.getBoundingClientRect();
              page.quad[corner] = { x: clamp((e.clientX - rect.left) / rect.width, 0, 1), y: clamp((e.clientY - rect.top) / rect.height, 0, 1) };
              page.edited = true;
              changed();
            };
            const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); };
            handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
          });
          // Arrow keys nudge a corner by 0.5%.
          handle.addEventListener('keydown', (event) => {
            const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
            if (!step) return;
            event.preventDefault();
            const p = page.quad[corner];
            page.quad[corner] = { x: clamp(p.x + step[0] * 0.005, 0, 1), y: clamp(p.y + step[1] * 0.005, 0, 1) };
            page.edited = true;
            changed();
          });
        });
        const leave = (then) => { resize.disconnect(); then(); };
        body.querySelector('[data-fmds-detect]').addEventListener('click', () => {
          const img = pixels(preview, DETECT_SIZE);
          const result = detectPage(img.data, img.width, img.height);
          page.quad = result.quad; page.found = result.found; page.edited = true;
          changed();
        });
        body.querySelector('[data-fmds-whole]').addEventListener('click', () => { page.quad = fullQuad(); page.edited = true; changed(); });
        body.querySelector('[data-fmds-rotate]').addEventListener('click', (event) => { page.rotation = (page.rotation + 90) % 360; page.thumb = ''; event.currentTarget.querySelector('span').textContent = rotateLabel(page); });
        const shift = (by) => { const at = order.indexOf(id); [order[at], order[at + by]] = [order[at + by], order[at]]; leave(() => renderEditor(id)); };
        body.querySelector('[data-fmds-earlier]').addEventListener('click', () => shift(-1));
        body.querySelector('[data-fmds-later]').addEventListener('click', () => shift(1));
        body.querySelector('[data-fmds-remove]').addEventListener('click', () => { removeEntry(id); leave(() => (order.length ? renderList() : resolve(false))); });
        body.querySelector('[data-fmds-done]').addEventListener('click', () => leave(renderList));
      }

      renderList();
    });

    return new Promise((resolve) => {
      Camera.open({
        title: options.title || T('title', 'Scan paper'),
        subtitle: options.subtitle || '',
        overlay: liveGuide,
        next,
        onDone: (_entries, result) => resolve(result?.saved ? saved : null)
      });
    });
  }

  root.FirstMateDocumentScanner = {
    open,
    version: '20261113-scanner',
    _internals: { detectPage, orderQuad, convexHull, largestQuad, homography, pageSize, warp, enhance, buildPdf, polygonArea, safeFileName }
  };
})(typeof window !== 'undefined' ? window : globalThis);
