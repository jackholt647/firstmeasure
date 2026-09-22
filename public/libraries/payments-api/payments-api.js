/* libraries/payments-api/payments-api.js
 * Browser client for /v1/payments.
 */
(function(){
  const root = window;
  const APP = root.__APP || {};
  const state = { baseUrl: '', defaultHeaders: {} };

  function cleanText(value){ return String(value ?? '').trim(); }
  function enc(value){ return encodeURIComponent(cleanText(value)); }

  function defaultBaseUrl(){
    if (APP.paymentsApiBase) return cleanText(APP.paymentsApiBase).replace(/\/+$/, '');
    if (APP.platformApiBase) return cleanText(APP.platformApiBase).replace(/\/v1\/platform\/?$/i, '/v1/payments').replace(/\/+$/, '');
    const host = cleanText(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return `${location.origin}/v1/payments`;
    return `${location.origin}/v1/payments`;
  }

  function configure(options = {}){
    if (options.baseUrl) state.baseUrl = cleanText(options.baseUrl).replace(/\/+$/, '');
    if (options.headers && typeof options.headers === 'object') state.defaultHeaders = { ...state.defaultHeaders, ...options.headers };
    return api;
  }

  function baseUrl(){
    if (!state.baseUrl) state.baseUrl = defaultBaseUrl();
    return state.baseUrl;
  }

  function url(path = ''){
    const raw = cleanText(path);
    if (/^https?:\/\//i.test(raw)) return raw;
    const base = baseUrl();
    if (!base) return '';
    return `${base}/${raw.replace(/^\/+/, '')}`;
  }

  function cookieValue(name){
    const target = `${encodeURIComponent(name)}=`;
    return document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(target))?.slice(target.length) || '';
  }

  function csrfToken(){
    const sessionName = cleanText(APP.platformSessionCookieName || 'fm_platform_session');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionName)) return '';
    try {
      return decodeURIComponent(cookieValue(sessionName + '_csrf') || '');
    } catch {
      return '';
    }
  }

  function jsonBody(body){
    if (body == null || body instanceof FormData || typeof body === 'string') return body;
    return JSON.stringify(body);
  }

  function requestHeaders(options, body){
    const method = cleanText(options.method || 'GET').toUpperCase();
    const headers = {
      Accept: 'application/json',
      ...state.defaultHeaders,
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    };
    const csrf = csrfToken();
    if (csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method) && !headers['X-Platform-CSRF']) headers['X-Platform-CSRF'] = csrf;
    return headers;
  }

  async function request(path, options = {}){
    const requestUrl = url(path);
    if (!requestUrl) {
      const error = new Error('Payments API is not configured for this frontend session.');
      error.status = 0;
      error.data = { ok: false, missing: true };
      throw error;
    }
    const body = jsonBody(options.body);
    const res = await fetch(requestUrl, {
      ...options,
      body,
      cache: options.cache || 'no-store',
      credentials: options.credentials || 'include',
      headers: requestHeaders(options, body)
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch(e) {}
    if (!res.ok || data?.ok === false) {
      const error = new Error(cleanText(data?.message || data?.error) || `Payments API request failed (${res.status})`);
      error.status = res.status;
      error.data = data;
      error.responseText = text;
      throw error;
    }
    return data;
  }

  function orgPath(orgId, suffix = ''){
    return `/organizations/${enc(orgId)}${suffix}`;
  }

  const projects = {
    summary(orgId, projectId){ return request(orgPath(orgId, `/projects/${enc(projectId)}/money-summary`)); },
    expenses(orgId, projectId){ return request(orgPath(orgId, `/projects/${enc(projectId)}/expense-summary`)); },
    schedules(orgId, projectId){ return request(orgPath(orgId, `/projects/${enc(projectId)}/payment-schedules`)); },
    obligations(orgId, projectId){ return request(orgPath(orgId, `/projects/${enc(projectId)}/obligations`)); },
    payments(orgId, projectId){ return request(orgPath(orgId, `/projects/${enc(projectId)}/payments`)); },
    invoices(orgId, projectId){ return request(orgPath(orgId, `/projects/${enc(projectId)}/invoices`)); }
  };

  const expenses = {
    create(orgId, projectId, payload = {}){ return request(orgPath(orgId, `/projects/${enc(projectId)}/expenses`), { method: 'POST', body: payload || {} }); },
    update(orgId, projectId, expenseId, payload = {}){ return request(orgPath(orgId, `/projects/${enc(projectId)}/expenses/${enc(expenseId)}`), { method: 'PATCH', body: payload || {} }); },
    setActual(orgId, projectId, payload = {}){ return request(orgPath(orgId, `/projects/${enc(projectId)}/expense-actual`), { method: 'PUT', body: payload || {} }); }
  };

  function receiptForm(file, options = {}){
    const fd = new FormData();
    fd.append('file', file);
    if (options.project_id) fd.append('project_id', options.project_id);
    if (options.title) fd.append('title', options.title);
    if (options.total_cents != null) fd.append('total_cents', String(options.total_cents));
    if (options.purchase_date) fd.append('purchase_date', options.purchase_date);
    if (options.purchase_time) fd.append('purchase_time', options.purchase_time);
    if (options.purchase_timezone) fd.append('purchase_timezone', options.purchase_timezone);
    if (options.upload_location) fd.append('upload_location', JSON.stringify(options.upload_location));
    if (options.associations) fd.append('associations', JSON.stringify(options.associations));
    if (options.owner) fd.append('owner', JSON.stringify(options.owner));
    fd.append('metadata', JSON.stringify(options.metadata || {}));
    return fd;
  }

  function receiptBatchFiles(files){
    return Array.from(files || []).filter((file) => file && typeof file === 'object' && Number(file.size) >= 0);
  }

  async function runReceiptBatch(filesValue, uploadOne, options = {}){
    const files = receiptBatchFiles(filesValue);
    const concurrency = Math.max(1, Math.min(files.length || 1, Number(options.concurrency) || 4));
    const batchId = cleanText(options.batch_id) || root.crypto?.randomUUID?.() || `receipt-batch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const items = files.map((file, index) => ({
      id:`${batchId}-${index}`,
      batch_id:batchId,
      index,
      file,
      file_name:cleanText(file.name) || `Receipt ${index + 1}`,
      size_bytes:Number(file.size) || 0,
      content_type:cleanText(file.type),
      status:'queued',
      result:null,
      receipt:null,
      error:''
    }));
    const notify = (item) => {
      if (typeof options.onUpdate === 'function') options.onUpdate(item, items);
    };
    items.forEach(notify);
    let cursor = 0;
    const worker = async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        item.status = 'uploading';
        notify(item);
        const custom = typeof options.optionsForFile === 'function' ? options.optionsForFile(item.file, item.index, item) : {};
        const baseKey = typeof options.idempotency_key === 'function' ? options.idempotency_key(item.file, item.index) : cleanText(options.idempotency_key);
        const uploadOptions = {
          ...options,
          ...custom,
          concurrency:undefined,
          batch_id:undefined,
          onUpdate:undefined,
          optionsForFile:undefined,
          idempotency_key:baseKey ? `${baseKey}-${item.index}` : `${batchId}-${item.index}-${item.size_bytes}-${Number(item.file.lastModified) || 0}`,
          metadata:{ ...(options.metadata || {}), ...(custom?.metadata || {}), receipt_batch_id:batchId, receipt_batch_index:item.index, receipt_batch_size:items.length }
        };
        try {
          item.result = await uploadOne(item.file, uploadOptions);
          item.receipt = item.result?.receipt || item.result || null;
          item.status = 'ready';
        } catch (error) {
          item.error = cleanText(error?.message || error) || 'Upload failed.';
          item.status = 'error';
        }
        notify(item);
      }
    };
    await Promise.all(Array.from({ length:concurrency }, () => worker()));
    return { ok:items.every((item) => item.status === 'ready'), batch_id:batchId, items, receipts:items.map((item) => item.receipt).filter(Boolean), count:items.length, succeeded:items.filter((item) => item.status === 'ready').length, failed:items.filter((item) => item.status === 'error').length };
  }

  const receipts = {
    batch(files, uploadOne, options = {}){
      if (typeof uploadOne !== 'function') return Promise.reject(new Error('A receipt upload function is required.'));
      return runReceiptBatch(files, uploadOne, options);
    },
    list(orgId, projectId){ return request(orgPath(orgId, `/projects/${enc(projectId)}/receipts`)); },
    upload(orgId, projectId, file, options = {}){
      const fd = receiptForm(file, options);
      return request(orgPath(orgId, `/projects/${enc(projectId)}/receipts`), {
        method: 'POST',
        body: fd,
        headers: options.idempotency_key ? { 'Idempotency-Key': options.idempotency_key } : undefined
      });
    },
    uploadBatch(orgId, projectId, files, options = {}){
      return runReceiptBatch(files, (file, uploadOptions) => receipts.upload(orgId, projectId, file, uploadOptions), options);
    },
    listFor(orgId, association = {}){
      const params = new URLSearchParams();
      if (association.kind) params.set('association_kind', cleanText(association.kind));
      if (association.id) params.set('association_id', cleanText(association.id));
      if (association.include_void) params.set('include_void', '1');
      const qs = params.toString();
      return request(orgPath(orgId, `/receipts${qs ? `?${qs}` : ''}`));
    },
    uploadFor(orgId, file, options = {}){
      return request(orgPath(orgId, '/receipts'), {
        method:'POST',
        body:receiptForm(file, options),
        headers:options.idempotency_key ? { 'Idempotency-Key':options.idempotency_key } : undefined
      });
    },
    uploadBatchFor(orgId, files, options = {}){
      return runReceiptBatch(files, (file, uploadOptions) => receipts.uploadFor(orgId, file, uploadOptions), options);
    },
    get(orgId, receiptId){ return request(orgPath(orgId, `/receipts/${enc(receiptId)}`)); },
    audit(orgId, receiptId){ return request(orgPath(orgId, `/receipts/${enc(receiptId)}/audit`)); },
    update(orgId, receiptId, payload = {}){ return request(orgPath(orgId, `/receipts/${enc(receiptId)}`), { method: 'PATCH', body: payload || {} }); },
    apply(orgId, receiptId, payload = {}){ return request(orgPath(orgId, `/receipts/${enc(receiptId)}/apply`), { method: 'POST', body: payload || {} }); },
    extract(orgId, receiptId){ return request(orgPath(orgId, `/receipts/${enc(receiptId)}/extract`), { method: 'POST', body: {} }); },
    remove(orgId, receiptId){ return request(orgPath(orgId, `/receipts/${enc(receiptId)}`), { method: 'DELETE' }); },
    fileUrl(orgId, receiptId, options = {}){
      const suffix = options.inline === true ? '?inline=1' : '';
      return url(orgPath(orgId, `/receipts/${enc(receiptId)}/file${suffix}`));
    }
  };

  const reimbursements = {
    list(orgId, options = {}){
      const params = new URLSearchParams();
      if (options.status) params.set('status', cleanText(options.status));
      const qs = params.toString();
      return request(orgPath(orgId, `/reimbursements${qs ? `?${qs}` : ''}`));
    },
    submit(orgId, receiptId, payload = {}){
      return request(orgPath(orgId, `/receipts/${enc(receiptId)}/reimbursement-request`), { method:'POST', body:payload || {} });
    },
    action(orgId, receiptId, payload = {}){
      return request(orgPath(orgId, `/reimbursements/${enc(receiptId)}/actions`), { method:'POST', body:payload || {} });
    }
  };

  const payments = {
    create(orgId, payload = {}){ return request(orgPath(orgId, '/payments'), { method: 'POST', body: payload || {} }); },
    get(orgId, paymentId){ return request(orgPath(orgId, `/payments/${enc(paymentId)}`)); },
    refund(orgId, paymentId, payload = {}){ return request(orgPath(orgId, `/payments/${enc(paymentId)}/refunds`), { method: 'POST', body: payload || {} }); },
    reallocate(orgId, paymentId, payload = {}){ return request(orgPath(orgId, `/payments/${enc(paymentId)}/reallocate`), { method: 'POST', body: payload || {} }); },
    clear(orgId, paymentId, payload = {}){ return request(orgPath(orgId, `/payments/${enc(paymentId)}/clear`), { method: 'POST', body: payload || {} }); },
    unclear(orgId, paymentId){ return request(orgPath(orgId, `/payments/${enc(paymentId)}/unclear`), { method: 'POST', body: {} }); },
    receiptPdfUrl(orgId, paymentId){ return url(orgPath(orgId, `/payments/${enc(paymentId)}/receipt.pdf`)); },
    reconciliation(orgId, options = {}){
      const params = new URLSearchParams();
      if (options.project_id || options.projectId) params.set('project_id', cleanText(options.project_id || options.projectId));
      const qs = params.toString();
      return request(orgPath(orgId, `/reconciliation${qs ? `?${qs}` : ''}`));
    }
  };

  const invoices = {
    list(orgId, projectId){ return request(orgPath(orgId, `/projects/${enc(projectId)}/invoices`)); },
    listAll(orgId, options = {}){
      const params = new URLSearchParams();
      if (options.project_id || options.projectId) params.set('project_id', cleanText(options.project_id || options.projectId));
      if (options.status) params.set('status', cleanText(options.status));
      const qs = params.toString();
      return request(orgPath(orgId, `/invoices${qs ? `?${qs}` : ''}`));
    },
    uninvoiced(orgId){ return request(orgPath(orgId, '/uninvoiced')); },
    create(orgId, projectId, payload = {}){ return request(orgPath(orgId, `/projects/${enc(projectId)}/invoices`), { method:'POST', body:payload || {} }); },
    quick(orgId, projectId, payload = {}){ return request(orgPath(orgId, `/projects/${enc(projectId)}/invoices/quick`), { method:'POST', body:payload || {} }); },
    get(orgId, invoiceId){ return request(orgPath(orgId, `/invoices/${enc(invoiceId)}`)); },
    pdfUrl(orgId, invoiceId){ return url(orgPath(orgId, `/invoices/${enc(invoiceId)}/pdf`)); },
    markDue(orgId, invoiceId, payload = {}){ return request(orgPath(orgId, `/invoices/${enc(invoiceId)}/mark-due`), { method:'POST', body:payload || {} }); },
    email(orgId, invoiceId, payload = {}){ return request(orgPath(orgId, `/invoices/${enc(invoiceId)}/email`), { method:'POST', body:payload || {} }); },
    voidInvoice(orgId, invoiceId, payload = {}){ return request(orgPath(orgId, `/invoices/${enc(invoiceId)}/void`), { method:'POST', body:payload || {} }); },
    setProductionHold(orgId, invoiceId, payload = {}){ return request(orgPath(orgId, `/invoices/${enc(invoiceId)}/production-hold`), { method:'POST', body:payload || {} }); }
  };

  const intents = {
    create(orgId, payload = {}){ return request(orgPath(orgId, '/payment-intents'), { method: 'POST', body: payload || {} }); },
    cancel(orgId, intentId){ return request(orgPath(orgId, `/payment-intents/${enc(intentId)}/cancel`), { method: 'POST', body: {} }); }
  };

  const intake = {
    config(orgId, options = {}){
      const params = new URLSearchParams();
      if (options.contact_ref || options.contactRef) params.set('contact_ref', cleanText(options.contact_ref || options.contactRef));
      if (options.branch_id || options.branchId) params.set('branch_id', cleanText(options.branch_id || options.branchId));
      const qs = params.toString();
      return request(orgPath(orgId, `/payment-intake-config${qs ? `?${qs}` : ''}`));
    },
    createPaymentMethodIntent(orgId, payload = {}){ return request(orgPath(orgId, '/payment-method-intents'), { method: 'POST', body: payload || {} }); },
    surchargeQuote(orgId, options = {}){
      const params = new URLSearchParams();
      params.set('amount_cents', String(Math.max(0, Math.round(Number(options.amount_cents ?? options.amountCents) || 0))));
      if (options.method) params.set('method', cleanText(options.method));
      if (options.branch_id || options.branchId) params.set('branch_id', cleanText(options.branch_id || options.branchId));
      return request(orgPath(orgId, `/surcharge-quote?${params.toString()}`));
    }
  };

  const savedMethods = {
    list(orgId, contactRef){ return request(orgPath(orgId, `/customers/${enc(contactRef)}/payment-methods`)); },
    create(orgId, contactRef, payload = {}){ return request(orgPath(orgId, `/customers/${enc(contactRef)}/payment-methods`), { method: 'POST', body: payload || {} }); },
    remove(orgId, contactRef, methodId){ return request(orgPath(orgId, `/customers/${enc(contactRef)}/payment-methods/${enc(methodId)}`), { method: 'DELETE' }); }
  };

  const payables = {
    list(orgId, options = {}){
      const params = new URLSearchParams();
      if (options.project_id || options.projectId) params.set('project_id', cleanText(options.project_id || options.projectId));
      const qs = params.toString();
      return request(orgPath(orgId, `/payables${qs ? `?${qs}` : ''}`));
    },
    create(orgId, payload = {}){ return request(orgPath(orgId, '/payables'), { method: 'POST', body: payload || {} }); },
    remove(orgId, payableId){ return request(orgPath(orgId, `/payables/${enc(payableId)}`), { method: 'DELETE' }); }
  };

  const disbursements = {
    create(orgId, payload = {}){ return request(orgPath(orgId, '/disbursements'), { method: 'POST', body: payload || {} }); }
  };

  const ledger = {
    list(orgId, options = {}){
      const params = new URLSearchParams();
      if (options.project_id || options.projectId) params.set('project_id', cleanText(options.project_id || options.projectId));
      const qs = params.toString();
      return request(orgPath(orgId, `/ledger${qs ? `?${qs}` : ''}`));
    }
  };

  const events = {
    list(orgId, options = {}){
      const params = new URLSearchParams();
      if (options.project_id || options.projectId) params.set('project_id', cleanText(options.project_id || options.projectId));
      const qs = params.toString();
      return request(orgPath(orgId, `/events${qs ? `?${qs}` : ''}`));
    }
  };

  const proposals = {
    syncSchedule(orgId, proposalId, payload = {}){ return request(orgPath(orgId, `/proposals/${enc(proposalId)}/sync-schedule`), { method: 'POST', body: payload || {} }); }
  };

  const autopay = {
    get(orgId, projectId){ return request(orgPath(orgId, `/projects/${enc(projectId)}/autopay`)); },
    enroll(orgId, projectId, payload = {}){ return request(orgPath(orgId, `/projects/${enc(projectId)}/autopay`), { method: 'PUT', body: payload || {} }); },
    update(orgId, projectId, payload = {}){ return request(orgPath(orgId, `/projects/${enc(projectId)}/autopay`), { method: 'PUT', body: payload || {} }); },
    remove(orgId, projectId){ return request(orgPath(orgId, `/projects/${enc(projectId)}/autopay`), { method: 'DELETE' }); },
    run(orgId, payload = {}){ return request(orgPath(orgId, '/autopay/run'), { method: 'POST', body: payload || {} }); }
  };

  // Unmatched-settlements reconciliation queue (shadow provider payments).
  const unmatched = {
    list(orgId){ return request(orgPath(orgId, '/reconciliation/unmatched')); },
    match(orgId, recordId, paymentId){ return request(orgPath(orgId, `/reconciliation/unmatched/${enc(recordId)}/match`), { method: 'POST', body: { payment_id: cleanText(paymentId) } }); },
    dismiss(orgId, recordId, payload = {}){ return request(orgPath(orgId, `/reconciliation/unmatched/${enc(recordId)}/dismiss`), { method: 'POST', body: payload || {} }); }
  };

  const payouts = {
    list(orgId, options = {}){
      const params = new URLSearchParams();
      if (options.status) params.set('status', cleanText(options.status));
      if (options.from) params.set('from', cleanText(options.from));
      if (options.to) params.set('to', cleanText(options.to));
      const qs = params.toString();
      return request(orgPath(orgId, `/payouts${qs ? `?${qs}` : ''}`));
    },
    get(orgId, payoutId){ return request(orgPath(orgId, `/payouts/${enc(payoutId)}`)); }
  };

  const finance = {
    summary(orgId){ return request(orgPath(orgId, '/finance-summary')); }
  };

  const disputes = {
    list(orgId, options = {}){
      const params = new URLSearchParams();
      if (options.status) params.set('status', cleanText(options.status));
      const qs = params.toString();
      return request(orgPath(orgId, `/disputes${qs ? `?${qs}` : ''}`));
    }
  };

  const merchantConfig = {
    get(orgId){ return request(orgPath(orgId, '/merchant-config')); },
    patch(orgId, payload = {}){ return request(orgPath(orgId, '/merchant-config'), { method: 'PATCH', body: payload || {} }); }
  };

  const merchantMock = {
    advance(orgId, payload = {}){ return request(orgPath(orgId, '/merchant-mock/advance'), { method: 'POST', body: payload || {} }); }
  };

  const merchantBoarding = {
    plans(orgId){ return request(orgPath(orgId, '/merchant-boarding/processing-plans')); },
    createApplication(orgId, payload = {}){ return request(orgPath(orgId, '/merchant-boarding/applications'), { method: 'POST', body: payload || {} }); },
    getApplication(orgId, applicationId){ return request(orgPath(orgId, `/merchant-boarding/applications/${enc(applicationId)}`)); },
    updateApplication(orgId, applicationId, payload = {}){ return request(orgPath(orgId, `/merchant-boarding/applications/${enc(applicationId)}`), { method: 'PATCH', body: payload || {} }); },
    // Partner-capability-gated at Forward: kept for parity, but the org-facing
    // flow submits through the hosted application link below.
    submitApplication(orgId, applicationId){ return request(orgPath(orgId, `/merchant-boarding/applications/${enc(applicationId)}/submit`), { method: 'POST', body: {} }); },
    // Hosted application link (reused until expiry; pass {force:true} to
    // always mint fresh — Forward can invalidate stored links early).
    applicationLink(orgId, applicationId, payload = {}){ return request(orgPath(orgId, `/merchant-boarding/applications/${enc(applicationId)}/link`), { method: 'POST', body: payload || {} }); },
    // Hosted-first signup harness (mock provider / Forward sandbox only):
    // minimal draft + hosted link in one call, skipping the wizard steps.
    hostedSignup(orgId, payload = {}){ return request(orgPath(orgId, '/merchant-boarding/hosted-signup'), { method: 'POST', body: payload || {} }); },
    bankAccounts(orgId){ return request(orgPath(orgId, '/merchant-boarding/bank-accounts')); }
  };

  // Single-use magic-link SSO into the processor's merchant portal (bank
  // account changes + dispute responses happen there).
  const merchantPortal = {
    loginUrl(orgId){ return request(orgPath(orgId, '/merchant-portal/login-url'), { method: 'POST', body: {} }); }
  };

  // --- Boarding ops console (FirstMate staff only) ---------------------------
  // Talks to /v1/payments/admin/* which is guarded server-side by the internal
  // staff-admin check. The namespace only attaches inside the internal Staff
  // Console shell (window.PORTAL_CFG carries the internal actor); org portal
  // sessions never see PaymentsAPI.admin.
  function staffActor(){
    const cfg = root.PORTAL_CFG || null;
    const user = cfg && cfg.user && cfg.user.email ? cfg.user : null;
    return user;
  }

  function adminRequest(path, options = {}){
    const actor = staffActor();
    if (!actor) {
      const error = new Error('The payments admin API is only available inside the FirstMate staff console.');
      error.status = 403;
      return Promise.reject(error);
    }
    const params = new URLSearchParams({
      actor_email: cleanText(actor.email),
      actor_name: cleanText(actor.name),
      actor_role: cleanText(actor.role)
    });
    const separator = String(path).includes('?') ? '&' : '?';
    return request(`/admin${path}${separator}${params.toString()}`, {
      ...options,
      headers: {
        'X-Internal-User-Email': cleanText(actor.email),
        'X-Internal-User-Name': cleanText(actor.name),
        'X-Internal-User-Role': cleanText(actor.role),
        ...(options.headers || {})
      }
    });
  }

  function buildAdminNamespace(){
    return {
      merchantConfigs: {
        list(options = {}){
          const params = new URLSearchParams();
          if (options.status) params.set('status', cleanText(options.status));
          if (options.provider) params.set('provider', cleanText(options.provider));
          const qs = params.toString();
          return adminRequest(`/merchant-configs${qs ? `?${qs}` : ''}`);
        },
        get(orgId){ return adminRequest(`/merchant-configs/${enc(orgId)}`); }
      },
      assignPlan(orgId, payload = {}){ return adminRequest(`/merchant-configs/${enc(orgId)}/assign-plan`, { method: 'POST', body: payload || {} }); },
      setProvider(orgId, payload = {}){ return adminRequest(`/merchant-configs/${enc(orgId)}/set-provider`, { method: 'POST', body: payload || {} }); },
      plans(){ return adminRequest('/processing-plans'); }
    };
  }

  const api = { configure, baseUrl, url, request, projects, expenses, receipts, reimbursements, payments, invoices, intents, intake, savedMethods, payables, disbursements, ledger, events, proposals, autopay, unmatched, payouts, finance, disputes, merchantConfig, merchantMock, merchantBoarding, merchantPortal };
  // Absent for org users: only the staff console shell defines PORTAL_CFG.
  if (staffActor()) api.admin = buildAdminNamespace();
  configure({ baseUrl: APP.paymentsApiBase || '' });
  root.PaymentsAPI = api;
})();
