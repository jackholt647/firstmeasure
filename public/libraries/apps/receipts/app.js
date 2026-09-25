/* public/libraries/apps/receipts/app.js
 * Shared receipt browser for the global portal and project Money workspace.
 * Gallery layout, grouping, search, and density controls are provided by PhotoFeed.
 */
(function(){
  const Portal = window.Portal;
  const runtime = window.FirstMateEmbeddableApps;
  if (!Portal) return;

  const util = Portal.util || {};
  const escapeHtml = util.escapeHtml || ((value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[match])));
  const injectCSS = util.injectCSS || (() => {});
  const showToast = Portal.ui?.showToast || (() => {});

  function cleanText(...values){
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (text) return text;
    }
    return '';
  }

  function orgId(context = {}){
    return cleanText(context.orgId, context.organizationId, window.__APP?.userOrgId, window.__APP?.orgId, Portal.cfg?.userOrgId, Portal.cfg?.orgId);
  }

  function money(value, currency = 'USD'){
    return new Intl.NumberFormat((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), {
      style:'currency', currency:cleanText(currency || 'USD').toUpperCase() || 'USD',
      minimumFractionDigits:0, maximumFractionDigits:2
    }).format((Number(value) || 0) / 100);
  }

  function dateTime(value){
    const date = new Date(cleanText(value));
    return Number.isNaN(date.getTime()) ? cleanText(value) : date.toLocaleString([], { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' });
  }

  function shortDate(value){
    const text = cleanText(value);
    if (!text) return 'Not captured';
    const date = new Date(`${text}T12:00:00`);
    return Number.isNaN(date.getTime()) ? text : date.toLocaleDateString([], { month:'short', day:'numeric', year:'numeric' });
  }

  function fileSize(bytes){
    const value = Math.max(0, Number(bytes) || 0);
    if (!value) return 'Unknown size';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
    return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }

  function receiptTotal(receipt = {}){
    return Number(receipt.total_cents ?? receipt.effective?.total_cents ?? receipt.extraction?.total_cents ?? 0) || 0;
  }

  function receiptTitle(receipt = {}){
    return cleanText(receipt.title, receipt.effective?.title, receipt.extraction?.title, receipt.file?.file_name, 'Receipt');
  }

  function receiptContentType(receipt = {}){
    return cleanText(receipt.file?.content_type, receipt.library_document?.content_type).toLowerCase();
  }

  function receiptFileUrl(oid, receipt, inline = false){
    if (!receipt?.id) return '';
    if (window.PaymentsAPI?.receipts?.fileUrl) return window.PaymentsAPI.receipts.fileUrl(oid, receipt.id, { inline });
    const base = cleanText(receipt.file_url);
    if (!base) return '';
    return inline ? `${base}${base.includes('?') ? '&' : '?'}inline=1` : base;
  }

  function normalizeProjectDocument(document = {}){
    const data = document?.data && typeof document.data === 'object' ? document.data : document;
    const id = cleanText(data.platform_project_id, data.base_project_id, data.id, document.id);
    return {
      ...data,
      id,
      platform_project_id:cleanText(data.platform_project_id, id),
      base_project_id:cleanText(data.base_project_id, id),
      title:cleanText(data.title, data.project_title, data.project_name, data.address, id),
      address:cleanText(data.address, data.project_address)
    };
  }

  function projectId(project = {}){
    return cleanText(project.platform_project_id, project.base_project_id, project.id);
  }

  function uploader(receipt = {}){
    return receipt.uploaded_by && typeof receipt.uploaded_by === 'object' ? receipt.uploaded_by : {};
  }

  function adaptReceipt(receipt, oid){
    const up = uploader(receipt);
    return {
      id:cleanText(receipt.id),
      media_id:cleanText(receipt.id),
      label:receiptTitle(receipt),
      alt:receiptTitle(receipt),
      uploaded_at:cleanText(receipt.uploaded_at, receipt.created_at),
      created_at:cleanText(receipt.created_at, receipt.uploaded_at),
      uploaded_by:{ id:cleanText(up.user_id), user_id:cleanText(up.user_id), name:cleanText(up.name, 'Unknown uploader'), email:cleanText(up.email) },
      metadata:{
        uploaded_by_user_id:cleanText(up.user_id),
        uploaded_by_name:cleanText(up.name, 'Unknown uploader'),
        uploaded_by_email:cleanText(up.email),
        receipt_status:cleanText(receipt.status),
        receipt_total:money(receiptTotal(receipt), receipt.currency)
      },
      src:receiptFileUrl(oid, receipt, true),
      thumb:receiptContentType(receipt).startsWith('image/') ? receiptFileUrl(oid, receipt, true) : '',
      receipt
    };
  }

  function galleryProjects(receipts, projects, scopedProject, oid){
    if (scopedProject) {
      return [{
        ...scopedProject,
        photos:(receipts || []).map((receipt) => adaptReceipt(receipt, oid))
      }].filter((project) => project.photos.length);
    }
    const byId = new Map((projects || []).map((project) => [projectId(project), { ...project, photos:[] }]));
    const unassigned = { id:'unassigned_receipts', title:(globalThis.PlatformLanguage?.text("receipts","m_ffcb17b666c31b","Unassigned receipts") ?? "Unassigned receipts"), address:'Not attached to a project', photos:[] };
    (receipts || []).forEach((receipt) => {
      const id = cleanText(receipt.project_id);
      let project = id ? byId.get(id) : null;
      if (!project && id) {
        const association = (receipt.associations || []).find((item) => cleanText(item?.kind) === 'project' && cleanText(item?.id) === id) || {};
        project = { id, title:cleanText(association.name, `Project ${id}`), address:'', photos:[] };
        byId.set(id, project);
      }
      (project || unassigned).photos.push(adaptReceipt(receipt, oid));
    });
    return [...byId.values(), ...(unassigned.photos.length ? [unassigned] : [])].filter((project) => project.photos.length);
  }

  function fileIcon(receipt = {}){
    const type = receiptContentType(receipt);
    const name = cleanText(receipt.file?.file_name).toLowerCase();
    if (type.includes('pdf') || name.endsWith('.pdf')) return { icon:'fa-file-pdf', label:(globalThis.PlatformLanguage?.text("receipts","m_2440c46d7ac5f3","PDF") ?? "PDF") };
    if (type.startsWith('image/')) return { icon:'fa-file-image', label:(globalThis.PlatformLanguage?.text("receipts","m_54eb8e1b237591","Image") ?? "Image") };
    if (type.includes('sheet') || /\.(xls|xlsx|csv|tsv)$/.test(name)) return { icon:'fa-file-excel', label:(globalThis.PlatformLanguage?.text("receipts","m_1aeca89f7f75bf","Spreadsheet") ?? "Spreadsheet") };
    if (type.includes('word') || /\.(doc|docx|odt|rtf)$/.test(name)) return { icon:'fa-file-word', label:(globalThis.PlatformLanguage?.text("receipts","m_9c9b98b1f4e8c9","Document") ?? "Document") };
    return { icon:'fa-file-lines', label:(name.split('.').pop() || 'File').toUpperCase() };
  }

  function thumbnailHtml(item){
    const receipt = item.photo.receipt || {};
    const type = receiptContentType(receipt);
    const url = receiptFileUrl(item.photo.__receiptOrgId || '', receipt, true) || item.photo.thumb;
    const fallback = fileIcon(receipt);
    return `${type.startsWith('image/') && url
      ? `<img loading="lazy" draggable="false" src="${escapeHtml(url)}" alt="${escapeHtml(receiptTitle(receipt))}">`
      : `<span class="rb-file-thumb"><i class="fas ${fallback.icon}"></i><small>${escapeHtml(fallback.label)}</small></span>`}
      <span class="rb-total">${escapeHtml(money(receiptTotal(receipt), receipt.currency))}</span>
      <span class="rb-status ${escapeHtml(cleanText(receipt.status).toLowerCase())}">${escapeHtml(cleanText(receipt.status, 'ready').replace(/_/g, ' '))}</span>`;
  }

  function tileMeta(item){
    const receipt = item.photo.receipt || {};
    const up = uploader(receipt);
    return `${escapeHtml(cleanText(up.name, 'Unknown uploader'))}<br>${escapeHtml(dateTime(receipt.uploaded_at || receipt.created_at))}`;
  }

  function groupUploaders(group){
    const names = [...new Set((group.items || []).map((item) => cleanText(uploader(item.photo?.receipt).name, uploader(item.photo?.receipt).email)).filter(Boolean))];
    const label = names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
    return `<i class="fas fa-user"></i> ${escapeHtml(label || 'Unknown uploader')}`;
  }

  function viewerPreview(receipt, oid){
    const url = receiptFileUrl(oid, receipt, true);
    const type = receiptContentType(receipt);
    if (type.startsWith('image/') && url) return `<img src="${escapeHtml(url)}" alt="${escapeHtml(receiptTitle(receipt))}">`;
    if ((type.includes('pdf') || cleanText(receipt.file?.file_name).toLowerCase().endsWith('.pdf')) && url) {
      return `<div class="rb-pdf-loading" data-rb-pdf-preview data-url="${String(escapeHtml(url))}" data-title="${String(escapeHtml(receiptTitle(receipt)))}"><i class="fas fa-circle-notch fa-spin"></i><span>${(globalThis.PlatformLanguage?.text("receipts","m_2f28a7c40a3d7b","Loading PDF preview...") ?? "Loading PDF preview...")}</span></div>`;
    }
    const fallback = fileIcon(receipt);
    return `<div class="rb-preview-fallback"><i class="fas ${String(fallback.icon)}"></i><strong>${String(escapeHtml(receipt.file?.file_name || receiptTitle(receipt)))}</strong><span>${(globalThis.PlatformLanguage?.text("receipts","m_2bb59098fa865a","Preview is not available for this file type.") ?? "Preview is not available for this file type.")}</span>${String(url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener"><i class="fas fa-arrow-up-right-from-square"></i> Open file</a>` : '')}</div>`;
  }

  function detailRow(label, value){
    return `<div class="rb-detail"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || '—')}</strong></div>`;
  }

  function openViewer(options = {}){
    const items = Array.isArray(options.items) ? options.items : [];
    let index = Math.max(0, Math.min(Number(options.index || 0), Math.max(0, items.length - 1)));
    const oid = cleanText(options.orgId);
    const shade = document.createElement('div');
    shade.className = 'rb-viewer-shade';
    let closed = false;
    let previewObjectUrl = '';
    let previewGeneration = 0;

    const clearPreviewObjectUrl = () => {
      if (!previewObjectUrl) return;
      URL.revokeObjectURL(previewObjectUrl);
      previewObjectUrl = '';
    };
    const loadPdfPreview = async () => {
      const preview = shade.querySelector('[data-rb-pdf-preview]');
      if (!preview) return;
      const generation = ++previewGeneration;
      const url = cleanText(preview.dataset.url);
      try {
        const response = await fetch(url, { credentials:'include' });
        if (!response.ok) throw new Error(`PDF request failed (${response.status})`);
        const blob = await response.blob();
        if (closed || generation !== previewGeneration || !preview.isConnected) return;
        clearPreviewObjectUrl();
        previewObjectUrl = URL.createObjectURL(blob.type === 'application/pdf' ? blob : new Blob([blob], { type:'application/pdf' }));
        const frame = document.createElement('iframe');
        frame.src = previewObjectUrl;
        frame.title = cleanText(preview.dataset.title, 'Receipt PDF');
        preview.replaceWith(frame);
      } catch (_) {
        if (closed || generation !== previewGeneration || !preview.isConnected) return;
        preview.className = 'rb-preview-fallback';
        preview.innerHTML = `<i class="fas fa-file-pdf"></i><strong>${(globalThis.PlatformLanguage?.text("receipts","m_fd2d77217bda32","PDF preview could not be loaded.") ?? "PDF preview could not be loaded.")}</strong><span>${(globalThis.PlatformLanguage?.text("receipts","m_2b3fdb0048c38f","You can still open the original file.") ?? "You can still open the original file.")}</span><a href="${String(escapeHtml(url))}" target="_blank" rel="noopener"><i class="fas fa-arrow-up-right-from-square"></i>${(globalThis.PlatformLanguage?.text("receipts","m_39f4f4e9015b56"," Open PDF") ?? " Open PDF")}</a>`;
      }
    };

    const current = () => items[index] || null;
    const close = ({ fromRoute = false } = {}) => {
      if (closed) return;
      closed = true;
      previewGeneration += 1;
      clearPreviewObjectUrl();
      shade.remove();
      if (!fromRoute) options.onClose?.();
    };
    const move = (delta) => {
      if (items.length < 2) return;
      index = (index + delta + items.length) % items.length;
      options.onChange?.(current()?.photo?.receipt || {}, index);
      render();
    };
    const render = () => {
      previewGeneration += 1;
      clearPreviewObjectUrl();
      const item = current();
      const receipt = item?.photo?.receipt || {};
      const project = item?.project || {};
      const up = uploader(receipt);
      const extraction = receipt.extraction && typeof receipt.extraction === 'object' ? receipt.extraction : {};
      const lineItems = Array.isArray(extraction.line_items) ? extraction.line_items : [];
      shade.innerHTML = `<div class="rb-viewer" role="dialog" aria-modal="true" aria-label="${(globalThis.PlatformLanguage?.text("receipts","m_f89d381acbcc37","Receipt viewer") ?? "Receipt viewer")}">
        <div class="rb-viewer-main">
          <div class="rb-viewer-head"><div><strong>${String(escapeHtml(receiptTitle(receipt)))}</strong><span>${String(escapeHtml(project.title || project.address || 'Unassigned receipt'))}</span></div><div class="rb-viewer-actions">${String(items.length > 1 ? `<button type="button" data-rb-prev aria-label="Previous receipt"><i class="fas fa-chevron-left"></i></button><span>${index + 1} / ${items.length}</span><button type="button" data-rb-next aria-label="Next receipt"><i class="fas fa-chevron-right"></i></button>` : '')}<button type="button" data-rb-close aria-label="${(globalThis.PlatformLanguage?.text("receipts","m_d3a748c417dd97","Close receipt viewer") ?? "Close receipt viewer")}"><i class="fas fa-xmark"></i></button></div></div>
          <div class="rb-preview">${String(viewerPreview(receipt, oid))}</div>
        </div>
        <aside class="rb-viewer-side">
          <div class="rb-side-total"><span>${(globalThis.PlatformLanguage?.text("receipts","m_aec930d3adcf4c","Receipt total") ?? "Receipt total")}</span><strong>${String(escapeHtml(money(receiptTotal(receipt), receipt.currency)))}</strong><em class="rb-status ${String(escapeHtml(cleanText(receipt.status).toLowerCase()))}">${String(escapeHtml(cleanText(receipt.status, 'ready').replace(/_/g, ' ')))}</em></div>
          <section><h3>${(globalThis.PlatformLanguage?.text("receipts","m_520b16e1201e75","Receipt details") ?? "Receipt details")}</h3>${String(detailRow('Vendor', cleanText(extraction.vendor_name, receiptTitle(receipt))))}${String(detailRow('Purchase date', shortDate(receipt.purchase_date || receipt.effective?.purchase_date)))}${String(detailRow('Uploaded by', cleanText(up.name, up.email, 'Unknown uploader')))}${String(detailRow('Uploaded', dateTime(receipt.uploaded_at || receipt.created_at)))}${String(detailRow('Project', cleanText(project.title, project.address, 'Unassigned')))}</section>
          <section><h3>${(globalThis.PlatformLanguage?.text("receipts","m_fa09b3f3085cdc","File") ?? "File")}</h3>${String(detailRow('Name', receipt.file?.file_name))}${String(detailRow('Type', receiptContentType(receipt) || 'Unknown'))}${String(detailRow('Size', fileSize(receipt.file?.size_bytes)))}</section>
          ${String(lineItems.length ? `<section><h3>Extracted line items</h3><div class="rb-lines">${lineItems.slice(0, 12).map((line) => `<div><span>${escapeHtml(cleanText(line.description, line.title, 'Line item'))}</span><strong>${escapeHtml(money(line.total_cents ?? line.amount_cents ?? 0, receipt.currency))}</strong></div>`).join('')}</div></section>` : '')}
          <div class="rb-side-actions">${String(typeof options.onReview === 'function' ? '<button type="button" class="primary" data-rb-review><i class="fas fa-list-check"></i> Review & apply</button>' : '')}${String(receiptFileUrl(oid, receipt) ? `<a href="${escapeHtml(receiptFileUrl(oid, receipt))}"><i class="fas fa-download"></i> Download</a>` : '')}</div>
        </aside>
      </div>`;
      shade.querySelector('[data-rb-close]')?.addEventListener('click', () => close());
      shade.querySelector('[data-rb-prev]')?.addEventListener('click', () => move(-1));
      shade.querySelector('[data-rb-next]')?.addEventListener('click', () => move(1));
      shade.querySelector('[data-rb-review]')?.addEventListener('click', () => options.onReview?.(receipt));
      loadPdfPreview();
    };
    shade.addEventListener('click', (event) => { if (event.target === shade) close(); });
    document.body.appendChild(shade);
    render();
    return { close, receiptId:() => cleanText(current()?.photo?.receipt?.id) };
  }

  function injectStyles(){
    injectCSS('receipt-browser-css', `
      .rb-browser,.rb-browser>.pf-wrap{height:100%;min-height:0}.rb-browser-global{box-sizing:border-box;padding:12px}.rb-browser [data-photo-feed-dynamic]{min-height:0;flex:1;display:flex;flex-direction:column}.rb-browser .pf-wrap{max-width:none}.pf-thumb.rb-receipt-tile{background:#eef2f6}.pf-thumb.rb-receipt-tile.loaded::before{display:none}.rb-file-thumb{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;background:linear-gradient(145deg,#f8fafc,#e9eef5);color:#667085}.rb-file-thumb i{font-size:38px;color:#475467}.rb-file-thumb small{font-size:11px;font-weight:1000;text-transform:uppercase;letter-spacing:.08em}.rb-total{position:absolute;right:7px;top:7px;z-index:3;border-radius:999px;padding:5px 8px;background:rgba(16,24,40,.86);color:#fff;font-size:11px;font-weight:1000;box-shadow:0 4px 12px rgba(15,23,42,.22)}.rb-status{display:inline-flex;width:max-content;border-radius:999px;padding:4px 7px;background:#f2f4f7;color:#475467;font-size:9px;font-style:normal;font-weight:1000;text-transform:capitalize}.pf-thumb>.rb-status{position:absolute;left:7px;top:7px;z-index:3}.rb-status.applied,.rb-status.ready{background:#ecfdf3;color:#067647}.rb-status.processing{background:#eff8ff;color:#175cd3}.rb-status.needs_review{background:#fffaeb;color:#93370d}.rb-status.void,.rb-status.error{background:#fef3f2;color:#b42318}
      .rb-global-app{height:100%;min-height:0;box-sizing:border-box}.rb-global-app [data-receipt-browser]{height:100%;min-height:0}.rb-browser-global .pf-content-layout{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:16px}.rb-browser-global .pf-content-layout>[data-photo-feed-dynamic]{min-width:0;overflow:auto}.rb-browser-global .pf-content-aside{min-width:0;min-height:0;overflow:auto;border-left:1px solid #e4e7ec;padding-left:16px}.rb-reimbursement-queue{display:grid;gap:14px;padding:0 2px 20px}.rb-reimbursement-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.rb-reimbursement-head strong{font-size:16px}.rb-reimbursement-head p{color:#667085;font-size:12px;line-height:1.4;margin:4px 0 0}.rb-reimbursement-count{flex:none;border-radius:999px;background:#f2f4f7;color:#475467;padding:5px 8px;font-size:11px;font-weight:800}.rb-reimbursement-empty{border:1px dashed #d0d5dd;border-radius:11px;padding:22px 14px;text-align:center;color:#667085;font-size:12px;line-height:1.5}.rb-reimbursement-list{display:grid;gap:9px}.rb-reimbursement-card{border:1px solid #e4e7ec;border-radius:12px;padding:12px;display:grid;gap:10px;background:#fff}.rb-reimbursement-card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}.rb-reimbursement-card-head strong{font-size:13px;overflow-wrap:anywhere}.rb-reimbursement-card-head b{font-size:13px;white-space:nowrap}.rb-reimbursement-card-meta{color:#667085;font-size:12px;line-height:1.4;overflow-wrap:anywhere}.rb-reimbursement-actions{display:flex;gap:7px;flex-wrap:wrap}.rb-reimbursement-actions .pf-btn{white-space:normal;text-align:center}.rb-mobile-tabs{display:none}@media(max-width:760px){.rb-browser-global .pf-content-layout{display:flex;flex-direction:column;gap:0}.rb-browser-global .rb-mobile-tabs{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px;margin-bottom:12px;border-radius:11px;background:#eef2f6}.rb-mobile-tabs button{border:0;border-radius:8px;background:transparent;color:#475467;min-height:38px;padding:6px 10px;font-size:12px;font-weight:900;cursor:pointer}.rb-mobile-tabs button[aria-selected="true"]{background:#fff;color:#101828;box-shadow:0 1px 4px rgba(16,24,40,.12)}.rb-global-app[data-mobile-view="receipts"] .pf-content-aside,.rb-global-app[data-mobile-view="reimbursements"] [data-photo-feed-dynamic]{display:none}.rb-browser-global .pf-content-aside{border-left:0;padding-left:0;overflow:auto;flex:1}.rb-browser-global .pf-content-layout>[data-photo-feed-dynamic]{overflow:auto}.rb-reimbursement-queue{padding:0 2px 20px}}
      .rb-reimbursement-collapse{flex:none;width:30px;height:30px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#475467;cursor:pointer}.rb-reimbursement-collapse:hover,.rb-reimbursement-rail:hover{background:#f2f4f7}.rb-reimbursement-collapse:focus-visible,.rb-reimbursement-rail:focus-visible{outline:2px solid #175cd3;outline-offset:2px}.rb-reimbursement-rail{display:none}.rb-global-app.rb-reimbursements-collapsed .pf-content-layout{grid-template-columns:minmax(0,1fr) 40px;gap:8px}.rb-global-app.rb-reimbursements-collapsed .pf-content-aside{padding-left:0;border-left:0;overflow:hidden}.rb-global-app.rb-reimbursements-collapsed .rb-reimbursement-queue{display:none}.rb-global-app.rb-reimbursements-collapsed .rb-reimbursement-rail{display:flex;box-sizing:border-box;width:40px;height:100%;min-height:120px;align-items:center;flex-direction:column;gap:10px;padding:12px 6px;border:1px solid #e4e7ec;border-radius:10px;background:#fff;color:#475467;font-size:11px;font-weight:900;cursor:pointer}.rb-reimbursement-rail span{writing-mode:vertical-rl;white-space:nowrap}.rb-reimbursement-rail i{font-size:11px}@media(max-width:760px){.rb-global-app.rb-reimbursements-collapsed .pf-content-layout{display:flex;flex-direction:column;gap:0}.rb-global-app.rb-reimbursements-collapsed .pf-content-aside{overflow:auto}.rb-global-app.rb-reimbursements-collapsed .rb-reimbursement-queue{display:grid}.rb-global-app.rb-reimbursements-collapsed .rb-reimbursement-rail,.rb-reimbursement-collapse{display:none!important}}
      .rb-viewer-shade{position:fixed;inset:0;z-index:2147483300;background:rgba(15,23,42,.62);backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;padding:22px}.rb-viewer{width:min(1320px,97vw);height:min(900px,94vh);display:grid;grid-template-columns:minmax(0,1fr) 350px;border-radius:16px;overflow:hidden;background:#fff;box-shadow:0 32px 90px rgba(15,23,42,.4)}.rb-viewer-main{min-width:0;min-height:0;background:#111827;display:flex;flex-direction:column}.rb-viewer-head{height:62px;flex:0 0 auto;padding:0 16px;display:flex;align-items:center;justify-content:space-between;gap:16px;background:#fff;border-bottom:1px solid #e4e7ec}.rb-viewer-head strong{display:block;font-size:14px}.rb-viewer-head span{display:block;margin-top:2px;color:#667085;font-size:11px;font-weight:800}.rb-viewer-actions{display:flex;align-items:center;gap:7px}.rb-viewer-actions>span{margin:0 4px;color:#667085;font-size:11px;font-weight:900}.rb-viewer-actions button{width:34px;height:34px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#344054;cursor:pointer}.rb-preview{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden}.rb-preview>img{max-width:100%;max-height:100%;object-fit:contain}.rb-preview>iframe{width:100%;height:100%;border:0;background:#fff}.rb-pdf-loading{display:flex;align-items:center;gap:9px;color:#d0d5dd;font-size:12px;font-weight:900}.rb-preview-fallback{color:#d0d5dd;text-align:center;display:flex;align-items:center;flex-direction:column;gap:11px}.rb-preview-fallback>i{font-size:58px}.rb-preview-fallback strong{color:#fff}.rb-preview-fallback span{font-size:12px}.rb-preview-fallback a{margin-top:8px;border:1px solid #667085;border-radius:9px;color:#fff;padding:9px 12px;text-decoration:none;font-size:12px;font-weight:900}.rb-viewer-side{min-height:0;overflow:auto;padding:18px;background:#fff}.rb-side-total{padding-bottom:16px;border-bottom:1px solid #eaecf0}.rb-side-total>span{display:block;color:#667085;font-size:10px;font-weight:1000;text-transform:uppercase}.rb-side-total>strong{display:block;margin:5px 0 8px;font-size:28px}.rb-viewer-side section{padding:16px 0;border-bottom:1px solid #eaecf0}.rb-viewer-side h3{margin:0 0 10px;font-size:12px;text-transform:uppercase;color:#667085;letter-spacing:.04em}.rb-detail{display:flex;align-items:flex-start;justify-content:space-between;gap:15px;padding:5px 0;font-size:11px}.rb-detail span{color:#667085}.rb-detail strong{text-align:right;overflow-wrap:anywhere}.rb-lines{display:flex;flex-direction:column;gap:7px}.rb-lines>div{display:flex;justify-content:space-between;gap:12px;font-size:11px}.rb-lines span{color:#475467}.rb-side-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding-top:16px}.rb-side-actions button,.rb-side-actions a{min-height:36px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#344054;display:flex;align-items:center;justify-content:center;gap:7px;padding:7px;text-decoration:none;font-size:11px;font-weight:1000;cursor:pointer}.rb-side-actions .primary{background:#067647;border-color:#067647;color:#fff}@media(max-width:820px){.rb-viewer{grid-template-columns:1fr;height:96vh}.rb-viewer-side{max-height:42vh}.rb-viewer-shade{padding:8px}}
    `);
  }

  function mountBrowser(root, options = {}){
    if (!root) return { destroy(){} };
    injectStyles();
    const oid = cleanText(options.orgId, orgId(options.context));
    const scope = options.scope === 'global' ? 'global' : 'project';
    const terminology = options.terminology && typeof options.terminology === 'object' ? options.terminology : {};
    const receiptSingular = cleanText(terminology.receipt, 'Receipt');
    const receiptPlural = cleanText(terminology.receipts, 'Receipts');
    let viewer = null;
    let destroyed = false;
    const projects = Array.isArray(options.projects) ? options.projects : [];
    const receipts = Array.isArray(options.receipts) ? options.receipts : [];
    const gallery = galleryProjects(receipts, projects, options.project, oid);
    gallery.forEach((project) => project.photos.forEach((photo) => { photo.__receiptOrgId = oid; }));
    root.classList.add('rb-browser');
    root.classList.toggle('rb-browser-global', scope === 'global');

    const routePatch = (receiptId, history = 'push') => {
      const patch = scope === 'global'
        ? { tab:'receipts', receipt:receiptId || null }
        : { project:projectId(options.project), projectTab:'money', moneyView:'receipts', receipt:receiptId || null };
      Portal.navigation?.[history]?.(patch, { source:`receipt-viewer-${history}`, ownedKeys:['receipt'] });
    };
    const open = ({ items, index, item, fromRoute }) => {
      viewer?.close?.({ fromRoute:true });
      const receipt = item?.photo?.receipt || {};
      if (!fromRoute) routePatch(receipt.id, 'push');
      viewer = openViewer({
        items, index, orgId:oid, onReview:options.onReview,
        onChange:(nextReceipt) => routePatch(nextReceipt.id, 'replace'),
        onClose:() => {
          viewer = null;
          Portal.navigation?.backOrClose?.(['receipt'], { receipt:null }, { source:'receipt-viewer-close' });
        }
      });
      return viewer;
    };

    if (!Portal.PhotoFeed?.mountProjectGallery) {
      root.innerHTML = `<div class="pf-empty"><i class="fas fa-receipt"></i><strong>${(globalThis.PlatformLanguage?.text("receipts","m_debe4f233e50f2","Receipt browser unavailable") ?? "Receipt browser unavailable")}</strong><div>${(globalThis.PlatformLanguage?.text("receipts","m_353ae41f38fb1a","The shared media gallery is not loaded.") ?? "The shared media gallery is not loaded.")}</div></div>`;
      return { destroy(){ root.classList.remove('rb-browser', 'rb-browser-global'); root.innerHTML = ''; } };
    }
    Portal.PhotoFeed.mountProjectGallery(root, {
      project:options.project || gallery[0] || { id:'receipts', title:receiptPlural },
      projects:gallery,
      title:scope === 'global' ? receiptPlural : '',
      icon:'fa-receipt',
      itemNoun:receiptSingular.toLowerCase(),
      searchPlaceholder:scope === 'global' ? `Search ${receiptPlural.toLowerCase()}, reimbursements, or people` : `Search ${receiptPlural.toLowerCase()}, projects, uploaders, or dates`,
      emptyIcon:'fa-receipt',
      emptyTitle:`No ${receiptPlural.toLowerCase()} found`,
      emptyMessage:scope === 'global' ? `Uploaded ${receiptPlural.toLowerCase()} will appear here across projects.` : `Upload a ${receiptSingular.toLowerCase()} to add it to this project.`,
      enableProjectLinks:scope === 'global',
      projectLinkEnabled:false,
      includeReceipts:true,
      selectionEnabled:false,
      tileClass:(item) => `rb-receipt-tile${receiptContentType(item.photo?.receipt).startsWith('image/') ? '' : ' loaded'}`,
      renderThumbnail:thumbnailHtml,
      renderTileMeta:tileMeta,
      renderGroupUploaders:groupUploaders,
      itemIdentity:(item) => cleanText(item.photo?.receipt?.id),
      initialItemId:cleanText(options.initialReceiptId),
      layoutTabsHtml:options.layoutTabsHtml,
      layoutAsideHtml:options.layoutAsideHtml,
      onOpenItem:open,
      onOpenProject:(project) => options.onOpenProject?.(project)
        || Portal.navigation?.push?.({ project:projectId(project), projectTab:'money', moneyView:'receipts', receipt:null }, { source:'global-receipt-project-open', ownedKeys:['project'] })
    });
    const handle = {
      destroy(){ destroyed = true; viewer?.close?.({ fromRoute:true }); viewer = null; root.classList.remove('rb-browser', 'rb-browser-global'); root.innerHTML = ''; },
      closeViewerFromRoute(){ viewer?.close?.({ fromRoute:true }); viewer = null; },
      receiptId(){ return viewer?.receiptId?.() || ''; },
      get destroyed(){ return destroyed; }
    };
    return handle;
  }

  function receiptsEnabled(){
    const flags = Portal.appFlags || window.PlatformAPI?.appFlags;
    if (!flags?.current?.()) return false;
    return flags.has?.('platform', 'money') || flags.value?.('platform', 'money', false) === true;
  }

  function reimbursementQueueHtml(rowsValue = []){
    const rows = Array.isArray(rowsValue) ? rowsValue : [];
    const actionable = rows.filter((row) => !['not_required','rejected','paid'].includes(cleanText(row?.reimbursement_request?.status)));
    return `<button type="button" class="rb-reimbursement-rail" data-reimbursement-expand aria-label="Expand employee reimbursements" title="Expand reimbursements"><i class="fas fa-chevron-left" aria-hidden="true"></i><span>Reimbursements</span></button><section class="rb-reimbursement-queue" aria-label="Employee reimbursements"><div class="rb-reimbursement-head"><div><strong>${(globalThis.PlatformLanguage?.text("receipts","m_5c2c0f1194429c","Employee reimbursements") ?? "Employee reimbursements")}</strong><p>${(globalThis.PlatformLanguage?.text("receipts","m_1019e518a22db1","Receipt-backed requests awaiting office or payroll action.") ?? "Receipt-backed requests awaiting office or payroll action.")}</p></div><button type="button" class="rb-reimbursement-collapse" data-reimbursement-collapse aria-label="Collapse employee reimbursements" title="Collapse reimbursements"><i class="fas fa-chevron-right" aria-hidden="true"></i></button></div><span class="rb-reimbursement-count">${((v0) => globalThis.PlatformLanguage?.text("receipts","m_6c4162aa600d83",`${v0} open`,{v0}) ?? `${v0} open`)(actionable.length)}</span>${String(actionable.length ? `<div class="rb-reimbursement-list">${actionable.map((row) => {
      const request = row.reimbursement_request || {};
      const receipt = row.receipt || {};
      const status = cleanText(request.status);
      const name = cleanText(request.requested_by?.name) || 'Crew member';
      const amount = (Number(request.amount_cents || 0) / 100).toLocaleString(undefined, { style:'currency', currency:request.currency || 'USD' });
      const review = ['submitted','needs_clarification'].includes(status);
      return `<div class="rb-reimbursement-card"><div class="rb-reimbursement-card-head"><strong>${escapeHtml(name)}</strong><b>${escapeHtml(amount)}</b></div><div class="rb-reimbursement-card-meta">${escapeHtml(receipt.file?.file_name || 'Receipt')} · ${escapeHtml(status.replace(/_/g,' '))}${request.note ? ` · ${escapeHtml(request.note)}` : ''}</div><div class="rb-reimbursement-actions"><button class="pf-btn" data-reimbursement-view="${escapeHtml(receipt.id)}">View receipt</button>${review ? `<button class="pf-btn primary" data-reimbursement-action="approve" data-timing="next_payroll" data-receipt-id="${escapeHtml(receipt.id)}">Approve for payroll</button><button class="pf-btn" data-reimbursement-action="approve" data-timing="off_cycle" data-receipt-id="${escapeHtml(receipt.id)}">Approve off-cycle</button><button class="pf-btn" data-reimbursement-action="needs_clarification" data-receipt-id="${escapeHtml(receipt.id)}">Needs info</button><button class="pf-btn" data-reimbursement-action="reject" data-receipt-id="${escapeHtml(receipt.id)}">Reject</button>` : `<button class="pf-btn primary" data-reimbursement-action="mark_paid" data-receipt-id="${escapeHtml(receipt.id)}">Mark paid</button>`}</div></div>`;
    }).join('')}</div>` : '<div class="rb-reimbursement-empty"><strong>No reimbursement requests need attention.</strong></div>')}</section>`;
  }

  async function createGlobalApp(context = {}){
    const root = context.panelRoot || context.roots?.main || context.root;
    let handle = null;
    let destroyed = false;
    let reimbursementRows = [];
    let reimbursementQuery = '';
    const oid = orgId(context);
    const preferenceKey = `fm:receipts:reimbursements-visible:${oid}:${cleanText(Portal.currentUser?.id, Portal.currentUser?.user_id)}`;
    let reimbursementsExpanded = true;
    try { reimbursementsExpanded = window.localStorage?.getItem(preferenceKey) !== 'off'; } catch (_) {}
    root.classList.add('rb-global-app');
    root.classList.toggle('rb-reimbursements-collapsed', !reimbursementsExpanded);
    root.dataset.mobileView = 'receipts';
    root.innerHTML = `<div class="pf-loading"><i class="fas fa-circle-notch fa-spin"></i>${(globalThis.PlatformLanguage?.text("receipts","m_8f711e547f6361"," Loading receipts...") ?? " Loading receipts...")}</div>`;
    try {
      const [receiptResult, projectResult, reimbursementResult] = await Promise.all([
        window.PaymentsAPI?.receipts?.listFor?.(oid, { kind:'organization', id:oid }),
        window.PlatformAPI?.projects?.list?.(oid).catch(() => ({ documents:[] })),
        window.PaymentsAPI?.reimbursements?.list?.(oid).catch(() => ({ reimbursements:[] }))
      ]);
      if (destroyed) return { destroy(){} };
      const projects = (projectResult?.documents || []).map(normalizeProjectDocument);
      const route = Portal.navigation?.read?.() || {};
      reimbursementRows = reimbursementResult?.reimbursements || [];
      const visibleReimbursements = () => reimbursementRows.filter((row) => {
        if (!reimbursementQuery) return true;
        const request = row.reimbursement_request || {};
        const receipt = row.receipt || {};
        return [request.requested_by?.name, request.note, request.status, receipt.title, receipt.file?.file_name, receipt.project_name]
          .some((value) => cleanText(value).toLowerCase().includes(reimbursementQuery));
      });
      root.innerHTML = `<div data-receipt-browser></div>`;
      const browserRoot = root.querySelector('[data-receipt-browser]');
      const renderReimbursements = () => reimbursementQueueHtml(visibleReimbursements());
      handle = mountBrowser(browserRoot, {
        scope:'global', orgId:oid, projects, receipts:receiptResult?.receipts || [], initialReceiptId:route.tab === 'receipts' ? route.receipt : '',
        layoutTabsHtml:() => `<div class="rb-mobile-tabs" role="tablist" aria-label="Receipt sections"><button type="button" role="tab" data-receipts-view="receipts" aria-selected="${root.dataset.mobileView !== 'reimbursements'}">Receipts</button><button type="button" role="tab" data-receipts-view="reimbursements" aria-selected="${root.dataset.mobileView === 'reimbursements'}">Reimbursements</button></div>`,
        layoutAsideHtml:renderReimbursements
      });
      browserRoot.addEventListener('input', (event) => {
        if (!event.target.matches('.pf-search input')) return;
        reimbursementQuery = cleanText(event.target.value).toLowerCase();
        const aside = browserRoot.querySelector('.pf-content-aside');
        if (aside) aside.innerHTML = renderReimbursements();
      });
      browserRoot.addEventListener('click', async (event) => {
        const toggle = event.target.closest('[data-reimbursement-collapse], [data-reimbursement-expand]');
        if (toggle) {
          reimbursementsExpanded = toggle.hasAttribute('data-reimbursement-expand');
          root.classList.toggle('rb-reimbursements-collapsed', !reimbursementsExpanded);
          try { window.localStorage?.setItem(preferenceKey, reimbursementsExpanded ? 'on' : 'off'); } catch (_) {}
          browserRoot.querySelector(reimbursementsExpanded ? '[data-reimbursement-collapse]' : '[data-reimbursement-expand]')?.focus();
          return;
        }
        const tab = event.target.closest('[data-receipts-view]');
        if (tab) {
          root.dataset.mobileView = tab.dataset.receiptsView;
          browserRoot.querySelectorAll('[data-receipts-view]').forEach((button) => button.setAttribute('aria-selected', String(button === tab)));
          return;
        }
        const viewButton = event.target.closest('[data-reimbursement-view]');
        if (viewButton) {
          root.dataset.mobileView = 'receipts';
          Portal.navigation?.push?.({ tab:'receipts', receipt:viewButton.dataset.reimbursementView }, { source:'reimbursement-receipt-open', ownedKeys:['receipt'] });
          return;
        }
        const button = event.target.closest('[data-reimbursement-action]');
        if (!button) return;
        const action = button.dataset.reimbursementAction;
        const note = ['reject','needs_clarification'].includes(action) ? (window.prompt(action === 'reject' ? 'Reason for declining' : 'What information is needed?') || '') : '';
        if (['reject','needs_clarification'].includes(action) && !note) return;
        button.disabled = true;
        try {
          await window.PaymentsAPI.reimbursements.action(oid, button.dataset.receiptId, { action, payment_timing:button.dataset.timing || undefined, note });
          const refreshed = await window.PaymentsAPI.reimbursements.list(oid);
          reimbursementRows = refreshed?.reimbursements || [];
          const aside = browserRoot.querySelector('.pf-content-aside');
          if (aside) aside.innerHTML = renderReimbursements();
          showToast((globalThis.PlatformLanguage?.text("receipts","m_34df0fdb35babd","Reimbursement updated") ?? "Reimbursement updated"), action === 'approve' ? 'The payable has been created and queued.' : 'The request status was updated.', true);
        } catch (error) {
          button.disabled = false;
          showToast((globalThis.PlatformLanguage?.text("receipts","m_278f0bef2a1d90","Could not update reimbursement") ?? "Could not update reimbursement"), error?.message || 'Try again shortly.', false);
        }
      });
    } catch (error) {
      root.innerHTML = `<div class="pf-empty"><i class="fas fa-triangle-exclamation"></i><strong>${(globalThis.PlatformLanguage?.text("receipts","m_62447276077f46","Could not load receipts") ?? "Could not load receipts")}</strong><div>${String(escapeHtml(error?.message || 'Try again shortly.'))}</div></div>`;
      showToast((globalThis.PlatformLanguage?.text("receipts","m_744a0502e08506","Receipts issue") ?? "Receipts issue"), error?.message || 'Could not load receipts.', false);
    }
    const unregister = Portal.navigation?.registerHandler?.(`global-receipts:${context.instanceId || Date.now()}`, {
      priority:520,
      apply:(route) => {
        if (route.tab !== 'receipts' || route.receipt) return;
        handle?.closeViewerFromRoute?.();
      }
    });
    return { destroy(){ destroyed = true; unregister?.(); handle?.destroy?.(); root.classList.remove('rb-global-app', 'rb-reimbursements-collapsed'); delete root.dataset.mobileView; } };
  }

  Portal.ReceiptsBrowser = { mount:mountBrowser, openViewer };

  runtime?.registerApp?.({
    id:'portal.receipts', package:'receipts', kind:'portal_tab', title:(globalThis.PlatformLanguage?.text("receipts","m_fc54001a0cc000","Receipts") ?? "Receipts"), label:(globalThis.PlatformLanguage?.text("receipts","m_fc54001a0cc000","Receipts") ?? "Receipts"), icon:'fa-receipt', order:16,
    surfaces:['portal_tab'], regions:['main'], visible:true, fullBleed:true, enabled:receiptsEnabled, mount:createGlobalApp
  });
})();
