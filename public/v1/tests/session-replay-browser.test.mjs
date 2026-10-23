import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// Session replay in a real browser (docs/architecture/session-replay.md): a page is
// recorded while it is driven through hovers, typing, re-renders, moves, shadow roots,
// an iframe, stylesheet edits, scrolling and SVG; a second page replays the chunks and,
// at every checkpoint, its rebuilt DOM, computed styles and scroll positions must match
// what the live page had. No server: the recorder's transport keeps chunks in memory.
// The chunks are first archived the way the server archives a finished session
// (session-replay/archive-codec.ts) and the replay plays what the archive restores.
// node --test tests/session-replay-browser.test.mjs

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'http://replay.test';
const LIB = '/libraries/session-replay/';

const SHEET = `h1 { letter-spacing: 3px; color: rgb(10, 20, 30); }
.from-link { color: rgb(200, 100, 0); background: url(img/dot.png) no-repeat; }
` + Array.from({ length: 120 }, (_, i) => `.filler-${i} { margin: ${i}px; padding: ${i % 7}px; }`).join(' ');

const HARNESS = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Replay harness</title>
<style id="main-style">
body { font-family: Arial, sans-serif; margin: 0; height: 2000px; }
.menu-item { padding: 8px; background-color: rgb(240, 240, 240); }
.menu-item:hover { background-color: rgb(255, 0, 0); }
.btn:focus { outline: 3px solid rgb(0, 128, 0); }
.scroller { height: 100px; overflow: auto; }
.row { height: 20px; }
.highlight { color: rgb(0, 0, 255); }
nav:hover .hint { display: inline; }
.hint { display: none; }
</style>
<link rel="stylesheet" href="/assets/sheet.css">
</head>
<body>
<header data-test="header"><h1 data-test="title">Replay harness</h1>
<nav data-test="nav"><div class="menu-item" data-test="menu">Products <span class="hint" data-test="hint">(hover)</span></div><div class="menu-item" data-test="menu2">About</div></nav></header>
<main>
<form onsubmit="return false">
<input id="name" data-test="name" placeholder="Name">
<input id="pw" type="password" data-test="pw">
<input id="agree" type="checkbox" data-test="agree">
<select id="pick" data-test="pick"><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>
<textarea id="notes" data-test="notes">initial</textarea>
<button type="button" class="btn" id="go" data-test="go">Go</button>
</form>
<p class="from-link" data-test="linked">styled by a linked sheet</p>
<div class="scroller" id="scroller" data-test="scroller"></div>
<ul id="list" data-test="list"></ul>
<div id="host" data-test="host"></div>
<div id="late-host" data-test="late-host"></div>
<iframe id="frame" data-test="frame" style="width:300px;height:120px" srcdoc="<!DOCTYPE html><html><head><style>p{color:rgb(5,6,7)}</style></head><body><p id='inner'>inside frame</p></body></html>"></iframe>
<p id="counter" data-test="counter">0</p>
<div id="bin"><span id="mover" data-test="mover">I move</span></div>
<div id="dest" data-test="dest"></div>
<!-- a comment the recorder skips -->
</main>
<script>
document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<style>i{color:rgb(77,0,77)}</style><i>open shadow</i>';
const menu = document.querySelector('[data-test=menu]');
menu.addEventListener('mouseenter', () => {
  const box = document.createElement('div');
  box.id = 'dropdown';
  box.innerHTML = '<ul class="drop">' + ['Roofing', 'Siding', 'Gutters', 'Windows', 'Doors', 'Solar', 'Insulation', 'Decks']
    .map((name, i) => '<li class="drop-item" data-i="' + i + '"><a href="#' + name.toLowerCase() + '"><span>' + name + '</span></a></li>').join('') + '</ul>';
  menu.appendChild(box);
});
menu.addEventListener('mouseleave', () => { const box = document.getElementById('dropdown'); if (box) box.remove(); });
window.__renderList = (count, changed) => {
  const list = document.getElementById('list');
  list.innerHTML = Array.from({ length: count }, (_, i) => '<li class="item" data-row="' + i + '"><b>Row</b> <em>' + (i === changed ? 'changed' : 'number ' + i) + '</em></li>').join('');
};
</script>
</body></html>`;

const PLAYER = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0}#stage{position:relative;width:1300px;height:830px}</style></head>
<body><div id="stage"></div>
<script src="${LIB}session-replay-codec.js"></script>
<script src="${LIB}session-replay-player.js"></script>
</body></html>`;

