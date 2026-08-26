<?php
require_once __DIR__ . '/_storage.php';
session_start();

$isLocal = in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1', '::1'], true);
if (!$isLocal && !isset($_SESSION['user_email'])) {
    http_response_code(403);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Forbidden";
    exit;
}

$ver = time();
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CODEX GPT Standalone PDF Test Harness</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
    <script src="editor_scripts/pdf.js?v=<?=$ver?>"></script>
    <script src="editor_scripts/pdf_standalone.js?v=<?=$ver?>"></script>
    <style>
        :root {
            --bg: #f3f0e8;
            --panel: #fffdf8;
            --ink: #1b1b1b;
            --muted: #6b665c;
            --accent: #8d2b1f;
            --accent-2: #d9843b;
            --good: #1f7a3a;
            --bad: #a22626;
            --border: #d8cfbf;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            min-height: 100vh;
            font-family: Georgia, "Times New Roman", serif;
            color: var(--ink);
            background:
                radial-gradient(circle at top left, rgba(217, 132, 59, 0.18), transparent 32%),
                linear-gradient(135deg, #f5f0e4 0%, #ebe4d5 100%);
        }
        .shell {
            max-width: 1120px;
            margin: 0 auto;
            padding: 32px 20px 40px;
        }
        .hero {
            padding: 22px 24px;
            border: 1px solid rgba(141, 43, 31, 0.18);
            border-radius: 18px;
            background:
                linear-gradient(135deg, rgba(255,255,255,0.94), rgba(250,244,235,0.92)),
                repeating-linear-gradient(-45deg, rgba(141,43,31,0.04), rgba(141,43,31,0.04) 8px, transparent 8px, transparent 16px);
            box-shadow: 0 18px 42px rgba(58, 40, 22, 0.08);
        }
        h1 {
            margin: 0 0 10px;
            font-size: 34px;
            line-height: 1.05;
            letter-spacing: 0.02em;
        }
        .subhead {
            margin: 0;
            max-width: 760px;
            color: var(--muted);
            font-size: 17px;
            line-height: 1.5;
        }
        .grid {
            display: grid;
            grid-template-columns: 1.15fr 0.85fr;
            gap: 18px;
            margin-top: 20px;
        }
        .panel {
            border: 1px solid var(--border);
            border-radius: 18px;
            background: rgba(255, 253, 248, 0.96);
            padding: 18px;
            box-shadow: 0 12px 24px rgba(58, 40, 22, 0.06);
        }
        .panel h2 {
            margin: 0 0 14px;
            font-size: 20px;
        }
        .stack {
            display: grid;
            gap: 12px;
        }
        label {
            display: grid;
            gap: 6px;
            font-size: 14px;
            color: var(--muted);
        }
        input[type="text"], select {
            width: 100%;
            padding: 11px 12px;
            border-radius: 10px;
            border: 1px solid #cdbfa7;
            font: inherit;
            color: var(--ink);
            background: rgba(255,255,255,0.92);
        }
        .button-row {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin-top: 8px;
        }
        button {
            border: 0;
            border-radius: 999px;
            padding: 10px 16px;
            font: inherit;
            font-weight: 700;
            cursor: pointer;
            color: white;
            background: linear-gradient(135deg, var(--accent), #6f1f18);
            box-shadow: 0 8px 18px rgba(111, 31, 24, 0.18);
        }
        button.secondary {
            background: linear-gradient(135deg, #705f47, #514435);
        }
        button.ghost {
            color: var(--ink);
            background: #efe7da;
            box-shadow: none;
        }
        button:disabled {
            opacity: 0.55;
            cursor: wait;
        }
        .inline {
            display: flex;
            gap: 14px;
            align-items: center;
            flex-wrap: wrap;
        }
        .inline input[type="checkbox"] {
            transform: translateY(1px);
        }
        .status {
            min-height: 54px;
            padding: 12px 14px;
            border-radius: 12px;
            border: 1px solid #d7ccb8;
            background: #f7f2ea;
            line-height: 1.45;
        }
        .status.good {
            color: var(--good);
            border-color: rgba(31, 122, 58, 0.24);
            background: rgba(237, 248, 240, 0.9);
        }
        .status.bad {
            color: var(--bad);
            border-color: rgba(162, 38, 38, 0.22);
            background: rgba(252, 241, 241, 0.94);
        }
        .facts {
            display: grid;
            gap: 8px;
            margin-top: 14px;
            font-size: 14px;
        }
        .facts code {
            background: #f2ebde;
            border-radius: 6px;
            padding: 2px 6px;
        }
        pre {
            margin: 12px 0 0;
            min-height: 280px;
            max-height: 520px;
            overflow: auto;
            padding: 14px;
            border-radius: 14px;
            border: 1px solid #d8cfbf;
            background: #1e1d1a;
            color: #f5f0e4;
            font: 12px/1.5 Consolas, "Courier New", monospace;
            white-space: pre-wrap;
            word-break: break-word;
        }
        .hint {
            margin-top: 12px;
            color: var(--muted);
            font-size: 13px;
            line-height: 1.5;
        }
        .downloads {
            margin-top: 14px;
            padding: 12px;
            border-radius: 12px;
            border: 1px solid #d8cfbf;
            background: #f6efe2;
        }
        .downloads:empty {
            display: none;
        }
        .brand-panel {
            margin-top: 14px;
            padding: 14px;
            border-radius: 14px;
            border: 1px solid #d8cfbf;
            background: linear-gradient(180deg, rgba(255,255,255,0.88), rgba(247, 239, 226, 0.92));
        }
        .brand-panel h3 {
            margin: 0 0 10px;
            font-size: 16px;
        }
        .brand-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
        }
        .color-row {
            display: flex;
            gap: 8px;
            align-items: center;
        }
        .color-row input[type="color"] {
            width: 44px;
            height: 36px;
            padding: 0;
            border: 1px solid #cdbfa7;
            border-radius: 8px;
            background: white;
        }
        .brand-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 10px;
        }
        .brand-actions button {
            padding: 8px 12px;
            font-size: 13px;
            box-shadow: none;
        }
        .brand-preview {
            display: grid;
            grid-template-columns: 1fr auto;
            gap: 12px;
            align-items: center;
            margin-top: 12px;
            padding: 10px;
            border-radius: 12px;
            background: rgba(255,255,255,0.82);
            border: 1px solid rgba(141, 43, 31, 0.08);
        }
        .brand-swatches {
            display: flex;
            gap: 10px;
            align-items: center;
            flex-wrap: wrap;
        }
        .brand-swatch {
            width: 28px;
            height: 28px;
            border-radius: 999px;
            border: 1px solid rgba(0,0,0,0.12);
            box-shadow: inset 0 0 0 1px rgba(255,255,255,0.45);
        }
        .brand-logo-preview {
            max-width: 160px;
            max-height: 54px;
            object-fit: contain;
            background: white;
            border-radius: 8px;
            border: 1px solid rgba(0,0,0,0.08);
            padding: 6px;
        }
        .brand-logo-preview.empty {
            display: none;
        }
        .brand-note {
            margin-top: 8px;
            color: var(--muted);
            font-size: 12px;
            line-height: 1.45;
        }
        .download-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 8px 0;
            border-bottom: 1px solid rgba(141, 43, 31, 0.08);
        }
        .download-item:last-child {
            border-bottom: 0;
            padding-bottom: 0;
        }
        .download-meta {
            min-width: 0;
        }
        .download-name {
            font-size: 14px;
            font-weight: 700;
            overflow-wrap: anywhere;
        }
        .download-size {
            color: var(--muted);
            font-size: 12px;
            margin-top: 3px;
        }
        .download-link {
            display: inline-block;
            padding: 8px 12px;
            border-radius: 999px;
            background: linear-gradient(135deg, var(--accent), #6f1f18);
            color: #fff;
            text-decoration: none;
            font-size: 13px;
            font-weight: 700;
            white-space: nowrap;
        }
        .code-line {
            margin-top: 12px;
            padding: 10px 12px;
            border-radius: 10px;
            background: #efe6d7;
            font: 13px/1.4 Consolas, "Courier New", monospace;
            overflow-wrap: anywhere;
        }
        @media (max-width: 920px) {
            .grid { grid-template-columns: 1fr; }
            h1 { font-size: 28px; }
            .brand-grid { grid-template-columns: 1fr; }
            .brand-preview { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body data-codex-standalone-status="idle">
    <div class="shell">
        <section class="hero">
            <h1>CODEX GPT Standalone PDF Test Harness</h1>
            <p class="subhead">
                This page generates a project PDF from saved data without opening the editor UI.
                It uses the standalone runtime in <code>editor_scripts/pdf_standalone.js</code> and can run from either a folder id or a direct <code>pdf_state.json</code> URL.
            </p>
        </section>

        <div class="grid">
            <section class="panel">
                <h2>Run Test</h2>
                <div class="stack">
                    <label>
                        Folder Id
                        <input id="folderId" type="text" placeholder="d3e7c6e6ad8ce7f030d9922755e0a23d">
                    </label>
                    <label>
                        Direct pdf_state.json URL
                        <input id="pdfStateUrl" type="text" placeholder="/measure/internal/saves/PROJECT_ID/pdf_state.json">
                    </label>
                    <label>
                        Mode
                        <select id="modeSelect">
                            <option value="full">full</option>
                            <option value="summary">summary</option>
                            <option value="both">both</option>
                        </select>
                    </label>
                    <div class="brand-panel">
                        <h3>Branding</h3>
                        <label>
                            Branding Source
                            <select id="brandSource">
                                <option value="saved">Use saved project branding</option>
                                <option value="org">Use project company branding</option>
                                <option value="custom">Use custom branding below</option>
                            </select>
                        </label>
                        <div class="inline">
                            <label><input id="applyBrandingToFull" type="checkbox"> Apply branding to full report too</label>
                        </div>
                        <div class="brand-grid">
                            <label>
                                Primary Color
                                <div class="color-row">
                                    <input id="brandPrimaryColor" type="color" value="#c82828">
                                    <input id="brandPrimaryHex" type="text" value="#c82828" placeholder="#c82828">
                                </div>
                            </label>
                            <label>
                                Secondary Color
                                <div class="color-row">
                                    <input id="brandSecondaryColor" type="color" value="#960000">
                                    <input id="brandSecondaryHex" type="text" value="#960000" placeholder="#960000">
                                </div>
                            </label>
                        </div>
                        <label>
                            Custom Logo File
                            <input id="brandLogoFile" type="file" accept="image/*">
                        </label>
                        <label>
                            Custom Logo URL
                            <input id="brandLogoUrl" type="text" placeholder="/images/logo_red.png">
                        </label>
                        <div class="brand-actions">
                            <button id="btnUseSavedBranding" class="ghost" type="button">Copy saved branding</button>
                            <button id="btnUseOrgBranding" class="ghost" type="button">Copy company branding</button>
                            <button id="btnClearBranding" class="ghost" type="button">Clear custom branding</button>
                        </div>
                        <div class="brand-preview">
                            <div>
                                <div class="brand-swatches">
                                    <span class="brand-swatch" id="brandPrimarySwatch"></span>
                                    <span class="brand-swatch" id="brandSecondarySwatch"></span>
                                </div>
                                <div class="brand-note" id="brandNote">
                                    Summary branding already exists in the PDF system. The toggle above also lets the standalone runtime apply branding to full reports.
                                </div>
                            </div>
                            <img id="brandLogoPreview" class="brand-logo-preview empty" alt="Brand logo preview">
                        </div>
                    </div>
                    <div class="inline">
                        <label><input id="downloadToggle" type="checkbox"> Download PDFs</label>
                        <label><input id="autorunToggle" type="checkbox"> Auto-run from query string</label>
                    </div>
                    <div class="button-row">
                        <button id="btnLoadFolder">Load Folder Bundle</button>
                        <button id="btnLoadSnapshot" class="secondary">Load Snapshot URL</button>
                        <button id="btnGenerate" class="secondary">Generate PDF</button>
                        <button id="btnClear" class="ghost">Clear Log</button>
                    </div>
                </div>
                <div id="statusBox" class="status">Idle. Choose a folder id or a direct snapshot URL.</div>
                <div class="facts" id="factsBox"></div>
                <div id="downloadsBox" class="downloads"></div>
                <div class="hint">
                    Fastest proof of true standalone generation: put a direct <code>pdf_state.json</code> URL in the second box and run it. That path does not load the editor page or call any live editor state capture.
                </div>
                <div class="code-line" id="apiHint"></div>
            </section>

            <section class="panel">
                <h2>Execution Log</h2>
                <pre id="logBox"></pre>
            </section>
        </div>
    </div>

    <script>
        (function () {
            const els = {
                folderId: document.getElementById('folderId'),
                pdfStateUrl: document.getElementById('pdfStateUrl'),
                modeSelect: document.getElementById('modeSelect'),
                brandSource: document.getElementById('brandSource'),
                applyBrandingToFull: document.getElementById('applyBrandingToFull'),
                brandPrimaryColor: document.getElementById('brandPrimaryColor'),
                brandPrimaryHex: document.getElementById('brandPrimaryHex'),
                brandSecondaryColor: document.getElementById('brandSecondaryColor'),
                brandSecondaryHex: document.getElementById('brandSecondaryHex'),
                brandLogoFile: document.getElementById('brandLogoFile'),
                brandLogoUrl: document.getElementById('brandLogoUrl'),
                btnUseSavedBranding: document.getElementById('btnUseSavedBranding'),
                btnUseOrgBranding: document.getElementById('btnUseOrgBranding'),
                btnClearBranding: document.getElementById('btnClearBranding'),
                brandPrimarySwatch: document.getElementById('brandPrimarySwatch'),
                brandSecondarySwatch: document.getElementById('brandSecondarySwatch'),
                brandLogoPreview: document.getElementById('brandLogoPreview'),
                brandNote: document.getElementById('brandNote'),
                downloadToggle: document.getElementById('downloadToggle'),
                autorunToggle: document.getElementById('autorunToggle'),
                btnLoadFolder: document.getElementById('btnLoadFolder'),
                btnLoadSnapshot: document.getElementById('btnLoadSnapshot'),
                btnGenerate: document.getElementById('btnGenerate'),
                btnClear: document.getElementById('btnClear'),
                statusBox: document.getElementById('statusBox'),
                factsBox: document.getElementById('factsBox'),
                downloadsBox: document.getElementById('downloadsBox'),
                logBox: document.getElementById('logBox'),
                apiHint: document.getElementById('apiHint')
            };

            const state = {
                bundle: null,
                snapshot: null,
                runtimeContext: null,
                lastResults: null,
                downloadEntries: [],
                customLogoDataUrl: null,
                loadedSavedBranding: null,
                loadedOrgBranding: null,
                brandingDirty: false
            };

            function log(message, data) {
                const stamp = new Date().toISOString();
                const suffix = data === undefined ? '' : ` ${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`;
                els.logBox.textContent += `[${stamp}] ${message}${suffix}\n`;
                els.logBox.scrollTop = els.logBox.scrollHeight;
            }

            function setBodyStatus(value) {
                document.body.setAttribute('data-codex-standalone-status', value);
            }

            function setStatus(message, tone = '') {
                els.statusBox.textContent = message;
                els.statusBox.className = `status${tone ? ` ${tone}` : ''}`;
                log(message);
            }

            function setBusy(isBusy) {
                for (const button of [els.btnLoadFolder, els.btnLoadSnapshot, els.btnGenerate]) {
                    button.disabled = isBusy;
                }
            }

            function normalizeHex(value, fallback = '') {
                const raw = String(value || '').trim();
                const hex = raw.startsWith('#') ? raw : `#${raw}`;
                return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : fallback;
            }

            function getLoadedOrganizationBranding() {
                return state.loadedOrgBranding || null;
            }

            function getSavedBrandingOverrides() {
                return state.loadedSavedBranding || null;
            }

            function setColorPair(colorInput, hexInput, nextValue, fallback) {
                const value = normalizeHex(nextValue, fallback);
                colorInput.value = value || fallback;
                hexInput.value = value || fallback;
            }

            function setLogoPreview(src) {
                if (src) {
                    els.brandLogoPreview.src = src;
                    els.brandLogoPreview.classList.remove('empty');
                } else {
                    els.brandLogoPreview.removeAttribute('src');
                    els.brandLogoPreview.classList.add('empty');
                }
            }

            function updateBrandPreview() {
                const primary = normalizeHex(els.brandPrimaryHex.value, '#c82828');
                const secondary = normalizeHex(els.brandSecondaryHex.value, '#960000');
                els.brandPrimarySwatch.style.background = primary;
                els.brandSecondarySwatch.style.background = secondary;

                const brandSource = els.brandSource.value;
                const orgBranding = getLoadedOrganizationBranding();
                const autoApplyForFullMode = els.modeSelect.value === 'full' && brandSource !== 'saved';
                const sourceLabel = brandSource === 'custom'
                    ? 'Custom branding will override the project branding for this standalone run.'
                    : brandSource === 'org'
                        ? (orgBranding ? 'Project company branding will be used for this standalone run.' : 'No project company branding is loaded for this project.')
                        : 'Saved project branding from the snapshot will be used for this standalone run.';
                const fullNote = autoApplyForFullMode
                    ? ' Full mode will apply this branding automatically.'
                    : els.applyBrandingToFull.checked
                    ? ' Branding will apply to full reports too.'
                    : ' Branding will follow the existing summary-only behavior unless the PDF already has saved overrides.';
                els.brandNote.textContent = sourceLabel + fullNote;
            }

            function setCustomBrandingFields(source = {}) {
                setColorPair(els.brandPrimaryColor, els.brandPrimaryHex, source.primaryColor, '#c82828');
                setColorPair(els.brandSecondaryColor, els.brandSecondaryHex, source.secondaryColor, '#960000');
                state.customLogoDataUrl = source.logoDataUrl || source.logo || null;
                els.brandLogoUrl.value = (state.customLogoDataUrl && !String(state.customLogoDataUrl).startsWith('data:'))
                    ? state.customLogoDataUrl
                    : '';
                setLogoPreview(state.customLogoDataUrl);
                updateBrandPreview();
                updateApiHint();
            }

            function syncColorInputs(colorInput, hexInput, fallback) {
                colorInput.addEventListener('input', () => {
                    hexInput.value = colorInput.value;
                    updateBrandPreview();
                    updateApiHint();
                });
                hexInput.addEventListener('input', () => {
                    const normalized = normalizeHex(hexInput.value, fallback);
                    if (normalized) colorInput.value = normalized;
                    updateBrandPreview();
                    updateApiHint();
                });
                hexInput.addEventListener('blur', () => {
                    const normalized = normalizeHex(hexInput.value, fallback);
                    colorInput.value = normalized || fallback;
                    hexInput.value = normalized || fallback;
                    updateBrandPreview();
                    updateApiHint();
                });
            }

            function escapeHtml(value) {
                return String(value)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;');
            }

            function refreshFacts() {
                const rows = [];
                if (state.bundle) {
                    rows.push(`Loaded folder: <code>${escapeHtml(state.bundle.folderId || '')}</code>`);
                    rows.push(`Manifest address: <code>${escapeHtml(state.bundle.manifest?.address || '')}</code>`);
                    rows.push(`pdf_state asset: <code>${escapeHtml(state.bundle.pdfStateAsset || '')}</code>`);
                }
                if (state.snapshot) {
                    rows.push(`Snapshot address: <code>${escapeHtml(state.snapshot.address || '')}</code>`);
                    rows.push(`Faces: <code>${escapeHtml((state.snapshot.facesData || []).length)}</code>`);
                    rows.push(`Structures: <code>${escapeHtml((state.snapshot.structures || []).length)}</code>`);
                    rows.push(`Excluded signatures: <code>${escapeHtml((state.snapshot.excludedSignatures || []).length)}</code>`);
                }
                if (getLoadedOrganizationBranding()) {
                    rows.push(`Company branding: <code>loaded</code>`);
                }
                if (getSavedBrandingOverrides() && (
                    getSavedBrandingOverrides().primaryColor ||
                    getSavedBrandingOverrides().secondaryColor ||
                    getSavedBrandingOverrides().logoDataUrl
                )) {
                    rows.push(`Saved branding override: <code>present</code>`);
                }
                if (state.lastResults && state.lastResults.length) {
                    const summary = state.lastResults.map(entry => `${entry.mode}:${entry.result.filename}`).join(', ');
                    rows.push(`Generated: <code>${escapeHtml(summary)}</code>`);
                }
                els.factsBox.innerHTML = rows.join('');
                updateApiHint();
            }

            function formatBytes(bytes) {
                const size = Number(bytes) || 0;
                if (size < 1024) return `${size} B`;
                if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
                return `${(size / (1024 * 1024)).toFixed(2)} MB`;
            }

            function clearDownloadEntries() {
                for (const entry of state.downloadEntries) {
                    try { URL.revokeObjectURL(entry.url); } catch (e) {}
                }
                state.downloadEntries = [];
                els.downloadsBox.innerHTML = '';
            }

            function renderDownloads(results) {
                clearDownloadEntries();
                if (!Array.isArray(results) || !results.length) return;

                const fragments = [];
                results.forEach((entry, index) => {
                    const url = URL.createObjectURL(entry.result.blob);
                    state.downloadEntries.push({
                        mode: entry.mode,
                        filename: entry.result.filename,
                        url
                    });
                    fragments.push(`
                        <div class="download-item">
                            <div class="download-meta">
                                <div class="download-name">${escapeHtml(entry.result.filename)}</div>
                                <div class="download-size">${escapeHtml(entry.mode)} • ${escapeHtml(formatBytes(entry.result.blob.size))}</div>
                            </div>
                            <a class="download-link" href="${url}" download="${escapeHtml(entry.result.filename)}" data-download-index="${index}">Download PDF</a>
                        </div>
                    `);
                });
                els.downloadsBox.innerHTML = fragments.join('');
            }

            function updateApiHint() {
                const folderId = (els.folderId.value || '').trim();
                const pdfStateUrl = (els.pdfStateUrl.value || '').trim();
                const options = buildStandaloneOptions({ download: true });
                const optionEntries = [];
                const displayOptions = JSON.parse(JSON.stringify(options));
                if (displayOptions.brandingOverrides && displayOptions.brandingOverrides.logoDataUrl && displayOptions.brandingOverrides.logoDataUrl.length > 80) {
                    displayOptions.brandingOverrides.logoDataUrl = '[uploaded-data-url]';
                }
                Object.keys(displayOptions).forEach((key) => {
                    if (key === 'onStatus' || key === 'mode' || key === 'modes') return;
                    const value = displayOptions[key];
                    if (value === undefined) return;
                    optionEntries.push(`${key}: ${JSON.stringify(value)}`);
                });
                const optionsLiteral = `{ ${optionEntries.join(', ')} }`;
                if (folderId) {
                    els.apiHint.textContent = `await FirstMatePDFStandalone.generateProjectPdfsFromFolder('${folderId}', ${optionsLiteral})`;
                    return;
                }
                if (pdfStateUrl) {
                    els.apiHint.textContent = `const snapshot = await fetch('${pdfStateUrl}').then(r => r.json()); await FirstMatePDFStandalone.generateProjectPdfsFromSnapshot(snapshot, {}, ${optionsLiteral})`;
                    return;
                }
                els.apiHint.textContent = `await FirstMatePDFStandalone.generateProjectPdfsFromFolder('PROJECT_ID', ${optionsLiteral})`;
            }

            function buildStandaloneOptions(baseOptions) {
                const brandSource = els.brandSource.value;
                const mode = baseOptions.mode || els.modeSelect.value;
                const options = { ...baseOptions };
                const autoApplyBrandingToFull = mode === 'full' && brandSource !== 'saved';

                if (els.applyBrandingToFull.checked || autoApplyBrandingToFull) {
                    options.applyBrandingToFull = true;
                }

                if (brandSource === 'org') {
                    options.useProjectOrganizationBranding = true;
                    options.clearBrandingOverrides = true;
                } else if (brandSource === 'custom') {
                    options.brandingOverrides = {
                        primaryColor: normalizeHex(els.brandPrimaryHex.value, '#c82828'),
                        secondaryColor: normalizeHex(els.brandSecondaryHex.value, '#960000'),
                        logoDataUrl: state.customLogoDataUrl || null
                    };
                }

                return options;
            }

            async function fetchJson(url) {
                const resp = await fetch(url, { cache: 'no-store' });
                if (!resp.ok) {
                    throw new Error(`Request failed (${resp.status}) for ${url}`);
                }
                return resp.json();
            }

            function applyLoadedBrandingDefaults() {
                state.loadedSavedBranding = (state.snapshot && state.snapshot.brandingOverrides) ? { ...state.snapshot.brandingOverrides } : null;
                state.loadedOrgBranding = (state.runtimeContext && state.runtimeContext.organization && state.runtimeContext.organization.branding)
                    ? { ...state.runtimeContext.organization.branding }
                    : null;

                if (state.brandingDirty) {
                    updateBrandPreview();
                    return;
                }

                if (state.loadedSavedBranding && (
                    state.loadedSavedBranding.primaryColor ||
                    state.loadedSavedBranding.secondaryColor ||
                    state.loadedSavedBranding.logoDataUrl
                )) {
                    els.brandSource.value = 'saved';
                    setCustomBrandingFields(state.loadedSavedBranding);
                } else if (state.loadedOrgBranding) {
                    els.brandSource.value = 'org';
                    setCustomBrandingFields({
                        primaryColor: state.loadedOrgBranding.colors && state.loadedOrgBranding.colors.primary,
                        secondaryColor: state.loadedOrgBranding.colors && state.loadedOrgBranding.colors.secondary,
                        logo: state.loadedOrgBranding.logo || null
                    });
                } else {
                    els.brandSource.value = 'custom';
                    setCustomBrandingFields({});
                }
                updateBrandPreview();
            }

            async function loadFromFolder() {
                const folderId = (els.folderId.value || '').trim();
                if (!folderId) throw new Error('Enter a folder id first.');
                setBusy(true);
                setStatus(`Loading saved project bundle for ${folderId}...`);
                try {
                    const bundle = await window.FirstMatePDFStandalone.loadProjectBundle(folderId);
                    state.bundle = bundle;
                    state.snapshot = bundle.snapshot;
                    state.runtimeContext = {
                        folderId: bundle.folderId,
                        manifest: bundle.manifest,
                        organization: bundle.organization
                    };
                    if (!els.pdfStateUrl.value && bundle.pdfStateAsset) {
                        els.pdfStateUrl.value = `/${bundle.pdfStateAsset.replace(/^\/+/, '')}`;
                    }
                    applyLoadedBrandingDefaults();
                    setBodyStatus('loaded');
                    setStatus(`Loaded folder ${folderId}. Snapshot is ready.`, 'good');
                    log('Bundle manifest', bundle.manifest || {});
                    log('Organization context', bundle.organization || {});
                    refreshFacts();
                } finally {
                    setBusy(false);
                }
            }

            async function loadFromSnapshotUrl() {
                const pdfStateUrl = (els.pdfStateUrl.value || '').trim();
                if (!pdfStateUrl) throw new Error('Enter a direct pdf_state.json URL first.');
                setBusy(true);
                setStatus(`Loading snapshot from ${pdfStateUrl}...`);
                try {
                    const snapshot = await fetchJson(pdfStateUrl);
                    state.bundle = null;
                    state.snapshot = snapshot;
                    state.runtimeContext = {
                        folderId: snapshot.folderId || null,
                        manifest: null,
                        organization: null
                    };
                    applyLoadedBrandingDefaults();
                    setBodyStatus('loaded');
                    setStatus(`Loaded saved snapshot directly from ${pdfStateUrl}.`, 'good');
                    log('Snapshot payload', {
                        folderId: snapshot.folderId || null,
                        address: snapshot.address || '',
                        faces: (snapshot.facesData || []).length,
                        structures: (snapshot.structures || []).length,
                        excludedSignatures: (snapshot.excludedSignatures || []).length
                    });
                    refreshFacts();
                } finally {
                    setBusy(false);
                }
            }

            async function generate() {
                if (!state.snapshot) {
                    if ((els.pdfStateUrl.value || '').trim()) {
                        await loadFromSnapshotUrl();
                    } else if ((els.folderId.value || '').trim()) {
                        await loadFromFolder();
                    } else {
                        throw new Error('Load a folder or snapshot first.');
                    }
                }

                const mode = els.modeSelect.value;
                const download = !!els.downloadToggle.checked;
                const isBoth = mode === 'both';
                const runner = isBoth
                    ? window.FirstMatePDFStandalone.generateProjectPdfsFromSnapshot
                    : window.FirstMatePDFStandalone.generateProjectPdfFromSnapshot;

                setBusy(true);
                setStatus(`Generating ${mode} PDF${isBoth ? 's' : ''} outside the editor...`);
                try {
                    const options = buildStandaloneOptions({
                        download,
                        mode: isBoth ? undefined : mode,
                        modes: isBoth ? ['full', 'summary'] : undefined,
                        onStatus(payload) {
                            if (!payload) return;
                            if (typeof payload === 'string') {
                                log(`runtime ${mode}`, payload);
                                return;
                            }
                            log(`runtime ${payload.mode || mode}`, payload.message || '');
                        }
                    });
                    const generated = await runner(state.snapshot, state.runtimeContext || {}, options);
                    state.lastResults = Array.isArray(generated) ? generated : [{ mode, ...generated }];
                    renderDownloads(state.lastResults);
                    refreshFacts();
                    const fileList = state.lastResults.map(entry => `${entry.result.filename} (${entry.result.blob.size} bytes)`).join(', ');
                    setBodyStatus('passed');
                    setStatus(`Standalone PDF generation passed: ${fileList}`, 'good');
                    log('Generation results', state.lastResults.map(entry => ({
                        mode: entry.mode,
                        filename: entry.result.filename,
                        size: entry.result.blob.size
                    })));
                    if (download && state.downloadEntries.length) {
                        log('Download fallback', 'If the browser blocks the automatic download, use the Download PDF links shown below the facts area.');
                    }
                } finally {
                    setBusy(false);
                }
            }

            function applyQueryParams() {
                const qs = new URLSearchParams(window.location.search);
                const folder = (qs.get('folder') || '').trim();
                const pdfStateUrl = (qs.get('pdfStateUrl') || '').trim();
                const mode = (qs.get('mode') || '').trim();
                const brandSource = (qs.get('brandSource') || '').trim();
                const primary = (qs.get('brandPrimary') || '').trim();
                const secondary = (qs.get('brandSecondary') || '').trim();
                const brandLogoUrl = (qs.get('brandLogoUrl') || '').trim();
                const autorun = qs.get('autorun') === '1';
                const download = qs.get('download') === '1';
                const applyBrandingToFull = qs.get('applyBrandingToFull') === '1';
                const brandingCustomized = !!(brandSource || primary || secondary || brandLogoUrl || applyBrandingToFull);

                if (folder) els.folderId.value = folder;
                if (pdfStateUrl) els.pdfStateUrl.value = pdfStateUrl;
                if (mode === 'full' || mode === 'summary' || mode === 'both') {
                    els.modeSelect.value = mode;
                }
                if (brandSource === 'saved' || brandSource === 'org' || brandSource === 'custom') {
                    els.brandSource.value = brandSource;
                }
                if (primary) setColorPair(els.brandPrimaryColor, els.brandPrimaryHex, primary, '#c82828');
                if (secondary) setColorPair(els.brandSecondaryColor, els.brandSecondaryHex, secondary, '#960000');
                if (brandLogoUrl) {
                    state.customLogoDataUrl = brandLogoUrl;
                    els.brandLogoUrl.value = brandLogoUrl;
                    setLogoPreview(brandLogoUrl);
                }
                els.autorunToggle.checked = autorun;
                els.downloadToggle.checked = download;
                els.applyBrandingToFull.checked = applyBrandingToFull;
                state.brandingDirty = brandingCustomized;
                updateBrandPreview();
                updateApiHint();
                return { autorun, brandingCustomized };
            }

            function bind() {
                syncColorInputs(els.brandPrimaryColor, els.brandPrimaryHex, '#c82828');
                syncColorInputs(els.brandSecondaryColor, els.brandSecondaryHex, '#960000');

                els.brandSource.addEventListener('change', () => {
                    state.brandingDirty = true;
                    updateBrandPreview();
                    updateApiHint();
                });
                els.applyBrandingToFull.addEventListener('change', () => {
                    state.brandingDirty = true;
                    updateBrandPreview();
                    updateApiHint();
                });
                els.brandLogoFile.addEventListener('change', () => {
                    const file = els.brandLogoFile.files && els.brandLogoFile.files[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        state.brandingDirty = true;
                        state.customLogoDataUrl = event.target && event.target.result ? String(event.target.result) : null;
                        els.brandLogoUrl.value = '';
                        els.brandSource.value = 'custom';
                        setLogoPreview(state.customLogoDataUrl);
                        updateBrandPreview();
                        updateApiHint();
                    };
                    reader.readAsDataURL(file);
                    els.brandLogoFile.value = '';
                });
                els.brandLogoUrl.addEventListener('input', () => {
                    state.brandingDirty = true;
                    const value = String(els.brandLogoUrl.value || '').trim();
                    state.customLogoDataUrl = value || null;
                    if (value) els.brandSource.value = 'custom';
                    setLogoPreview(state.customLogoDataUrl);
                    updateBrandPreview();
                    updateApiHint();
                });
                els.btnUseSavedBranding.addEventListener('click', () => {
                    const saved = getSavedBrandingOverrides();
                    if (!saved) {
                        setStatus('This snapshot does not have saved branding overrides.', 'bad');
                        return;
                    }
                    state.brandingDirty = true;
                    els.brandSource.value = 'custom';
                    setCustomBrandingFields(saved);
                    updateApiHint();
                });
                els.btnUseOrgBranding.addEventListener('click', () => {
                    const orgBranding = getLoadedOrganizationBranding();
                    if (!orgBranding) {
                        setStatus('This project does not have company branding loaded.', 'bad');
                        return;
                    }
                    state.brandingDirty = true;
                    els.brandSource.value = 'custom';
                    setCustomBrandingFields({
                        primaryColor: orgBranding.colors && orgBranding.colors.primary,
                        secondaryColor: orgBranding.colors && orgBranding.colors.secondary,
                        logo: orgBranding.logo || null
                    });
                    updateApiHint();
                });
                els.btnClearBranding.addEventListener('click', () => {
                    state.brandingDirty = true;
                    els.brandSource.value = 'custom';
                    setCustomBrandingFields({});
                    updateApiHint();
                });
                els.btnLoadFolder.addEventListener('click', async () => {
                    try {
                        await loadFromFolder();
                    } catch (err) {
                        setBodyStatus('failed');
                        setStatus(err.message || String(err), 'bad');
                        log('Load folder failed', err && err.stack ? err.stack : String(err));
                    }
                });

                els.btnLoadSnapshot.addEventListener('click', async () => {
                    try {
                        await loadFromSnapshotUrl();
                    } catch (err) {
                        setBodyStatus('failed');
                        setStatus(err.message || String(err), 'bad');
                        log('Load snapshot failed', err && err.stack ? err.stack : String(err));
                    }
                });

                els.btnGenerate.addEventListener('click', async () => {
                    try {
                        await generate();
                    } catch (err) {
                        setBodyStatus('failed');
                        setStatus(err.message || String(err), 'bad');
                        log('Generate failed', err && err.stack ? err.stack : String(err));
                    }
                });

                els.btnClear.addEventListener('click', () => {
                    els.logBox.textContent = '';
                    state.lastResults = null;
                    clearDownloadEntries();
                    refreshFacts();
                    setBodyStatus('idle');
                    setStatus('Idle. Log cleared.');
                });

                els.folderId.addEventListener('input', updateApiHint);
                els.pdfStateUrl.addEventListener('input', updateApiHint);
                window.addEventListener('error', (event) => {
                    setBodyStatus('failed');
                    setStatus(event.message || 'Unhandled error', 'bad');
                    log('window.onerror', {
                        message: event.message,
                        source: event.filename,
                        line: event.lineno,
                        column: event.colno
                    });
                });
            }

            (async function init() {
                bind();
                const query = applyQueryParams();
                updateBrandPreview();
                refreshFacts();
                setStatus('Idle. Choose a saved project and run the standalone renderer.');
                if (query.autorun) {
                    try {
                        await generate();
                    } catch (err) {
                        setBodyStatus('failed');
                        setStatus(err.message || String(err), 'bad');
                        log('Autorun failed', err && err.stack ? err.stack : String(err));
                    }
                }
            })();

            window.addEventListener('beforeunload', clearDownloadEntries);
        })();
    </script>
</body>
</html>
