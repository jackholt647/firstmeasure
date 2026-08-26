(function () {
  if (!window.Portal) return;

  const cfg = () => window.Portal?.cfg || window.PORTAL_CFG || {};
  const esc = (v) => window.Portal.escapeHtml(String(v ?? ''));
  const AUTO_LOGO_BRANDING_KEY = 'sample_reports_auto_logo_branding';
  const AUTO_DOWNLOAD_KEY = 'sample_reports_auto_download';

  function readStoredToggle(key, fallback = true) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return fallback;
      return raw === '1';
    } catch (error) {
      return fallback;
    }
  }

  function writeStoredToggle(key, value) {
    try {
      window.localStorage.setItem(key, value ? '1' : '0');
    } catch (error) {}
  }

  const state = {
    initialized: false,
    page: 1,
    limit: 10,
    search: '',
    type: 'all',
    reportState: 'all',
    favoriteIds: [],
    favoriteConfigs: [],
    projects: [],
    pagination: null,
    searchNotice: '',
    timer: null,
    selectedId: null,
    bundle: null,
    snapshot: null,
    runtimeContext: null,
    loading: false,
    busy: false,
    urls: [],
    lastResults: [],
    customLogo: null,
    savedBranding: null,
    orgBranding: null,
    brandingDirty: false,
    favoriteBusy: false,
    autoBrandFromLogo: readStoredToggle(AUTO_LOGO_BRANDING_KEY, true),
    autoDownload: readStoredToggle(AUTO_DOWNLOAD_KEY, true)
  };

  function api(payload) {
    return window.Portal.apiPost((cfg().endpoints && cfg().endpoints.portal) || 'sales.php', payload);
  }

  function isSampleReportsAdmin() {
    return !!(cfg().flags && cfg().flags.sample_reports_admin);
  }

  async function fetchJson(url) {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`Request failed (${resp.status}) for ${url}`);
    return resp.json();
  }

  function hex(value, fallback) {
    const raw = String(value || '').trim();
    const next = raw.startsWith('#') ? raw : `#${raw}`;
    return /^#[0-9a-fA-F]{6}$/.test(next) ? next.toLowerCase() : fallback;
  }

  function fmtDate(value) {
    const raw = String(value || '').trim();
    if (!raw) return '-';
    const t = Date.parse(raw.replace(' ', 'T'));
    return Number.isFinite(t) ? new Date(t).toLocaleDateString() : raw;
  }

  function fmtBytes(value) {
    const n = Number(value || 0);
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  function favoriteSet() {
    return new Set(Array.isArray(state.favoriteIds) ? state.favoriteIds : []);
  }

  function normalizeFavoriteConfigs(raw) {
    if (!Array.isArray(raw)) return [];
    const configs = [];
    const seen = new Set();
    raw.forEach((entry) => {
      const folderId = String(entry?.id || entry?.folder_id || entry?.folder || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-f0-9]/g, '');
      if (!folderId || seen.has(folderId)) return;
      seen.add(folderId);
      configs.push({
        id: folderId,
        label: String(entry?.label || entry?.name || folderId).trim() || folderId
      });
    });
    return configs;
  }

  function favoriteConfigMap() {
    const map = new Map();
    normalizeFavoriteConfigs(state.favoriteConfigs).forEach((entry) => {
      map.set(entry.id, entry);
    });
    return map;
  }

  function typeLabel(value) {
    return { residential: 'Residential', commercial: 'Commercial', multifamily: 'Multi-Family' }[value] || (value || 'Unknown');
  }

  function get(id) {
    return document.getElementById(id);
  }

  function clearUrls() {
    for (const url of state.urls) {
      try { URL.revokeObjectURL(url); } catch (e) {}
    }
    state.urls = [];
  }

  function ctx() {
    return {
      host: get('view-sample-reports'),
      summary: get('srSummary'),
      search: get('srSearch'),
      results: get('srResults'),
      pagination: get('srPagination'),
      reportState: get('srReportState'),
      empty: get('srEmpty'),
      detail: get('srDetail'),
      refresh: get('srRefreshBtn')
    };
  }

  function setStatus(message, tone = '', target) {
    if (!target) return;
    target.textContent = message;
    target.className = `sr-status${tone ? ` ${tone}` : ''}`;
  }

  function setBusy(isBusy) {
    state.busy = !!isBusy;
    const c = ctx();
    if (c.refresh) c.refresh.disabled = state.loading || state.busy;

    const buttonIds = [
      'srGenerateFull',
      'srGenerateSummary',
      'srGenerateBoth',
      'srUseSavedBranding',
      'srUseOrgBranding',
      'srClearBranding'
    ];
    buttonIds.forEach((id) => {
      const el = get(id);
      if (el) el.disabled = state.busy;
    });

    ['srPrimaryColor', 'srPrimaryHex', 'srSecondaryColor', 'srSecondaryHex', 'srLogoFile', 'srLogoUrl', 'srCustomerName', 'srAutoBrandFromLogo', 'srAutoDownload']
      .forEach((id) => {
        const el = get(id);
        if (el) el.disabled = state.busy;
      });
  }

  function ensureStyles() {
    if (document.getElementById('sampleReportsStyles')) return;
    const style = document.createElement('style');
    style.id = 'sampleReportsStyles';
    style.textContent = `
      .sr-shell{display:grid;grid-template-columns:minmax(340px,460px) minmax(420px,1fr);gap:20px;align-items:start}
      .sr-card{background:#fff;border:1px solid #e4e8ef;border-radius:18px;box-shadow:0 12px 28px rgba(18,32,56,.06)}
      .sr-pane{padding:18px}.sr-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
      .sr-search,.sr-select,.sr-input{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #d7dce7;border-radius:12px;font:inherit;background:#fff}
      .sr-search:focus,.sr-select:focus,.sr-input:focus{outline:none;border-color:#d93025;box-shadow:0 0 0 4px rgba(217,48,37,.12)}
      .sr-toolbar{display:grid;gap:12px;margin-bottom:14px}.sr-segments{display:flex;gap:8px;flex-wrap:wrap}
      .sr-seg,.sr-mini,.sr-page-btn{border:1px solid #d7dce7;background:#fff;color:#445064;border-radius:999px;padding:8px 12px;font-size:12px;font-weight:800;cursor:pointer}
      .sr-seg.active{background:#d93025;border-color:#d93025;color:#fff}.sr-results{display:grid;gap:12px;min-height:260px}
      .sr-empty{padding:40px 18px;text-align:center;color:#79869a}.sr-result{display:grid;grid-template-columns:92px 1fr auto;gap:12px;border:1px solid #e5e9f2;background:#fff;border-radius:16px;padding:10px;cursor:pointer}
      .sr-result:hover{border-color:#d93025;box-shadow:0 12px 22px rgba(217,48,37,.08)}.sr-result.active{border-color:#d93025;box-shadow:0 0 0 3px rgba(217,48,37,.12)}
      .sr-thumb{width:92px;height:92px;border-radius:12px;background:linear-gradient(135deg,#eef2f7,#dde6f5);overflow:hidden;display:flex;align-items:center;justify-content:center;color:#7c8798;font-size:12px;font-weight:800}
      .sr-thumb img{width:100%;height:100%;object-fit:cover;display:block}.sr-title{font-size:14px;font-weight:900;color:#1e2735;line-height:1.35}
      .sr-meta{margin-top:6px;font-size:12px;color:#667287;line-height:1.45}.sr-badges{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
      .sr-pill{display:inline-flex;align-items:center;padding:4px 8px;border-radius:999px;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.04em;border:1px solid transparent}
      .sr-pill.residential{background:#e8f0fe;color:#1a73e8;border-color:#b6cdfb}.sr-pill.commercial{background:#fff3e0;color:#d46b08;border-color:#ffd39c}.sr-pill.multifamily{background:#f4e8ff;color:#7b1fa2;border-color:#dbb6ef}
      .sr-pill.saved{background:#e7f6ec;color:#18794e;border-color:#b7e0c7}.sr-pill.snapshot{background:#fff7d6;color:#8c6a00;border-color:#f0da83}.sr-pill.favorite{background:#fff4db;color:#9a6700;border-color:#f3d489}
      .sr-pin{align-self:start;width:36px;height:36px;border-radius:999px;border:1px solid #d7dce7;background:#fff;color:#8b97ab;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
      .sr-pin.active{background:#fff4db;border-color:#f3d489;color:#9a6700}.sr-pin.busy{opacity:.55;cursor:wait}
      .sr-pagination{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:14px}.sr-info{font-size:12px;color:#697487;font-weight:800}
      .sr-detail-empty{min-height:520px;display:flex;align-items:center;justify-content:center;text-align:center;color:#6a7688;padding:30px}
      .sr-hero{display:grid;grid-template-columns:160px 1fr;gap:16px;margin-bottom:16px}.sr-hero .sr-thumb{width:160px;height:130px;border-radius:16px}.sr-big{font-size:22px;line-height:1.2;margin:0 0 8px}
      .sr-sub{color:#667287;font-size:13px;line-height:1.5}.sr-links,.sr-actions,.sr-brand-actions{display:flex;gap:10px;flex-wrap:wrap}
      .sr-link,.sr-action{display:inline-flex;align-items:center;justify-content:center;gap:8px;border-radius:999px;text-decoration:none;cursor:pointer;font-weight:800;padding:10px 14px;border:none;color:#fff;background:linear-gradient(135deg,#d93025,#9b1f16)}
      .sr-link.secondary,.sr-action.secondary{color:#223040;background:#eef2f7;border:1px solid #d7dce7}.sr-action[disabled]{opacity:.55;cursor:wait}
      .sr-box{margin-top:18px;padding:16px;border-radius:16px;border:1px solid #e7ebf3;background:#fff}.sr-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
      .sr-inline{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.sr-color{display:flex;gap:8px;align-items:center}.sr-color input[type=color]{width:44px;height:36px;padding:0;border:1px solid #d7dce7;border-radius:10px;background:#fff}
      .sr-switch-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 14px;border:1px solid #e7ebf3;border-radius:14px;background:#fbfcfe;font-size:13px;color:#445064;font-weight:800}
      .sr-switch{position:relative;display:inline-flex;align-items:center;width:48px;height:28px;flex-shrink:0}
      .sr-switch-input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
      .sr-switch-slider{position:absolute;inset:0;border-radius:999px;background:#d6dde8;transition:background .18s ease}
      .sr-switch-slider::after{content:'';position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;box-shadow:0 2px 6px rgba(17,24,39,.18);transition:transform .18s ease}
      .sr-switch-input:checked + .sr-switch-slider{background:#d93025}
      .sr-switch-input:checked + .sr-switch-slider::after{transform:translateX(20px)}
      .sr-switch-input:disabled + .sr-switch-slider{opacity:.55}
      .sr-preview{display:grid;grid-template-columns:1fr auto;gap:14px;align-items:center;margin-top:12px;padding:12px;border-radius:14px;border:1px solid #ece1cf;background:rgba(255,255,255,.88)}
      .sr-swatches{display:flex;gap:10px;align-items:center}.sr-swatch{width:28px;height:28px;border-radius:999px;border:1px solid rgba(0,0,0,.14)}.sr-logo{max-width:170px;max-height:56px;object-fit:contain;background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:10px;padding:6px}.sr-logo.empty{display:none}
      .sr-note{margin-top:8px;color:#667287;font-size:12px;line-height:1.45}.sr-status{margin-top:12px;min-height:52px;padding:12px 14px;border-radius:14px;border:1px solid #e1e6ef;background:#f7f9fc;color:#445064;line-height:1.45}
      .sr-status.good{background:#edf9f0;border-color:#c7ebd2;color:#17603d}.sr-status.bad{background:#fff1f1;border-color:#f2cccc;color:#9f1f1f}.sr-downloads{display:grid;gap:10px;margin-top:12px}
      .sr-download{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px;border:1px solid #e7ebf3;border-radius:14px;background:#fbfcfe}.sr-download-name{font-size:14px;font-weight:900;color:#202938}.sr-download-meta{margin-top:4px;font-size:12px;color:#667287}
      .sr-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:10px}.sr-fact{padding:12px;border-radius:14px;background:#f8fafc;border:1px solid #e7ebf3}
      .sr-fact-label{font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.04em;color:#7b8798}.sr-fact-value{margin-top:5px;font-size:14px;font-weight:800;color:#1f2937;line-height:1.4}
      .sr-hint{margin-top:12px;font-size:12px;color:#667287;line-height:1.5}
      @media (max-width:1180px){.sr-shell{grid-template-columns:1fr}}@media (max-width:760px){.sr-hero{grid-template-columns:1fr}.sr-hero .sr-thumb{width:100%;height:180px}.sr-grid,.sr-preview,.sr-facts{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function ensureMarkup() {
    const host = get('view-sample-reports');
    if (!host || host.dataset.srReady === '1') return;
    host.dataset.srReady = '1';
    const admin = isSampleReportsAdmin();
    host.innerHTML = `
      <div class="header-bar">
        <h1>Sample Reports</h1>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button class="btn-secondary" id="srRefreshBtn"><i class="fas fa-sync"></i> Refresh</button>
        </div>
      </div>
      <div class="sr-shell">
        <div class="sr-card sr-pane">
          <div class="sr-head">
            <div><h2 style="margin:0;">Project Browser</h2></div>
            <div id="srSummary" class="sr-info">Loading...</div>
          </div>
          ${admin ? `
          <div class="sr-toolbar">
            <input id="srSearch" class="sr-search" type="text" placeholder="Search address, issuer, or owner...">
            <div class="sr-segments" id="srTypes">
              <button class="sr-seg active" data-type="all" type="button">All</button>
              <button class="sr-seg" data-type="residential" type="button">Residential</button>
              <button class="sr-seg" data-type="commercial" type="button">Commercial</button>
              <button class="sr-seg" data-type="multifamily" type="button">Multi-Family</button>
            </div>
            <select id="srReportState" class="sr-select">
              <option value="all">All Snapshot Projects</option>
              <option value="saved_report">Has Saved PDF</option>
              <option value="generated_only">Snapshot Only</option>
            </select>
          </div>` : ''}
          <div id="srResults" class="sr-results"></div>
          <div id="srPagination" class="sr-pagination"></div>
        </div>
        <div class="sr-card sr-pane">
          <div id="srEmpty" class="sr-detail-empty"><div><div style="font-size:18px;font-weight:900;color:#1f2937;">Choose a project sample</div></div></div>
          <div id="srDetail" style="display:none;"></div>
        </div>
      </div>
    `;
  }

  function savedBranding() {
    return state.savedBranding || null;
  }

  function orgBranding() {
    return state.orgBranding || null;
  }

  function setLogoPreview(value) {
    const preview = get('srLogoPreview');
    if (!preview) return;
    if (value) {
      preview.src = value;
      preview.classList.remove('empty');
    } else {
      preview.removeAttribute('src');
      preview.classList.add('empty');
    }
  }

  function setPair(colorId, textId, value, fallback) {
    const c = get(colorId);
    const t = get(textId);
    const next = hex(value, fallback);
    if (c) c.value = next;
    if (t) t.value = next;
  }

  function updateBrandNote() {
    const note = get('srBrandNote');
    if (!note) return;
    const hasOrg = !!orgBranding();
    const hasSaved = !!savedBranding();

    if (hasOrg && !state.brandingDirty) {
      note.textContent = 'Company branding is loaded by default for this temporary sample run. Any edits below stay local to this download and do not update the organization.';
      return;
    }
    if (hasOrg && state.brandingDirty) {
      note.textContent = 'These edits temporarily override the company branding for this sample run only. They do not update the organization.';
      return;
    }
    if (hasSaved && !state.brandingDirty) {
      note.textContent = 'Saved project branding is loaded for this temporary sample run. Any edits below stay local to this download.';
      return;
    }
    if (hasSaved && state.brandingDirty) {
      note.textContent = 'These edits temporarily override the saved project branding for this sample run only.';
      return;
    }
    note.textContent = 'These branding edits apply only to this temporary sample run and are not saved back to the project or organization.';
  }
  function updateBrandPreview() {
    const primary = hex(get('srPrimaryHex')?.value, '#c82828');
    const secondary = hex(get('srSecondaryHex')?.value, '#960000');
    const sw1 = get('srPrimarySwatch');
    const sw2 = get('srSecondarySwatch');
    if (sw1) sw1.style.background = primary;
    if (sw2) sw2.style.background = secondary;
    updateBrandNote();
  }

  function relativeLuminance(r, g, b) {
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  function rgbToHex(r, g, b) {
    return `#${[r, g, b].map((value) => Math.max(0, Math.min(255, value | 0)).toString(16).padStart(2, '0')).join('')}`;
  }

  function colorDistance(a, b) {
    return Math.sqrt(
      ((a.r || 0) - (b.r || 0)) ** 2 +
      ((a.g || 0) - (b.g || 0)) ** 2 +
      ((a.b || 0) - (b.b || 0)) ** 2
    );
  }

  function isUsableBrandColor(r, g, b) {
    const max = Math.max(r, g, b) / 255;
    const min = Math.min(r, g, b) / 255;
    const sat = max === 0 ? 0 : (max - min) / max;
    const luminance = relativeLuminance(r, g, b);
    if (r > 242 && g > 242 && b > 242) return false;
    if (luminance > 0.82) return false;
    if (luminance > 0.72 && sat < 0.24) return false;
    return true;
  }

  function extractLogoPalette(source) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const maxSize = 160;
          const scale = Math.min(1, maxSize / Math.max(img.width || 1, img.height || 1));
          const width = Math.max(1, Math.round((img.width || 1) * scale));
          const height = Math.max(1, Math.round((img.height || 1) * scale));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx2d) throw new Error('Canvas unavailable');
          ctx2d.drawImage(img, 0, 0, width, height);
          const imageData = ctx2d.getImageData(0, 0, width, height).data;
          const buckets = new Map();
          const bucketSize = 24;

          for (let i = 0; i < imageData.length; i += 4) {
            const alpha = imageData[i + 3];
            if (alpha < 140) continue;
            const r = imageData[i];
            const g = imageData[i + 1];
            const b = imageData[i + 2];
            if (!isUsableBrandColor(r, g, b)) continue;
            const qr = Math.min(255, Math.round(r / bucketSize) * bucketSize);
            const qg = Math.min(255, Math.round(g / bucketSize) * bucketSize);
            const qb = Math.min(255, Math.round(b / bucketSize) * bucketSize);
            const key = `${qr},${qg},${qb}`;
            const existing = buckets.get(key) || { r: qr, g: qg, b: qb, count: 0 };
            existing.count += 1;
            buckets.set(key, existing);
          }

          const ranked = Array.from(buckets.values()).sort((a, b) => b.count - a.count);
          const primary = ranked[0] || null;
          let secondary = null;
          if (primary) {
            secondary = ranked.find((entry) => colorDistance(entry, primary) >= 64) || null;
          }
          resolve({
            primary: primary ? rgbToHex(primary.r, primary.g, primary.b) : null,
            secondary: secondary ? rgbToHex(secondary.r, secondary.g, secondary.b) : null
          });
        } catch (error) {
          reject(error);
        }
      };
      img.onerror = () => reject(new Error('Could not read logo colors'));
      img.src = source;
    });
  }

  async function applyLogoPaletteFromSource(source) {
    const raw = String(source || '').trim();
    if (!raw) return false;
    const palette = await extractLogoPalette(raw);
    if (!palette.primary) return false;
    state.brandingDirty = true;
    setPair('srPrimaryColor', 'srPrimaryHex', palette.primary, '#c82828');
    setPair('srSecondaryColor', 'srSecondaryHex', palette.secondary || '#4a4a4a', '#4a4a4a');
    updateBrandPreview();
    return true;
  }

  async function maybeAutoApplyLogoPalette(source) {
    if (!get('srAutoBrandFromLogo')?.checked) return;
    try {
      const applied = await applyLogoPaletteFromSource(source);
      if (applied) {
        setStatus('Updated branding colors from the uploaded logo.', 'good', get('srRunStatus'));
      } else {
        setStatus('Logo uploaded, but no strong non-light brand colors were found.', 'bad', get('srRunStatus'));
      }
    } catch (error) {
      setStatus(error.message || 'Could not pull colors from logo.', 'bad', get('srRunStatus'));
    }
  }

  function setBrandFields(source = {}, options = {}) {
    setPair('srPrimaryColor', 'srPrimaryHex', source.primaryColor, '#c82828');
    setPair('srSecondaryColor', 'srSecondaryHex', source.secondaryColor, '#960000');
    state.customLogo = source.logoDataUrl || source.logo || null;
    const logoUrl = get('srLogoUrl');
    if (logoUrl) {
      logoUrl.value = options.keepLogoInput && state.customLogo && !String(state.customLogo).startsWith('data:')
        ? state.customLogo
        : '';
    }
    setLogoPreview(state.customLogo);
    updateBrandPreview();
  }
  function applyLoadedBrandingDefaults() {
    state.savedBranding = (state.snapshot && state.snapshot.brandingOverrides) ? { ...state.snapshot.brandingOverrides } : null;
    state.orgBranding = (state.runtimeContext && state.runtimeContext.organization && state.runtimeContext.organization.branding)
      ? { ...state.runtimeContext.organization.branding }
      : null;

    if (state.brandingDirty) {
      updateBrandPreview();
      return;
    }

    if (state.orgBranding) {
      setBrandFields({
        primaryColor: state.orgBranding.colors && state.orgBranding.colors.primary,
        secondaryColor: state.orgBranding.colors && state.orgBranding.colors.secondary,
        logo: state.orgBranding.logo || null
      });
    } else if (state.savedBranding && (state.savedBranding.primaryColor || state.savedBranding.secondaryColor || state.savedBranding.logoDataUrl)) {
      setBrandFields(state.savedBranding);
    } else {
      setBrandFields({});
    }
  }
  function buildBaseOptions() {
    const customerName = String(get('srCustomerName')?.value || '').trim() || 'Test Customer';
    const options = {
      download: !!get('srAutoDownload')?.checked,
      skipUpload: true,
      skipStatusUpdate: true
    };

    if (customerName) {
      options.statePatch = {
        report: {
          ...(state.snapshot?.report || {}),
          resident: {
            ...((state.snapshot?.report && state.snapshot.report.resident) || {}),
            name: customerName
          }
        }
      };
    }

    return options;
  }
  function buildSummaryBrandingOptions() {
    const options = {};
    const hasOrg = !!orgBranding();

    if (hasOrg) {
      options.useProjectOrganizationBranding = true;
      options.clearBrandingOverrides = true;
    }

    if (state.brandingDirty) {
      options.brandingOverrides = {
        primaryColor: hex(get('srPrimaryHex')?.value, '#c82828'),
        secondaryColor: hex(get('srSecondaryHex')?.value, '#960000'),
        logoDataUrl: state.customLogo || null
      };
      if (!hasOrg) options.clearBrandingOverrides = true;
    }

    return options;
  }
  function buildFullDefaultBrandingOptions() {
    return {
      clearBrandingOverrides: true,
      disableOrganizationBranding: true,
      applyBrandingToFull: false
    };
  }
  function renderDownloads(results) {
    const host = get('srDownloads');
    if (!host) return;
    clearUrls();
    if (!Array.isArray(results) || !results.length) {
      host.innerHTML = '';
      return;
    }

    host.innerHTML = results.map((entry) => {
      const url = URL.createObjectURL(entry.result.blob);
      state.urls.push(url);
      return `
        <div class="sr-download">
          <div>
            <div class="sr-download-name">${esc(entry.result.filename)}</div>
            <div class="sr-download-meta">${esc(entry.mode)} &middot; ${esc(fmtBytes(entry.result.blob.size))}</div>
          </div>
          <a class="sr-link secondary" href="${url}" download="${esc(entry.result.filename)}">Download PDF</a>
        </div>
      `;
    }).join('');
  }

  function renderPagination() {
    const c = ctx();
    if (!c.pagination) return;
    const info = state.pagination || { current_page: 1, total_pages: 1, total_count: 0 };
    c.pagination.innerHTML = `
      <div class="sr-info">${esc(info.total_count)} projects &middot; Page ${esc(info.current_page)} of ${esc(info.total_pages)}</div>
      <div class="sr-inline">
        <button class="sr-page-btn" type="button" id="srPrevPage" ${info.current_page <= 1 ? 'disabled' : ''}>Previous</button>
        <button class="sr-page-btn" type="button" id="srNextPage" ${info.current_page >= info.total_pages ? 'disabled' : ''}>Next</button>
      </div>
    `;
    const prev = get('srPrevPage');
    const next = get('srNextPage');
    if (prev) prev.onclick = () => { if (state.page > 1) { state.page -= 1; fetchProjects(); } };
    if (next) next.onclick = () => { if (state.pagination && state.page < state.pagination.total_pages) { state.page += 1; fetchProjects(); } };
  }

  function detailProject() {
    return state.projects.find((item) => item.id === state.selectedId) || null;
  }

  function renderList() {
    const c = ctx();
    const favorites = favoriteSet();
    const favoriteLabels = favoriteConfigMap();
    const canManagePins = isSampleReportsAdmin();
    if (!c.results || !c.summary) return;
    c.summary.textContent = state.loading ? 'Loading...' : `${state.pagination?.total_count || 0} ready samples`;

    if (state.loading) {
      c.results.innerHTML = '<div class="sr-empty">Loading sample projects...</div>';
      c.pagination.innerHTML = '';
      return;
    }

    if (!state.projects.length) {
      const emptyMessage = state.searchNotice || (isSampleReportsAdmin()
        ? 'No sample-ready projects match this search yet.'
        : 'No pinned favorite samples are available for this account yet.');
      c.results.innerHTML = `<div class="sr-empty">${esc(emptyMessage)}</div>`;
      c.pagination.innerHTML = '';
      return;
    }

    c.results.innerHTML = state.projects.map((item) => `
      <button class="sr-result ${item.id === state.selectedId ? 'active' : ''}" type="button" data-folder="${esc(item.id)}">
        <div class="sr-thumb">${item.thumbnail ? `<img src="${esc(item.thumbnail)}" alt="">` : 'No Image'}</div>
        <div style="text-align:left;">
          <div class="sr-title">${esc(item.address || item.id)}</div>
          <div class="sr-meta">
            Issuer: ${esc(item.issuer_name || item.owner_email || '-')}<br>
            Date: ${esc(fmtDate(item.uploaded_at || item.completed_at || item.created_at))}
          </div>
          <div class="sr-badges">
            <span class="sr-pill ${esc(item.project_type)}">${esc(typeLabel(item.project_type))}</span>
            <span class="sr-pill snapshot">Snapshot</span>
            ${item.has_saved_report ? '<span class="sr-pill saved">Saved PDF</span>' : ''}
            ${favorites.has(item.id) ? '<span class="sr-pill favorite">Favorite</span>' : ''}
            ${favoriteLabels.get(item.id)?.label ? `<span class="sr-pill favorite">${esc(favoriteLabels.get(item.id).label)}</span>` : ''}
          </div>
        </div>
        ${canManagePins ? `<span class="sr-pin ${favorites.has(item.id) ? 'active' : ''}${state.favoriteBusy ? ' busy' : ''}" data-favorite-folder="${esc(item.id)}" data-favorite-active="${favorites.has(item.id) ? '1' : '0'}" title="${favorites.has(item.id) ? 'Unpin favorite' : 'Pin favorite'}"><i class="fas fa-thumbtack"></i></span>` : ''}
      </button>
    `).join('');

    c.results.querySelectorAll('[data-folder]').forEach((btn) => {
      btn.addEventListener('click', () => selectProject(btn.getAttribute('data-folder') || ''));
    });
    c.results.querySelectorAll('[data-favorite-folder]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const folderId = btn.getAttribute('data-favorite-folder') || '';
        const nextState = btn.getAttribute('data-favorite-active') !== '1';
        toggleFavorite(folderId, nextState).catch(() => {});
      });
    });

    renderPagination();
  }
  async function fetchProjects() {
    const c = ctx();
    state.loading = true;
    renderList();
    if (c.refresh) c.refresh.disabled = true;

    try {
      const res = await api({
        action: 'list_sample_projects',
        search: state.search,
        project_type: state.type,
        report_state: state.reportState,
        page: state.page,
        limit: state.limit
      });
      if (!res || !res.success) throw new Error(res?.error || 'Could not load sample projects');

      state.projects = Array.isArray(res.projects) ? res.projects : [];
      state.favoriteIds = Array.isArray(res.favorite_ids) ? res.favorite_ids : [];
      state.favoriteConfigs = normalizeFavoriteConfigs(res.favorite_configs);
      state.searchNotice = String(res.search_notice || '').trim();
      state.pagination = res.pagination || { current_page: 1, total_pages: 1, total_count: state.projects.length, limit: state.limit };
      if (!state.projects.some((p) => p.id === state.selectedId)) {
        state.selectedId = state.projects[0]?.id || null;
      }
      renderList();
      if (state.selectedId) {
        await loadBundle(state.selectedId, { preserveStatus: true });
      } else {
        renderDetail();
      }
    } catch (error) {
      state.projects = [];
      state.searchNotice = '';
      state.pagination = { current_page: 1, total_pages: 1, total_count: 0, limit: state.limit };
      renderList();
      const detail = get('srDetail');
      if (detail) detail.innerHTML = `<div class="sr-status bad">${esc(error.message || 'Could not load sample projects.')}</div>`;
      if (c.empty) c.empty.style.display = 'none';
      if (detail) detail.style.display = 'block';
    } finally {
      state.loading = false;
      if (state.projects.length) state.searchNotice = '';
      renderList();
      if (c.refresh) c.refresh.disabled = false;
    }
  }

  async function loadBundle(folderId, options = {}) {
    if (!folderId) return;
    state.selectedId = folderId;
    renderList();

    const c = ctx();
    if (c.empty) c.empty.style.display = 'none';
    if (c.detail) {
      c.detail.style.display = 'block';
      c.detail.innerHTML = '<div class="sr-status">Loading project sample bundle...</div>';
    }

    const res = await api({ action: 'load_sample_project_bundle', folder: folderId });
    if (!res || !res.success) throw new Error(res?.error || 'Could not load this sample project');
    const snapshotUrl = String(res.pdf_state_asset || '').trim();
    if (!snapshotUrl) throw new Error('This project does not have a saved PDF snapshot');

    const separator = snapshotUrl.includes('?') ? '&' : '?';
    const snapshot = await fetchJson(`${snapshotUrl}${separator}t=${Date.now()}`);
    state.bundle = res;
    state.snapshot = snapshot;
    state.runtimeContext = {
      folderId: res.folder || folderId,
      manifest: res.manifest || null,
      organization: res.organization || null
    };
    state.lastResults = [];
    clearUrls();
    state.brandingDirty = false;
    applyLoadedBrandingDefaults();
    renderDetail();

    if (!options.preserveStatus) {
      setStatus('Ready to generate temporary branded sample PDFs.', 'good', get('srRunStatus'));
    }
  }

  function renderDetail() {
    const c = ctx();
    const project = detailProject();
    if (!c.detail || !c.empty) return;

    if (!project || !state.bundle || !state.snapshot) {
      c.empty.style.display = 'flex';
      c.detail.style.display = 'none';
      c.detail.innerHTML = '';
      return;
    }

    const manifest = state.bundle.manifest || {};
    const address = manifest.address || project.address || project.id;
    const org = state.runtimeContext?.organization || null;
    const hasSavedBranding = !!(savedBranding() && (savedBranding().primaryColor || savedBranding().secondaryColor || savedBranding().logoDataUrl));
    const hasOrgBranding = !!orgBranding();

    c.empty.style.display = 'none';
    c.detail.style.display = 'block';
    c.detail.innerHTML = `
      <div class="sr-hero">
        <div class="sr-thumb">${project.thumbnail ? `<img src="${esc(project.thumbnail)}" alt="">` : 'No Image'}</div>
        <div>
          <h2 class="sr-big">${esc(address)}</h2>
          <div class="sr-sub">
            ${esc(typeLabel(project.project_type))} sample<br>
            Issuer: ${esc(project.issuer_name || project.owner_email || '-')}<br>
            Uploaded: ${esc(fmtDate(project.uploaded_at || project.completed_at || project.created_at))}
          </div>
          <div class="sr-badges">
            <span class="sr-pill ${esc(project.project_type)}">${esc(typeLabel(project.project_type))}</span>
            <span class="sr-pill snapshot">Snapshot Ready</span>
            ${project.has_saved_report ? '<span class="sr-pill saved">Saved PDF</span>' : ''}
            ${project.is_favorite ? '<span class="sr-pill favorite">Favorite</span>' : ''}
          </div>
          <div class="sr-links" style="margin-top:14px;">
            ${project.report_url ? `<a class="sr-link secondary" href="${esc(project.report_url)}" target="_blank" rel="noopener">Open Saved PDF</a>` : ''}
            ${state.bundle.pdf_state_asset ? `<a class="sr-link secondary" href="${esc(state.bundle.pdf_state_asset)}" target="_blank" rel="noopener">Open pdf_state.json</a>` : ''}
          </div>
        </div>
      </div>

      <div class="sr-facts">
        <div class="sr-fact"><div class="sr-fact-label">Project Type</div><div class="sr-fact-value">${esc(typeLabel(project.project_type))}</div></div>
        <div class="sr-fact"><div class="sr-fact-label">Organization</div><div class="sr-fact-value">${esc(org?.name || 'None')}</div></div>
        <div class="sr-fact"><div class="sr-fact-label">Faces</div><div class="sr-fact-value">${esc((state.snapshot.facesData || []).length)}</div></div>
        <div class="sr-fact"><div class="sr-fact-label">Structures</div><div class="sr-fact-value">${esc((state.snapshot.structures || []).length)}</div></div>
      </div>

      <div class="sr-box">
        <div class="sr-head" style="margin-bottom:10px;">
          <div><h3 style="margin:0;">Branding</h3><div class="sr-sub">Company branding loads by default for the summary sample when available. Full report samples always use default branding.</div></div>
        </div>
        <div class="sr-grid">
          <label>
            Primary Color
            <div class="sr-color">
              <input id="srPrimaryColor" type="color" value="#c82828">
              <input id="srPrimaryHex" class="sr-input" type="text" value="#c82828" placeholder="#c82828">
            </div>
          </label>
          <label>
            Secondary Color
            <div class="sr-color">
              <input id="srSecondaryColor" type="color" value="#960000">
              <input id="srSecondaryHex" class="sr-input" type="text" value="#960000" placeholder="#960000">
            </div>
          </label>
          <label>
            Custom Logo File
            <input id="srLogoFile" class="sr-input" type="file" accept="image/*">
          </label>
          <label>
            Logo URL Override
            <input id="srLogoUrl" class="sr-input" type="text" placeholder="Temporary logo URL override">
          </label>
        </div>
        <div class="sr-inline" style="margin-top:12px;">
          <label class="sr-switch-row" for="srAutoBrandFromLogo" style="flex:1;">
            <span>Auto-pull colors from logo</span>
            <span class="sr-switch">
              <input id="srAutoBrandFromLogo" class="sr-switch-input" type="checkbox" ${state.autoBrandFromLogo ? 'checked' : ''}>
              <span class="sr-switch-slider"></span>
            </span>
          </label>
        </div>
        <div class="sr-brand-actions" style="margin-top:12px;">
          <button id="srUseOrgBranding" class="sr-mini" type="button">Use company branding</button>
          <button id="srUseSavedBranding" class="sr-mini" type="button">Use saved branding</button>
          <button id="srClearBranding" class="sr-mini" type="button">Reset to default</button>
        </div>
        <div class="sr-preview">
          <div>
            <div class="sr-swatches">
              <span class="sr-swatch" id="srPrimarySwatch"></span>
              <span class="sr-swatch" id="srSecondarySwatch"></span>
            </div>
            <div class="sr-note" id="srBrandNote"></div>
            <div class="sr-note">
              Saved branding: <strong>${hasSavedBranding ? 'Yes' : 'No'}</strong> &middot; Company branding: <strong>${hasOrgBranding ? 'Yes' : 'No'}</strong>
            </div>
          </div>
          <img id="srLogoPreview" class="sr-logo empty" alt="Brand logo preview">
        </div>
      </div>

      <div class="sr-box">
        <div class="sr-head" style="margin-bottom:10px;">
          <div><h3 style="margin:0;">Generate Sample PDF</h3><div class="sr-sub">Generate and download a temporary sample. This never saves over the main project report or organization branding.</div></div>
        </div>
        <div class="sr-grid">
          <label>
            Customer Name Override
            <input id="srCustomerName" class="sr-input" type="text" value="Test Customer" placeholder="Test Customer">
          </label>
          <label class="sr-switch-row" for="srAutoDownload" style="align-self:end;">
            <span>Download automatically</span>
            <span class="sr-switch">
              <input id="srAutoDownload" class="sr-switch-input" type="checkbox" ${state.autoDownload ? 'checked' : ''}>
              <span class="sr-switch-slider"></span>
            </span>
          </label>
        </div>
        <div class="sr-actions" style="margin-top:12px;">
          <button id="srGenerateFull" class="sr-action" type="button">Generate Full</button>
          <button id="srGenerateSummary" class="sr-action secondary" type="button">Generate Summary</button>
          <button id="srGenerateBoth" class="sr-action secondary" type="button">Generate Both</button>
        </div>
        <div id="srRunStatus" class="sr-status">Ready.</div>
        <div id="srDownloads" class="sr-downloads"></div>
        <div class="sr-hint">If the browser blocks automatic downloads, use the Download PDF links shown here after generation.</div>
      </div>
    `;

    bindDetailEvents();
    applyLoadedBrandingDefaults();
  }
  async function selectProject(folderId) {
    if (!folderId || state.busy) return;
    try {
      await loadBundle(folderId);
    } catch (error) {
      const c = ctx();
      if (c.empty) c.empty.style.display = 'none';
      if (c.detail) {
        c.detail.style.display = 'block';
        c.detail.innerHTML = `<div class="sr-status bad">${esc(error.message || 'Could not load this sample project.')}</div>`;
      }
    }
  }

  async function generate(modeChoice) {
    if (!state.snapshot || !state.runtimeContext) {
      throw new Error('Choose a sample project first.');
    }

    const statusEl = get('srRunStatus');
    updateBrandPreview();
    setBusy(true);
    setStatus(`Generating ${modeChoice} sample PDF${modeChoice === 'both' ? 's' : ''}...`, '', statusEl);

    try {
      const isBoth = modeChoice === 'both';
      const baseOptions = buildBaseOptions();
      const options = isBoth
        ? {
            ...baseOptions,
            outputs: [
              { mode: 'full', ...buildFullDefaultBrandingOptions() },
              { mode: 'summary', ...buildSummaryBrandingOptions() }
            ]
          }
        : {
            ...baseOptions,
            ...(modeChoice === 'full' ? buildFullDefaultBrandingOptions() : buildSummaryBrandingOptions())
          };
      options.onStatus = (payload) => {
        const message = typeof payload === 'string' ? payload : payload?.message;
        if (message) setStatus(message, '', statusEl);
      };

      const runner = isBoth
        ? window.FirstMatePDFStandalone.generateProjectPdfsFromSnapshot
        : window.FirstMatePDFStandalone.generateProjectPdfFromSnapshot;

      const generated = await runner(
        state.snapshot,
        state.runtimeContext,
        isBoth
          ? options
          : { ...options, mode: modeChoice }
      );

      state.lastResults = Array.isArray(generated) ? generated : [{ mode: modeChoice, ...generated }];
      renderDownloads(state.lastResults);
      const summary = state.lastResults.map((entry) => `${entry.result.filename} (${fmtBytes(entry.result.blob.size)})`).join(', ');
      setStatus(`Sample PDF ready: ${summary}`, 'good', statusEl);
    } catch (error) {
      setStatus(error.message || 'Sample generation failed.', 'bad', statusEl);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function toggleFavorite(folderId, makeFavorite) {
    if (!folderId || state.favoriteBusy || state.loading) return;
    state.favoriteBusy = true;
    try {
      const payload = {
        action: 'toggle_sample_favorite',
        folder: folderId,
        favorite: makeFavorite ? '1' : '0'
      };
      if (makeFavorite) {
        const project = state.projects.find((item) => item.id === folderId) || {};
        const existingLabel = favoriteConfigMap().get(folderId)?.label || '';
        const suggested = existingLabel || String(project.address || project.id || 'Sample Report').trim();
        const entered = window.prompt('Name this pinned sample so it shows up clearly in lead email attachments.', suggested);
        if (entered === null) throw new Error('__pin_cancelled__');
        const label = String(entered || '').trim();
        if (!label) throw new Error('Enter a name for this pinned sample.');
        payload.label = label;
      }
      const res = await api(payload);
      if (!res || !res.success) throw new Error(res?.error || 'Could not save favorite');
      state.favoriteIds = Array.isArray(res.favorite_ids) ? res.favorite_ids : [];
      state.favoriteConfigs = normalizeFavoriteConfigs(res.favorite_configs);
      state.page = 1;
      await fetchProjects();
      setStatus(makeFavorite ? 'Pinned to favorites for quick sample access.' : 'Removed from sample favorites.', 'good', get('srRunStatus'));
    } catch (error) {
      if (String(error?.message || '') === '__pin_cancelled__') return;
      setStatus(error.message || 'Could not save favorite.', 'bad', get('srRunStatus'));
      throw error;
    } finally {
      state.favoriteBusy = false;
      renderList();
    }
  }
  function bindDetailEvents() {
    const sync = (colorId, textId, fallback) => {
      const colorInput = get(colorId);
      const textInput = get(textId);
      if (!colorInput || !textInput) return;
      colorInput.addEventListener('input', () => {
        state.brandingDirty = true;
        textInput.value = colorInput.value;
        updateBrandPreview();
      });
      textInput.addEventListener('input', () => {
        state.brandingDirty = true;
        const normalized = hex(textInput.value, fallback);
        if (normalized) colorInput.value = normalized;
        updateBrandPreview();
      });
      textInput.addEventListener('blur', () => {
        const normalized = hex(textInput.value, fallback);
        colorInput.value = normalized;
        textInput.value = normalized;
        updateBrandPreview();
      });
    };

    sync('srPrimaryColor', 'srPrimaryHex', '#c82828');
    sync('srSecondaryColor', 'srSecondaryHex', '#960000');

    get('srLogoFile')?.addEventListener('change', () => {
      const file = get('srLogoFile')?.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (event) => {
        state.brandingDirty = true;
        state.customLogo = event.target?.result ? String(event.target.result) : null;
        const urlInput = get('srLogoUrl');
        if (urlInput) urlInput.value = '';
        setLogoPreview(state.customLogo);
        updateBrandPreview();
        await maybeAutoApplyLogoPalette(state.customLogo);
      };
      reader.readAsDataURL(file);
      get('srLogoFile').value = '';
    });

    get('srLogoUrl')?.addEventListener('input', () => {
      state.brandingDirty = true;
      state.customLogo = String(get('srLogoUrl')?.value || '').trim() || null;
      setLogoPreview(state.customLogo);
      updateBrandPreview();
    });

    get('srAutoBrandFromLogo')?.addEventListener('change', () => {
      const enabled = !!get('srAutoBrandFromLogo')?.checked;
      state.autoBrandFromLogo = enabled;
      writeStoredToggle(AUTO_LOGO_BRANDING_KEY, enabled);
    });

    get('srAutoDownload')?.addEventListener('change', () => {
      const enabled = !!get('srAutoDownload')?.checked;
      state.autoDownload = enabled;
      writeStoredToggle(AUTO_DOWNLOAD_KEY, enabled);
    });

    get('srUseSavedBranding')?.addEventListener('click', () => {
      const saved = savedBranding();
      if (!saved) {
        setStatus('This snapshot does not have saved branding overrides.', 'bad', get('srRunStatus'));
        return;
      }
      state.brandingDirty = false;
      setBrandFields(saved);
    });

    get('srUseOrgBranding')?.addEventListener('click', () => {
      const org = orgBranding();
      if (!org) {
        setStatus('This project does not have company branding loaded.', 'bad', get('srRunStatus'));
        return;
      }
      state.brandingDirty = false;
      setBrandFields({
        primaryColor: org.colors && org.colors.primary,
        secondaryColor: org.colors && org.colors.secondary,
        logo: org.logo || null
      });
    });

    get('srClearBranding')?.addEventListener('click', () => {
      state.brandingDirty = false;
      applyLoadedBrandingDefaults();
    });

    get('srGenerateFull')?.addEventListener('click', () => generate('full').catch(() => {}));
    get('srGenerateSummary')?.addEventListener('click', () => generate('summary').catch(() => {}));
    get('srGenerateBoth')?.addEventListener('click', () => generate('both').catch(() => {}));
  }
  function bindTopLevelEvents() {
    if (state.initialized) return;
    state.initialized = true;
    const c = ctx();
    c.refresh?.addEventListener('click', () => fetchProjects());
    c.search?.addEventListener('input', () => {
      clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        state.search = String(c.search.value || '').trim();
        state.page = 1;
        fetchProjects();
      }, 220);
    });
    c.reportState?.addEventListener('change', () => {
      state.reportState = String(c.reportState.value || 'all');
      state.page = 1;
      fetchProjects();
    });
    get('srTypes')?.querySelectorAll('[data-type]').forEach((btn) => {
      btn.addEventListener('click', () => {
        get('srTypes')?.querySelectorAll('.sr-seg').forEach((seg) => seg.classList.remove('active'));
        btn.classList.add('active');
        state.type = String(btn.getAttribute('data-type') || 'all');
        state.page = 1;
        fetchProjects();
      });
    });
  }

  async function onShow() {
    ensureStyles();
    ensureMarkup();
    bindTopLevelEvents();
    if (!state.projects.length && !state.loading) {
      await fetchProjects();
    } else {
      renderList();
      renderDetail();
    }
  }

  window.SampleReports = { onShow };
})();