// Runs in both pages: a canonical text form of a document (and its frames and shadow roots).
function installProbe() {
  window.__normalize = (doc) => {
    const out = [];
    const skip = new Set(['script', 'noscript', 'base']);
    const attrs = (el) => {
      const list = [];
      for (const attr of Array.from(el.attributes)) {
        let name = attr.name, value = attr.value;
        if (name === 'data-fmr-link') continue;
        if (name.startsWith('data-fmr-')) name = name.slice(9);
        if (name === 'class') value = value.split(/\s+/).filter((c) => c && !c.startsWith('__fmr-')).join(' ');
        if (name === 'class' && !value) continue;
        if (/^on[a-z]+$/.test(name)) continue;
        list.push(name + '=' + JSON.stringify(value));
      }
      return list.sort().join(' ');
    };
    const walk = (node) => {
      if (node.nodeType === 3) { out.push('#text ' + JSON.stringify(node.data)); return; }
      if (node.nodeType !== 1) return;
      let tag = node.localName;
      if (skip.has(tag) || node.hasAttribute('data-fmr-ignore')) return;
      if (tag === 'style' && node.hasAttribute('data-fmr-link')) tag = 'link';
      let line = '<' + tag + (node.namespaceURI !== 'http://www.w3.org/1999/xhtml' ? ' ns=' + node.namespaceURI : '') + ' ' + attrs(node);
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        const value = node.type === 'password' ? '*'.repeat(node.value.length) : node.value;
        line += ' :value=' + JSON.stringify(value) + ' :checked=' + !!node.checked;
      }
      out.push(line);
      if (tag !== 'style' && tag !== 'link') {
        if (node.shadowRoot) { out.push('#shadow'); node.shadowRoot.childNodes.forEach(walk); out.push('/#shadow'); }
        if (tag === 'iframe') {
          const inner = node.contentDocument;
          if (inner && inner.documentElement) { out.push('#doc'); walk(inner.documentElement); out.push('/#doc'); }
        } else node.childNodes.forEach(walk);
      }
      out.push('</' + tag + '>');
    };
    walk(doc.documentElement);
    return out.join('\n');
  };
  window.__styles = (doc) => {
    const out = {};
    const props = ['color', 'backgroundColor', 'display', 'outlineStyle', 'outlineColor', 'letterSpacing', 'fontSize', 'backgroundImage'];
    const visit = (scope, prefix) => {
      for (const el of scope.querySelectorAll('[data-test]')) {
        const style = el.ownerDocument.defaultView.getComputedStyle(el);
        out[prefix + el.getAttribute('data-test')] = props.map((p) => style[p]).join('|');
      }
    };
    visit(doc, '');
    const host = doc.getElementById('host');
    if (host && host.shadowRoot) { const i = host.shadowRoot.querySelector('i'); if (i) out['shadow:i'] = getComputedStyle(i).color; }
    const late = doc.getElementById('late-host');
    if (late && late.shadowRoot) { const b = late.shadowRoot.querySelector('b'); if (b) out['shadow:b'] = getComputedStyle(b).color; }
    const frame = doc.getElementById('frame');
    const inner = frame && frame.contentDocument && frame.contentDocument.querySelector('p');
    if (inner) out['frame:p'] = inner.ownerDocument.defaultView.getComputedStyle(inner).color;
    const scroller = doc.getElementById('scroller');
    out.scroll = [doc.defaultView.scrollY, scroller ? scroller.scrollTop : -1].join(',');
    return out;
  };
}

async function serve(context) {
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname.startsWith('/harness.html')) return route.fulfill({ status: 200, contentType: 'text/html', body: HARNESS });
    if (url.pathname === '/player.html') return route.fulfill({ status: 200, contentType: 'text/html', body: PLAYER });
    if (url.pathname === '/assets/sheet.css') return route.fulfill({ status: 200, contentType: 'text/css', body: SHEET });
    if (url.pathname === '/assets/img/dot.png') return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64') });
    if (url.pathname.startsWith(LIB)) {
      const body = await readFile(path.join(PUBLIC, url.pathname));
      return route.fulfill({ status: 200, contentType: 'text/javascript', body });
    }
    return route.fulfill({ status: 404, body: '' });
  });
}

test('a recorded session replays to the same DOM, styles and scroll at every checkpoint', { timeout: 120000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await serve(context);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.goto(ORIGIN + '/harness.html');
    await page.addScriptTag({ url: LIB + 'session-replay-codec.js' });
    await page.addScriptTag({ url: LIB + 'session-replay-recorder.js' });
    await page.evaluate(installProbe);
    await page.waitForFunction(() => document.querySelector('link[rel=stylesheet]').sheet && document.getElementById('frame').contentDocument.getElementById('inner'));
    await page.evaluate(() => {
      window.__chunks = [];
      window.__blobs = {};
      const transport = {
        sendChunk: async (item) => { window.__chunks.push({ page_id: item.page_id, seq: item.seq, json: item.json, raw: item.raw_bytes, stored: item.stored_bytes, paths: item.paths }); return { ok: true, status: 200, next_ms: window.__nextMs }; },
        missingBlobs: async (keys) => keys.filter((key) => !(key in window.__blobs)),
        sendBlob: async (blob) => { window.__blobs[blob.key] = { key: blob.key, encoding: blob.encoding, data: FMReplayRecorder.base64(blob.bytes) }; return { ok: true, status: 200 }; },
        beacon: () => {},
        beaconBlob: (blob) => { (window.__beaconBlobs = window.__beaconBlobs || []).push(blob.encoding); }
      };
      window.__rec = FMReplayRecorder.create({ transport, chunkIntervalMs: 1000, pageAllowed: (path) => !path.startsWith('/secret') });
      window.__rec.start();
    });

    const checkpoints = [];
    const checkpoint = async (name) => {
      await page.waitForTimeout(90);
      checkpoints.push(await page.evaluate((label) => ({
        name: label,
        t: Math.round(performance.timeOrigin) + Math.round(performance.now()),
        dom: window.__normalize(document),
        styles: window.__styles(document)
      }), name));
    };

    await checkpoint('initial');
    await page.hover('[data-test=menu]');
    await checkpoint('dropdown open, menu hovered');
    await page.mouse.move(700, 760);
    await checkpoint('dropdown closed');
    await page.hover('[data-test=menu]');
    await checkpoint('dropdown open again');
    await page.mouse.move(700, 760);

    await page.click('[data-test=name]');
    await page.keyboard.type('Hello replay world');
    await checkpoint('typed a name');
    await page.keyboard.press('Home');
    await page.keyboard.type('Oh ');
    await checkpoint('typed at the start');
    await page.click('[data-test=pw]');
    await page.keyboard.type('secret123');
    await checkpoint('typed a password');
    await page.check('[data-test=agree]');
    await page.selectOption('[data-test=pick]', 'c');
    await page.fill('[data-test=notes]', 'notes changed');
    await checkpoint('form fields');
    await page.evaluate(() => { document.getElementById('name').value = 'Set by script'; document.getElementById('agree').checked = false; });
    await checkpoint('values set by script');

    await page.evaluate(() => window.__renderList(60, -1));
    await checkpoint('list rendered');
    await page.evaluate(() => window.__renderList(60, 17));
    await checkpoint('list re-rendered with one change');

    await page.evaluate(() => { const el = document.getElementById('counter'); for (let i = 1; i <= 25; i++) el.textContent = String(i); el.classList.add('highlight'); el.setAttribute('title', 'counted'); });
    await checkpoint('text and attribute churn');
    await page.evaluate(() => document.getElementById('dest').appendChild(document.getElementById('mover')));
    await checkpoint('node moved');

    await page.evaluate(() => { const p = document.createElement('p'); p.textContent = 'added in shadow'; document.getElementById('host').shadowRoot.appendChild(p); });
    await page.evaluate(() => { document.getElementById('late-host').attachShadow({ mode: 'open' }).innerHTML = '<style>b{color:rgb(1,2,3)}</style><b>late shadow</b>'; });
    await checkpoint('shadow roots');

    await page.evaluate(() => { const d = document.getElementById('frame').contentDocument; const s = d.createElement('strong'); s.textContent = 'frame mutation'; d.body.appendChild(s); });
    await checkpoint('iframe changed');
    await page.evaluate(() => new Promise((resolve) => {
      const frame = document.getElementById('frame');
      frame.addEventListener('load', () => setTimeout(resolve, 60), { once: true });
      frame.srcdoc = '<!DOCTYPE html><html><head><style>p{color:rgb(9,8,7)}</style></head><body><h2>second document</h2><p>new</p></body></html>';
    }));
    await checkpoint('iframe navigated');

    await page.evaluate(() => { document.getElementById('main-style').textContent += '\n#counter { font-size: 31px; }'; });
    await page.evaluate(() => { const s = document.createElement('style'); document.head.appendChild(s); s.sheet.insertRule('#dest { background-color: rgb(9, 99, 199); }', 0); });
    await checkpoint('stylesheets edited');

    await page.evaluate(() => { const scroller = document.getElementById('scroller'); for (let i = 0; i < 40; i++) { const row = document.createElement('div'); row.className = 'row'; row.textContent = 'row ' + i; scroller.appendChild(row); } });
    await page.evaluate(() => { document.getElementById('scroller').scrollTop = 230; window.scrollTo(0, 120); });
    await page.waitForTimeout(200);
    await checkpoint('scrolled');
    await page.evaluate(() => window.scrollTo(0, 0));

    await page.evaluate(() => document.getElementById('dest').insertAdjacentHTML('beforeend', '<svg width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="10" fill="rgb(1, 200, 3)"></circle><foreignObject width="40" height="40"><div xmlns="http://www.w3.org/1999/xhtml">fo</div></foreignObject></svg>'));
    await checkpoint('svg');
    await page.click('[data-test=go]');
    await checkpoint('button focused');
    await page.evaluate(() => document.getElementById('list').remove());
    await checkpoint('list removed');
    // The portal's injectCSS (portal/scripts/core.js): an empty <style> appended to <head>, then its text set,
    // here longer than a blob (2,048 characters), and a dialog that uses it (the billing "More credit needed" window).
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.id = 'css_billing';
      document.head.appendChild(style);
      style.textContent = '.b-overlay{position:fixed;inset:0;background:rgb(1, 2, 3);color:rgb(250, 251, 252);display:flex}\n'
        + '.b-win{background:rgb(255, 255, 255);letter-spacing:2px;font-size:19px}\n' + '.b-pad{padding:1px}\n'.repeat(160);
      const overlay = document.createElement('div');
      overlay.className = 'b-overlay';
      overlay.setAttribute('data-test', 'billing-overlay');
      overlay.innerHTML = '<div class="b-win" data-test="billing-win">More credit needed</div>';
      document.body.appendChild(overlay);
    });
    await checkpoint('injected stylesheet and dialog');
    await page.evaluate(() => history.pushState({}, '', '/harness.html?step=2'));
    await checkpoint('pushState');

    // A page set not to be recorded: the recording pauses as the person arrives (nothing of that page is kept) and
    // resumes, as a new page, when they leave.
    const before = await page.evaluate(() => window.__rec.pageId);
    const encodeBefore = await page.evaluate(() => window.__rec.stats().encode);
    await page.evaluate(() => { history.pushState({}, '', '/secret/area'); document.body.insertAdjacentHTML('beforeend', '<p id="secret">SECRET TEXT</p>'); });
    await page.waitForTimeout(300);
    const paused = await page.evaluate(() => window.__rec.stats());
    assert.deepEqual([paused.paused, paused.recording], [true, false]);
    await page.evaluate(() => { document.getElementById('secret').textContent = 'Left behind'; history.pushState({}, '', '/harness.html?step=3'); });
    await page.waitForTimeout(300);
    const resumed = await page.evaluate(() => ({ stats: window.__rec.stats(), page: window.__rec.pageId }));
    assert.deepEqual([resumed.stats.paused, resumed.stats.recording], [false, true]);
    assert.notEqual(resumed.page, before);
    await page.evaluate(() => document.getElementById('secret').remove());

    await page.evaluate(() => window.__rec.flush());
    await page.waitForFunction(() => window.__rec.stats().chunks_queued === 0);
    const recorded = await page.evaluate(() => ({ chunks: window.__chunks, blobs: window.__blobs, stats: window.__rec.stats() }));
    const allJson = recorded.chunks.map((chunk) => chunk.json).join('\n');
    assert.ok(!allJson.includes('SECRET TEXT'), 'nothing of the page that is not recorded was kept');
    assert.ok(allJson.includes('Recording paused'), 'the recording says where it paused');
    const paths = recorded.chunks.flatMap((chunk) => (chunk.paths || []).map((entry) => entry[0]));
    assert.ok(paths.includes('/harness.html') && !paths.some((path) => path.startsWith('/secret')), JSON.stringify(paths));
    // Pacing: a reply's next_ms sets the upload interval; hurry() sends at once and asks for short intervals.
    const pacing = await page.evaluate(async () => {
      const before = window.__rec.stats().upload_interval_ms;
      window.__nextMs = 7000;
      window.__rec.track('pace', 1);
      await window.__rec.flush();
      const replied = window.__rec.stats().upload_interval_ms;
      window.__nextMs = undefined;
      const sent = window.__rec.stats().chunks_sent;
      window.__rec.track('hurry', 1);
      await window.__rec.hurry(2000);
      return { before, replied, hurried: window.__rec.stats().upload_interval_ms, sentNow: window.__rec.stats().chunks_sent - sent };
    });
    assert.deepEqual(pacing, { before: 1000, replied: 7000, hurried: 2000, sentNow: 1 });
    // A stylesheet that appears just before the page is left (the credit dialog, then checkout) still goes up.
    const exitBlobs = await page.evaluate(() => {
      const style = document.createElement('style');
      document.head.appendChild(style);
      style.textContent = '.exit-only{color:rgb(9, 8, 7)}' + ' .exit-pad{margin:1px}'.repeat(150);
      window.dispatchEvent(new Event('pagehide'));
      return window.__beaconBlobs || [];
    });
    assert.deepEqual(exitBlobs, ['identity']);
    assert.deepEqual(pageErrors, []);
    assert.equal(recorded.stats.internal_errors, 0);
    assert.ok(encodeBefore.refs >= 1, 'the reopened dropdown is written as a reference to the first one');
    assert.ok(encodeBefore.patches >= 1, 'the re-rendered list reuses the earlier rows with patches');
    assert.ok(Object.keys(recorded.blobs).length >= 1, 'the linked stylesheet is stored as a shared blob');
    const json = recorded.chunks.map((chunk) => chunk.json).join('\n');
    assert.ok(!json.includes('secret123'), 'the password never leaves the page');
    console.log('session replay sizes:', JSON.stringify({ chunks: recorded.chunks.length, raw_bytes: recorded.stats.raw_bytes, gzip_bytes: recorded.stats.gzip_bytes,
      blob_gzip_bytes: recorded.stats.blob_gzip_bytes, cpu_ms: recorded.stats.cpu_ms, snapshot_ms: recorded.stats.snapshot_ms, encode: recorded.stats.encode }));

    // Archive the session: strings renumbered onto a vocabulary, packed with a dictionary, unpacked and restored.
    // Every chunk must come back byte for byte; the replay below plays the restored chunks.
    const archiveCodec = await import('../session-replay/archive-codec.ts');
    const byPage = new Map();
    for (const chunk of recorded.chunks) {
      if (!byPage.has(chunk.page_id)) byPage.set(chunk.page_id, []);
      byPage.get(chunk.page_id).push({ seq: chunk.seq, json: chunk.json });
    }
    const strings = [...byPage.values()].flatMap((chunks) => archiveCodec.pageStrings(chunks));
    const vocabulary = archiveCodec.combineVocabularies(strings.filter((_, i) => i % 3 === 0), strings.filter((_, i) => i % 3 === 1));
    const archivedPages = [...byPage].map(([pageId, chunks]) => archiveCodec.archivePage(pageId, chunks, vocabulary));
    assert.ok(archivedPages.every((result) => result.canonical), archivedPages.map((result) => result.reason).join(' '));
    const dictionary = Buffer.from(archivedPages.map((result) => archiveCodec.dictionaryPiece(result.page)).join(''));
    const packed = archiveCodec.compressArchive(archiveCodec.serializeArchive({ f: archiveCodec.ARCHIVE_FORMAT, p: archivedPages.map((result) => result.page) }), dictionary);
    const restored = archiveCodec.decompressArchive(packed, dictionary).p
      .flatMap((page) => archiveCodec.restorePage(page, vocabulary).map((chunk) => ({ page_id: page.i, seq: chunk.seq, json: chunk.json })));
    const order = (list) => list.map(({ page_id, seq, json }) => ({ page_id, seq, json })).sort((a, b) => a.page_id.localeCompare(b.page_id) || a.seq - b.seq);
    assert.deepEqual(order(restored), order(recorded.chunks), 'the archive restores every chunk exactly');

    // Replay in a separate page.
    const viewer = await context.newPage();
    const viewerErrors = [];
    viewer.on('pageerror', (error) => viewerErrors.push(String(error)));
    viewer.on('console', (message) => { if (message.type() === 'warning' || message.type() === 'error') viewerErrors.push(message.text()); });
    await viewer.goto(ORIGIN + '/player.html');
    await viewer.evaluate(installProbe);
    await viewer.evaluate(async ({ chunks, blobs }) => {
      const gunzip = async (b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
      };
      const blobMap = new Map();
      for (const [key, blob] of Object.entries(blobs)) blobMap.set(key, await gunzip(blob.data));
      const model = new FMReplayPlayer.SessionModel();
      for (const chunk of chunks) model.addChunk(chunk.page_id, chunk.seq, JSON.parse(chunk.json));
      window.__player = FMReplayPlayer.create({ stage: document.getElementById('stage'), model, blobs: blobMap });
    }, { chunks: restored, blobs: recorded.blobs });

    const replayAt = (t) => viewer.evaluate((time) => {
      window.__player.seek(time);
      const doc = document.querySelector('.fmr-frame iframe').contentDocument;
      return { dom: window.__normalize(doc), styles: window.__styles(doc) };
    }, t);

    if (process.env.REPLAY_DEBUG) {
      for (const chunk of recorded.chunks) {
        const parsed = JSON.parse(chunk.json);
        let t = parsed.t;
        for (const event of parsed.e) { t += event[0]; if (event[1] === 4 || event[1] === 2) console.log('DEBUG event', event[1], t, JSON.stringify(event.slice(2)).slice(0, 80)); }
      }
      for (const point of checkpoints) console.log('DEBUG checkpoint', point.name, point.t, point.styles.scroll);
    }
    const compare = async (order) => {
      for (const point of order) {
        const replay = await replayAt(point.t);
        if (replay.dom !== point.dom) {
          const live = point.dom.split('\n'), mirrored = replay.dom.split('\n');
          const at = live.findIndex((line, i) => line !== mirrored[i]);
          assert.fail(`DOM differs at "${point.name}" line ${at}:\n live:   ${live[at]}\n replay: ${mirrored[at]}`);
        }
        assert.deepEqual(replay.styles, point.styles, `computed styles differ at "${point.name}"`);
      }
    };
    await compare(checkpoints);
    await compare(checkpoints.slice().reverse());
    assert.deepEqual(viewerErrors, []);
  } finally {
    await browser.close();
  }
});
