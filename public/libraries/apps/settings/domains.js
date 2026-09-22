/* FirstMate domain onboarding for Company Settings and Web Editor. */
(function(){
  if (window.FirstMateDomainsSettings) return;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const clean = (value) => String(value ?? '').trim();
  const money = (value) => Number(value || 0).toLocaleString(undefined, { style:'currency', currency:'USD' });
  const obj = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const first = (...values) => {
    for (const value of values) {
      const text = clean(value);
      if (text) return text;
    }
    return '';
  };
  let cssReady = false;

  function ensureCss(){
    if (cssReady) return;
    cssReady = true;
    const style = document.createElement('style');
    style.textContent = `
      .dm-page{color:#101828}.dm-page *{box-sizing:border-box}.dm-page{display:grid;gap:18px}.dm-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.dm-hero h3{margin:0;font-size:24px}.dm-hero p{max-width:720px;margin:4px 0 0;color:#667085;font-size:12px;line-height:1.55}.dm-detail-heading{display:flex;align-items:center;gap:10px;min-width:0}.dm-detail-heading>div{min-width:0}.dm-detail-back{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;flex:0 0 32px;border:0;border-radius:9px;background:transparent;color:#667085;font-size:14px;cursor:pointer}.dm-detail-back:hover{background:#f2f4f7;color:var(--primary-readable,var(--primary,#d93025))}.dm-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:40px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;padding:8px 13px;color:#344054;font:900 11px/1.2 inherit;cursor:pointer}.dm-btn.primary{border-color:var(--primary-readable,var(--primary,#d93025));background:var(--primary-readable,var(--primary,#d93025));color:#fff}.dm-btn.danger{border-color:#b42318;background:#b42318;color:#fff}.dm-btn:disabled{opacity:.5;cursor:default}.dm-card{border:1px solid #e4e7ec;border-radius:14px;background:#fff;padding:16px;box-shadow:0 1px 3px rgba(16,24,40,.04)}.dm-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.dm-card h4{margin:0;font-size:14px}.dm-note{margin:5px 0 0;color:#667085;font-size:10px;line-height:1.5}.dm-owned{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:10px;margin-top:12px}.dm-owned-row{display:flex;min-width:0;min-height:190px;flex-direction:column;border:1px solid #e4e7ec;border-radius:12px;background:#fff;padding:14px;text-align:left}.dm-owned-row:hover{border-color:#d0d5dd;box-shadow:0 7px 18px rgba(16,24,40,.05)}.dm-domain-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;min-width:0}.dm-domain-card-title{min-width:0}.dm-owned-row strong{display:block;overflow:hidden;font-size:13px;text-overflow:ellipsis;white-space:nowrap}.dm-domain-meta{display:grid;gap:6px;margin-top:11px}.dm-domain-meta span{display:grid;grid-template-columns:12px minmax(0,1fr);align-items:start;gap:7px;min-width:0;color:#667085;font-size:10px;font-weight:750}.dm-domain-meta span i{width:12px;padding-top:1px;color:#98a2b3;text-align:center}.dm-domain-meta span b{min-width:0;color:#344054;line-height:1.35;overflow-wrap:anywhere}.dm-owned-row .dm-card-actions{margin-top:auto;padding-top:14px}.dm-card-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}.dm-badge{display:inline-flex;max-width:100%;flex:0 0 auto;border-radius:999px;background:#f2f4f7;padding:5px 8px;color:#475467;font-size:9px;font-weight:950;line-height:1.2;text-align:center;text-transform:uppercase;white-space:nowrap}.dm-badge.active,.dm-badge.ready_to_connect{background:#ecfdf3;color:#067647}.dm-badge.failed{background:#fef3f2;color:#b42318}.dm-manage-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;align-items:stretch}.dm-manage-card{display:grid;min-width:0;align-content:start;gap:12px;border:1px solid #e4e7ec;border-radius:12px;background:#fff;padding:15px}.dm-manage-card h4{display:flex;align-items:center;gap:8px;margin:0;font-size:13px}.dm-manage-card h4 i{color:var(--primary-readable,var(--primary,#d93025))}.dm-setting-row{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid #f2f4f7;padding-top:11px}.dm-setting-row:first-of-type{border-top:0;padding-top:0}.dm-setting-copy{min-width:0}.dm-setting-copy strong{font-size:11px}.dm-setting-copy p{margin:3px 0 0;color:#667085;font-size:9px;line-height:1.45;overflow-wrap:anywhere}.dm-switch{position:relative;width:38px;height:22px;flex:0 0 38px;border:0;border-radius:999px;background:#d0d5dd;cursor:pointer}.dm-switch:after{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);content:"";transition:.15s}.dm-switch.on{background:#12b76a}.dm-switch.on:after{transform:translateX(16px)}.dm-switch:disabled{cursor:default;opacity:.65}.dm-textarea{width:100%;min-height:76px;resize:vertical;border:1px solid #d0d5dd;border-radius:9px;padding:9px 11px;color:#344054;font:750 11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}.dm-danger-zone{border-color:#fecdca;background:#fffafa}.dm-workspace-head{margin-bottom:18px}.dm-workspace-head h3{margin:0;color:#101828;font-size:18px}.dm-workspace-head p{margin:5px 0 0;color:#667085;font-size:11px;font-weight:750}.dm-choice-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.dm-choice{display:grid;gap:8px;min-height:160px;border:1.5px solid #e4e7ec;border-radius:13px;background:#fff;padding:16px;text-align:left;cursor:pointer}.dm-choice:hover,.dm-choice.selected{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.08)}.dm-choice .icon{display:grid;place-items:center;width:34px;height:34px;border-radius:9px;background:#f2f4f7;color:#344054}.dm-choice strong{font-size:13px}.dm-choice span{color:#667085;font-size:10px;line-height:1.5}.dm-field{display:grid;gap:5px}.dm-field>span{color:#475467;font-size:10px;font-weight:900}.dm-input,.dm-select{width:100%;height:40px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;padding:0 11px;color:#344054;font:750 12px/1.4 inherit;outline:0}.dm-input:focus,.dm-select:focus{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.09)}.dm-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}.dm-wide{grid-column:1/-1}.dm-stack{display:grid;gap:14px}.dm-search-row{display:grid;grid-template-columns:minmax(0,1fr) 120px auto;gap:9px}.dm-results{display:grid;gap:8px}.dm-result{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;border:1.5px solid #e4e7ec;border-radius:11px;padding:12px;cursor:pointer}.dm-result.selected{border-color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.035)}.dm-result strong{display:block;font-size:12px}.dm-result small{color:#667085;font-size:9px}.dm-price{font-size:14px;font-weight:950}.dm-callout{border:1px solid #b2ddff;border-radius:11px;background:#eff8ff;padding:13px;color:#175cd3;font-size:10px;line-height:1.55}.dm-callout.warn{border-color:#fec84b;background:#fffaeb;color:#93370d}.dm-callout.danger{border-color:#fecdca;background:#fef3f2;color:#912018}.dm-summary{display:grid;gap:1px;border:1px solid #eaecf0;border-radius:11px;overflow:hidden;background:#eaecf0}.dm-summary-row{display:flex;justify-content:space-between;gap:15px;background:#fff;padding:11px 12px;font-size:10px}.dm-summary-row span{color:#667085}.dm-summary-row strong{text-align:right}.dm-check{display:flex;align-items:flex-start;gap:8px;color:#475467;font-size:10px;line-height:1.5}.dm-check input{margin-top:2px}.dm-loading{display:grid;place-items:center;min-height:260px;color:#667085;font-size:11px}.dm-success{text-align:center;padding:30px 10px}.dm-success .icon{display:grid;place-items:center;width:56px;height:56px;margin:0 auto 14px;border-radius:50%;background:#ecfdf3;color:#067647;font-size:22px}.dm-success h3{margin:0;font-size:20px}.dm-success p{max-width:520px;margin:7px auto;color:#667085;font-size:11px;line-height:1.55}.dm-error{min-height:16px;color:#b42318;font-size:10px;font-weight:800}@media(max-width:1020px){.dm-manage-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:680px){.dm-manage-grid{grid-template-columns:1fr}}@media(max-width:860px){.dm-choice-grid,.dm-grid,.dm-search-row{grid-template-columns:1fr}.dm-wide{grid-column:auto}}
      .dm-test-indicator{display:inline-flex;align-items:center;gap:5px;margin-bottom:8px;border:1px solid #fedf89;border-radius:999px;background:#fffaeb;padding:4px 7px;color:#93370d;font-size:8px;font-weight:950;letter-spacing:.04em;text-transform:uppercase}.dm-test-indicator i{font-size:7px}
      .dm-required{margin-left:5px;color:#b42318;font-size:8px;font-style:normal;font-weight:950;text-transform:uppercase}.dm-field.invalid .dm-input{border-color:#f04438;background:#fffafa}.dm-field-error{color:#b42318;font-size:9px;font-weight:800}.dm-error-panel{display:flex;align-items:flex-start;gap:9px;margin:0 0 16px;border:1px solid #fecdca;border-radius:10px;background:#fef3f2;padding:11px 12px;color:#912018;font-size:10px;font-weight:800;line-height:1.5}.dm-error-panel i{margin-top:2px}
      .dm-site-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.dm-site-tile{display:grid;align-content:start;gap:7px;min-height:120px;border:1.5px solid #e4e7ec;border-radius:12px;background:#fff;padding:14px;color:#344054;text-align:left;cursor:pointer}.dm-site-tile:hover,.dm-site-tile.selected{border-color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.035);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.07)}.dm-site-tile .icon{display:grid;place-items:center;width:32px;height:32px;border-radius:9px;background:#f2f4f7;color:var(--primary-readable,var(--primary,#d93025))}.dm-site-tile strong{font-size:12px}.dm-site-tile small{color:#667085;font-size:9px;line-height:1.4}.dm-email-builder{display:grid;grid-template-columns:minmax(120px,240px) auto;align-items:center;max-width:560px}.dm-email-builder .dm-input{border-radius:9px 0 0 9px}.dm-email-domain{display:flex;align-items:center;height:40px;border:1px solid #d0d5dd;border-left:0;border-radius:0 9px 9px 0;background:#f9fafb;padding:0 11px;color:#475467;font-size:11px;font-weight:900}
      @media(max-width:860px){.dm-site-grid{grid-template-columns:1fr}.dm-email-builder{grid-template-columns:minmax(100px,1fr) auto}}
    `;
    document.head.appendChild(style);
  }

  const stepsFor = (path) => path === 'existing'
    ? [{id:'choose',label:(globalThis.PlatformLanguage?.text("settings","m_797ea31cc00ed3","Choose a path") ?? "Choose a path")},{id:'domain',label:(globalThis.PlatformLanguage?.text("settings","m_63d6dcd088fd76","Domain details") ?? "Domain details")},{id:'review',label:(globalThis.PlatformLanguage?.text("settings","m_b0bb1e74e2a6d3","Review") ?? "Review")},{id:'verify',label:(globalThis.PlatformLanguage?.text("settings","m_e49e0037c107f5","Verify ownership") ?? "Verify ownership")},{id:'resources',label:(globalThis.PlatformLanguage?.text("settings","m_87a25ad6dd9349","Website & email") ?? "Website & email")},{id:'done',label:(globalThis.PlatformLanguage?.text("settings","m_e8e493437c1a17","Complete") ?? "Complete")}]
    : [{id:'choose',label:(globalThis.PlatformLanguage?.text("settings","m_797ea31cc00ed3","Choose a path") ?? "Choose a path")},{id:'domain',label:path === 'transfer' ? 'Transfer details' : 'Find a domain'},{id:'contact',label:(globalThis.PlatformLanguage?.text("settings","m_32daa8835c1999","Registrant details") ?? "Registrant details")},{id:'billing',label:(globalThis.PlatformLanguage?.text("settings","m_831d8d28763333","Billing") ?? "Billing")},{id:'review',label:(globalThis.PlatformLanguage?.text("settings","m_b0bb1e74e2a6d3","Review") ?? "Review")},{id:'verify',label:(globalThis.PlatformLanguage?.text("settings","m_731c0ec8f6eb3c","Verification") ?? "Verification")},{id:'resources',label:(globalThis.PlatformLanguage?.text("settings","m_87a25ad6dd9349","Website & email") ?? "Website & email")},{id:'done',label:(globalThis.PlatformLanguage?.text("settings","m_e8e493437c1a17","Complete") ?? "Complete")}];

  function splitPersonName(user = {}){
    const profile = obj(user.profile || user.workforce_profile);
    let firstName = first(user.first_name, user.firstName, profile.first_name, profile.firstName);
    let lastName = first(user.last_name, user.lastName, profile.last_name, profile.lastName);
    if (!firstName || !lastName) {
      const parts = first(user.name, user.display_name, user.displayName, profile.name).split(/\s+/).filter(Boolean);
      if (!firstName) firstName = parts.shift() || '';
      if (!lastName) lastName = parts.join(' ');
    }
    return { first_name:firstName, last_name:lastName };
  }

  function normalizedAddress(contact = {}){
    const addressValue = contact.business_address || contact.businessAddress || contact.address;
    const address = obj(addressValue || contact.location || contact.mailing_address);
    const result = {
      address1:first(address.address1, address.address_1, address.line1, address.street, contact.address1, contact.street),
      address2:first(address.address2, address.address_2, address.line2, contact.address2),
      city:first(address.city, address.locality, contact.city),
      state:first(address.state, address.region, address.province, contact.state, contact.region),
      postal_code:first(address.postal_code, address.postalCode, address.zip, address.zip_code, contact.postal_code, contact.postalCode, contact.zip),
      country:first(address.country_code, address.countryCode, address.country, contact.country_code, contact.country, 'US').toUpperCase()
    };
    const addressText = typeof addressValue === 'string' ? clean(addressValue) : '';
    if (addressText && !result.address1) {
      const parts = addressText.split(/\r?\n|,/).map(clean).filter(Boolean);
      result.address1 = parts[0] || addressText;
      if (parts.length >= 3) {
        let regionIndex = -1;
        let regionPostal = null;
        for (let index = parts.length - 1; index >= 2; index -= 1) {
          const match = parts[index].match(/^(.+?)\s+([A-Z0-9][A-Z0-9 -]{2,12})$/i);
          if (match) {
            regionIndex = index;
            regionPostal = match;
            break;
          }
        }
        if (regionPostal) {
          result.state = result.state || regionPostal[1];
          result.postal_code = result.postal_code || regionPostal[2];
          result.city = result.city || parts[regionIndex - 1];
          result.address2 = result.address2 || parts.slice(1, regionIndex - 1).join(', ');
          if (parts[regionIndex + 1]) result.country = parts[regionIndex + 1].length === 2 ? parts[regionIndex + 1].toUpperCase() : result.country;
        } else {
          result.city = result.city || parts[1];
          result.state = result.state || parts[2];
          if (parts[3]) result.country = parts[3].length === 2 ? parts[3].toUpperCase() : result.country;
        }
      }
    }
    return result;
  }

  async function loadRegistrantDefaults(orgId, supplied = {}){
    const branchId = first(window.Portal?.branchModules?.currentBranchId?.(), window.__APP?.userBranchId, 'default');
    const [portalResult, branchResult, usersResult] = await Promise.all([
      window.PlatformAPI?.orgs?.portalState?.(orgId).catch(() => null) || null,
      window.PlatformAPI?.branches?.get?.(orgId, branchId).catch(() => null) || null,
      window.PlatformAPI?.users?.list?.(orgId).catch(() => null) || null
    ]);
    const portalBranch = obj(portalResult?.branch?.data);
    const branch = obj(branchResult?.document?.data || branchResult?.data);
    const organization = obj(portalResult?.organization);
    const organizationData = obj(organization.data);
    const globalData = obj(portalResult?.global?.data);
    const contact = {
      ...obj(organizationData.contact),
      ...obj(globalData.contact),
      ...obj(portalBranch.contact),
      ...obj(branch.contact)
    };
    const users = Array.isArray(usersResult?.users) ? usersResult.users : [];
    const level = (user) => first(user?.org_permissions?.level, user?.org_permission_level, user?.permission_level, user?.role).toLowerCase().replace(/[\s-]+/g, '_');
    const superAdmins = users.filter((user) => !user?.deleted && !user?.disabled && level(user) === 'super_admin');
    const currentEmail = clean(window.__APP?.userEmail).toLowerCase();
    const administrator = superAdmins.find((user) => clean(user.email).toLowerCase() === currentEmail) || superAdmins[0] || {};
    const person = splitPersonName(administrator);
    const address = normalizedAddress(contact);
    const suppliedAddress = normalizedAddress({ address:supplied.address });
    return {
      first_name:first(supplied.first_name, person.first_name),
      last_name:first(supplied.last_name, person.last_name),
      org_name:first(supplied.org_name, branch.name, portalBranch.name, organization.name, organizationData.name),
      address1:first(supplied.address1, suppliedAddress.address1, address.address1),
      address2:first(supplied.address2, suppliedAddress.address2, address.address2),
      city:first(supplied.city, suppliedAddress.city, address.city),
      state:first(supplied.state, suppliedAddress.state, address.state),
      postal_code:first(supplied.postal_code, suppliedAddress.postal_code, address.postal_code),
      country:first(supplied.country, suppliedAddress.country, address.country, 'US').toUpperCase(),
      phone:first(supplied.phone, contact.phone, administrator.phone),
      email:first(supplied.email, contact.email, administrator.email)
    };
  }

  const contactLabels = {
    first_name:'First name',
    last_name:'Last name',
    org_name:'Organization',
    address1:'Street address',
    address2:'Address line 2',
    city:'City',
    state:'State / province',
    postal_code:'Postal code',
    country:'Country code',
    phone:'Phone',
    email:'Registrant email'
  };
  const requiredContactFields = ['first_name','last_name','address1','city','state','postal_code','country','phone','email'];

  function normalizeRegistrantPhone(value, country = 'US'){
    const raw = clean(value);
    const digits = raw.replace(/\D/g, '');
    if (raw.startsWith('+') && digits.length >= 7 && digits.length <= 15) return `+${digits}`;
    if (['US','CA'].includes(clean(country).toUpperCase())) {
      if (digits.length === 10) return `+1${digits}`;
      if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    }
    return raw;
  }

  function validateContact(contact = {}){
    const errors = {};
    requiredContactFields.forEach((name) => {
      if (!clean(contact[name])) errors[name] = `${contactLabels[name]} is required.`;
    });
    const country = clean(contact.country).toUpperCase();
    if (country && !/^[A-Z]{2}$/.test(country)) errors.country = 'Use the two-letter country code, such as US or CA.';
    const phone = normalizeRegistrantPhone(contact.phone, country);
    if (clean(contact.phone) && !/^\+[1-9]\d{6,14}$/.test(phone)) errors.phone = 'Enter a complete phone number, including country code.';
    if (clean(contact.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(contact.email))) errors.email = 'Enter a valid registrant email address.';
    return errors;
  }

  function domainRequestError(error, fallback){
    const issues = Array.isArray(error?.data?.details?.issues) ? error.data.details.issues : [];
    if (issues.length) {
      return issues.map((issue) => {
        const path = Array.isArray(issue.path) ? issue.path : [];
        const key = clean(path[path.length - 1]);
        const label = contactLabels[key] || key.replace(/_/g, ' ') || 'Request';
        return `${label}: ${clean(issue.message) || 'Invalid value'}`;
      }).join(' ');
    }
    return clean(error?.message) || fallback;
  }

  function contactFields(contact = {}, errors = {}){
    const field = (name,label,wide=false,placeholder='',type='text') => {
      const required = requiredContactFields.includes(name);
      const error = clean(errors[name]);
      return `<label class="dm-field ${wide?'dm-wide':''} ${error?'invalid':''}"><span>${esc(label)}${required?`<em class="dm-required">${(globalThis.PlatformLanguage?.text("settings","m_db97f048cd99aa","Required") ?? "Required")}</em>`:''}</span><input class="dm-input" name="${esc(name)}" type="${type}" value="${esc(contact[name] || '')}" placeholder="${esc(placeholder)}" ${required?'required':''} ${error?'aria-invalid="true" aria-describedby="dm-error-'+esc(name)+'"':''}>${error?`<small class="dm-field-error" id="dm-error-${esc(name)}">${esc(error)}</small>`:''}</label>`;
    };
    return `<div class="dm-grid">
      ${field('first_name','First name')}${field('last_name','Last name')}${field('org_name','Organization (optional)',true)}
      ${field('address1','Street address',true)}${field('address2','Address line 2',true)}
      ${field('city','City')}${field('state','State / province')}${field('postal_code','Postal code')}${field('country','Country code',false,'US')}
      ${field('phone','Phone',false,'+12065550100')}${field('email','Registrant email',false,'name@company.com','email')}
    </div>`;
  }

  function openWizard(options, initialPath = '', initialStep = ''){
    const orgId = clean(options.orgId);
    const orderTestMode = options.config?.order_test_mode === true;
    const state = {
      path: initialPath,
      step: initialPath ? 'domain' : 'choose',
      domain: '',
      quote: null,
      item: null,
      contact: { ...obj(options.registrantDefaults) },
      authCode: '',
      registration: null,
      busy: false,
      error: '',
      sites: [],
      websiteMode: '',
      websiteName: 'Main Website',
      defaultEmailLocalPart: 'info',
      connectedWebsiteId: '',
      fieldErrors: {},
      visitedSteps: new Set([initialPath ? 'domain' : 'choose'])
    };
    // Honor a deep-linked workflow_step when it exists for the current path.
    const requestedStep = clean(initialStep);
    if (requestedStep && requestedStep !== state.step) {
      const stepIds = stepsFor(state.path).map((entry) => entry.id);
      const requestedIndex = stepIds.indexOf(requestedStep);
      if (requestedIndex >= 0) {
        state.step = requestedStep;
        state.visitedSteps = new Set(stepIds.slice(0, requestedIndex + 1));
      }
    }
    let wizard = null;
    const root = () => wizard?.el || null;
    const render = () => wizard?.refresh?.();
    const close = () => wizard?.close?.();

    function go(step){
      if (!wizard || wizard.ctx.stepId === step) {
        state.error = '';
        if (step !== 'contact') state.fieldErrors = {};
        state.step = step;
        state.visitedSteps.add(step);
        render();
        return;
      }
      wizard.goTo(step);
    }
    function captureVisibleDraft(){
      const values = readVisibleFields();
      if (state.step === 'domain') {
        if (values.domain) state.domain = values.domain.toLowerCase();
        if (state.path === 'transfer' && values.auth_code) state.authCode = values.auth_code;
      }
      if (state.step === 'contact') state.contact = { ...state.contact, ...values };
      if (state.step === 'resources') {
        if (values.website_name) state.websiteName = values.website_name;
        if (values.default_email_local_part) state.defaultEmailLocalPart = values.default_email_local_part.toLowerCase();
      }
    }
    function nextStep(){
      const steps = stepsFor(state.path);
      return steps[Math.min(steps.length - 1, steps.findIndex((entry) => entry.id === state.step) + 1)]?.id || 'done';
    }
    function prevStep(){
      const steps = stepsFor(state.path);
      return steps[Math.max(0, steps.findIndex((entry) => entry.id === state.step) - 1)]?.id || 'choose';
    }
    function setBusy(value, error=''){ state.busy = value; state.error = error; render(); }

    function headerCopy(){
      return {
        choose:['Register a domain','Choose how you want to bring a domain into FirstMate.'],
        domain:[state.path==='register'?'Find your domain':state.path==='transfer'?'Transfer your domain':'Connect your domain',state.path==='register'?'Search live availability and pricing.':state.path==='transfer'?'Enter the domain you already own and its transfer code.':'Verify a domain that will stay with its current provider.'],
        contact:['Registrant information','Use accurate owner information so the domain remains in good standing.'],
        billing:['Billing','Review how payment will fit into this workflow.'],
        review:['Review & confirm',state.path==='existing'?'Create the connection without moving the domain.':'Nothing is submitted until you confirm below.'],
        verify:['Verify the domain','Complete the required ownership or registrant verification.'],
        resources:['Website & email','Choose the website and its default email address.'],
        done:['Domain setup complete','The domain has been added to FirstMate.']
      }[state.step] || ['Domain setup',''];
    }

    function stepComplete(id){
      if (id === 'choose') return !!state.path;
      if (id === 'domain') return state.path === 'register' ? !!state.item : /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(state.domain) && (state.path !== 'transfer' || !!state.authCode);
      if (id === 'contact') return ['first_name','last_name','address1','city','state','postal_code','country','phone','email'].every((key) => clean(state.contact[key]));
      if (id === 'billing') return state.visitedSteps.has('review') || !!state.registration;
      if (id === 'review') return !!state.registration;
      if (id === 'verify') return !!(state.registration?.verified_at || state.registration?.status === 'ready_to_connect' || state.registration?.status === 'active');
      if (id === 'resources') return state.visitedSteps.has('done');
      return id === 'done' && state.step === 'done';
    }
    function stepStatus(id){
      const active = state.step === id;
      const isComplete = stepComplete(id);
      const visited = state.visitedSteps.has(id);
      return {
        state: active ? '' : isComplete ? 'done' : visited ? 'needs-attention' : '',
        label: active ? 'Current step' : isComplete ? 'Complete' : visited ? 'In progress' : 'Not started',
        icon: isComplete ? 'fa-check' : ''
      };
    }

    function bodyHtml(){
      if (state.busy) return `<div class="dm-loading"><span><i class="fas fa-circle-notch fa-spin"></i>${(globalThis.PlatformLanguage?.text("settings","m_1171f9997c2e9d"," Working securely…") ?? " Working securely…")}</span></div>`;
      if (state.step === 'choose') return `<div class="dm-choice-grid">
        <button class="dm-choice ${String(state.path==='register'?'selected':'')}" data-path="register"><span class="icon"><i class="fas fa-magnifying-glass"></i></span><strong>${(globalThis.PlatformLanguage?.text("settings","m_ace49b1ec21514","Register a new domain") ?? "Register a new domain")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_21c37b64d61db2","Search available names, see the annual price, and register one without leaving FirstMate.") ?? "Search available names, see the annual price, and register one without leaving FirstMate.")}</span></button>
        <button class="dm-choice ${String(state.path==='transfer'?'selected':'')}" data-path="transfer"><span class="icon"><i class="fas fa-arrow-right-arrow-left"></i></span><strong>${(globalThis.PlatformLanguage?.text("settings","m_d7d9771f85e390","Transfer a domain") ?? "Transfer a domain")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_0f29ad8eda1299","Move a domain from another provider using its authorization code.") ?? "Move a domain from another provider using its authorization code.")}</span></button>
        <button class="dm-choice ${String(state.path==='existing'?'selected':'')}" data-path="existing"><span class="icon"><i class="fas fa-link"></i></span><strong>${(globalThis.PlatformLanguage?.text("settings","m_bbc1cdea0b61c7","Use an existing domain") ?? "Use an existing domain")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_90012b00013e8d","Keep it where it is and connect it to a FirstMate website with DNS.") ?? "Keep it where it is and connect it to a FirstMate website with DNS.")}</span></button>
      </div>`;
      if (state.step === 'domain' && state.path === 'register') return `<div class="dm-stack">
        <form class="dm-search-row" data-search><input class="dm-input" name="domain" placeholder="${(globalThis.PlatformLanguage?.text("settings","m_992a2b48510215","yourcompany.com") ?? "yourcompany.com")}" value="${String(esc(state.domain))}" required><select class="dm-select" name="period"><option value="1">${(globalThis.PlatformLanguage?.text("settings","m_4b231e0cddf70e","1 year") ?? "1 year")}</option><option value="2">${(globalThis.PlatformLanguage?.text("settings","m_36823ec15426a4","2 years") ?? "2 years")}</option><option value="3">${(globalThis.PlatformLanguage?.text("settings","m_2ddbc007deaf45","3 years") ?? "3 years")}</option></select><button class="dm-btn primary" type="submit"><i class="fas fa-magnifying-glass"></i>${(globalThis.PlatformLanguage?.text("settings","m_df7ced82563784"," Search") ?? " Search")}</button></form>
        <p class="dm-note">${(globalThis.PlatformLanguage?.text("settings","m_d2472bc3032884","Prices include private registration where available. Quotes remain valid for 10 minutes.") ?? "Prices include private registration where available. Quotes remain valid for 10 minutes.")}</p>
        <div class="dm-results">${String(state.quote ? (state.quote.items||[]).map((item) => `<button type="button" class="dm-result ${state.item?.domain===item.domain?'selected':''}" data-domain="${esc(item.domain)}" ${item.available?'':'disabled'}><span><strong>${esc(item.domain)}</strong><small>${item.available?(item.premium?'Premium domain · available':'Available'):(item.reason||'Unavailable')}</small></span>${item.available?`<span class="dm-price">${money(item.price)} <small>/ ${Number(state.quote.period||1)} yr</small></span>`:'<span class="dm-badge">Unavailable</span>'}</button>`).join('') : '')}</div>
      </div>`;
      if (state.step === 'domain' && state.path === 'transfer') return `<div class="dm-stack">
        <label class="dm-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_0583d77b73123f","Domain") ?? "Domain")}</span><input class="dm-input" name="domain" value="${String(esc(state.domain))}" placeholder="${(globalThis.PlatformLanguage?.text("settings","m_992a2b48510215","yourcompany.com") ?? "yourcompany.com")}" required></label>
        <label class="dm-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_9aa8861c7c8cd7","Transfer authorization code") ?? "Transfer authorization code")}</span><input class="dm-input" name="auth_code" value="${String(esc(state.authCode))}" type="password" autocomplete="off" required></label>
        <div class="dm-callout"><strong>${(globalThis.PlatformLanguage?.text("settings","m_55276993d9d6f3","Before continuing:") ?? "Before continuing:")}</strong>${(globalThis.PlatformLanguage?.text("settings","m_64d5141284d640"," unlock the domain at its current provider and request its transfer authorization code. Most transfers take several days after approval.") ?? " unlock the domain at its current provider and request its transfer authorization code. Most transfers take several days after approval.")}</div>
        ${String(state.item ? `<div class="dm-summary"><div class="dm-summary-row"><span>Transfer price</span><strong>${money(state.item.price)} USD</strong></div><div class="dm-summary-row"><span>Term</span><strong>1 year</strong></div></div>` : '')}
      </div>`;
      if (state.step === 'domain') return `<div class="dm-stack"><label class="dm-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_0583d77b73123f","Domain") ?? "Domain")}</span><input class="dm-input" name="domain" value="${String(esc(state.domain))}" placeholder="${(globalThis.PlatformLanguage?.text("settings","m_992a2b48510215","yourcompany.com") ?? "yourcompany.com")}" required></label><div class="dm-callout">${(globalThis.PlatformLanguage?.text("settings","m_0c5ea6ccc9c380","The domain stays with its current provider. After review, we’ll give you one TXT record to add so FirstMate can verify ownership.") ?? "The domain stays with its current provider. After review, we’ll give you one TXT record to add so FirstMate can verify ownership.")}</div></div>`;
      if (state.step === 'contact') return contactFields(state.contact, state.fieldErrors);
      if (state.step === 'billing') return `<div class="dm-stack"><div class="dm-callout warn"><strong>${(globalThis.PlatformLanguage?.text("settings","m_8f6d475b4c012b","Billing is not connected yet.") ?? "Billing is not connected yet.")}</strong>${(globalThis.PlatformLanguage?.text("settings","m_8503c67dd86572"," This onboarding flow includes the billing checkpoint, but no card is collected and no payment is processed by FirstMate in this version.") ?? " This onboarding flow includes the billing checkpoint, but no card is collected and no payment is processed by FirstMate in this version.")}</div><div class="dm-summary"><div class="dm-summary-row"><span>${((v0) => globalThis.PlatformLanguage?.text("settings","m_b8751f2d4f8ddb",`${v0} total`,{v0}) ?? `${v0} total`)(state.path==='transfer'?'Transfer':'Registration')}</span><strong>${((v1) => globalThis.PlatformLanguage?.text("settings","m_d4f554dfb70d83",`${v1} USD`,{v1}) ?? `${v1} USD`)(money(state.item?.price))}</strong></div><div class="dm-summary-row"><span>${(globalThis.PlatformLanguage?.text("settings","m_5a3350b9db25e3","Payment status") ?? "Payment status")}</span><strong>${(globalThis.PlatformLanguage?.text("settings","m_f56737918370dc","Deferred for this test workflow") ?? "Deferred for this test workflow")}</strong></div><div class="dm-summary-row"><span>${(globalThis.PlatformLanguage?.text("settings","m_003d0cd4d5dd21","Renewal") ?? "Renewal")}</span><strong>${(globalThis.PlatformLanguage?.text("settings","m_13fce6e531a8b0","Automatic renewal enabled") ?? "Automatic renewal enabled")}</strong></div></div></div>`;
      if (state.step === 'review') return `<div class="dm-stack"><div class="dm-summary">
        <div class="dm-summary-row"><span>${(globalThis.PlatformLanguage?.text("settings","m_0583d77b73123f","Domain") ?? "Domain")}</span><strong>${String(esc(state.domain))}</strong></div>
        <div class="dm-summary-row"><span>${(globalThis.PlatformLanguage?.text("settings","m_b06faf127e1505","Setup") ?? "Setup")}</span><strong>${String(state.path==='register'?'New registration':state.path==='transfer'?'Transfer':'Existing domain connection')}</strong></div>
        ${String(state.path==='existing'?'':`<div class="dm-summary-row"><span>Total</span><strong>${money(state.item?.price)} USD</strong></div><div class="dm-summary-row"><span>Registrant</span><strong>${esc(`${state.contact.first_name||''} ${state.contact.last_name||''}`.trim())}</strong></div>`)}
        <div class="dm-summary-row"><span>${(globalThis.PlatformLanguage?.text("settings","m_88ce17162a6464","Billing collected") ?? "Billing collected")}</span><strong>${(globalThis.PlatformLanguage?.text("settings","m_2f0222913078f4","No") ?? "No")}</strong></div>
      </div><div class="dm-callout ${String(state.path==='existing'||orderTestMode?'':'danger')}">${String(state.path==='existing'?'<strong>No transfer or purchase.</strong> This creates a DNS verification record only.':orderTestMode?`<strong>Test mode.</strong> This simulates the ${state.path==='transfer'?'transfer':'registration'} and does not submit an order to OpenSRS or incur a domain charge.`:`<strong>Final confirmation.</strong> Submitting can create a live ${state.path==='transfer'?'transfer order':'domain registration'} and incur the displayed domain cost even though FirstMate billing is not connected.`)}</div>
      <label class="dm-check"><input type="checkbox" data-attest> <span>${(globalThis.PlatformLanguage?.text("settings","m_7e9b2776dcfade","I confirm the information is accurate, accept the domain registration terms, and authorize this request.") ?? "I confirm the information is accurate, accept the domain registration terms, and authorize this request.")}</span></label>
      </div>`;
      if (state.step === 'verify') {
        const verification = obj(state.registration?.verification);
        if (state.registration?.status === 'ready_to_connect' || state.registration?.verified_at) return `<div class="dm-success"><div class="icon"><i class="fas fa-check"></i></div><h3>${(globalThis.PlatformLanguage?.text("settings","m_3e37522560abc5","Verification complete") ?? "Verification complete")}</h3><p>${(globalThis.PlatformLanguage?.text("settings","m_a34714579052b0","Continue to choose the website and default email address for this domain.") ?? "Continue to choose the website and default email address for this domain.")}</p></div>`;
        return state.path === 'existing'
          ? `<div class="dm-stack"><div class="dm-callout"><strong>${(globalThis.PlatformLanguage?.text("settings","m_15d09fc348b12e","Add this TXT record in your DNS:") ?? "Add this TXT record in your DNS:")}</strong></div><div class="dm-summary"><div class="dm-summary-row"><span>${(globalThis.PlatformLanguage?.text("settings","m_523563ae2fd488","Host") ?? "Host")}</span><strong>${String(esc(verification.host||''))}</strong></div><div class="dm-summary-row"><span>${(globalThis.PlatformLanguage?.text("settings","m_ec6b76d100b0ec","Value") ?? "Value")}</span><strong style="word-break:break-all">${String(esc(verification.value||''))}</strong></div></div><p class="dm-note">${(globalThis.PlatformLanguage?.text("settings","m_2316222487e5d5","DNS changes can take time to appear. You can close this workflow and return later.") ?? "DNS changes can take time to appear. You can close this workflow and return later.")}</p></div>`
          : state.registration?.simulated
            ? `<div class="dm-stack"><div class="dm-callout warn"><strong>${(globalThis.PlatformLanguage?.text("settings","m_8b24faed53b69a","Test verification is pending.") ?? "Test verification is pending.")}</strong>${(globalThis.PlatformLanguage?.text("settings","m_74c889fbc5e08d"," In live mode FirstMate waits for the registrar to confirm the registrant. Use the test control below to simulate that confirmation and inspect the end-user experience.") ?? " In live mode FirstMate waits for the registrar to confirm the registrant. Use the test control below to simulate that confirmation and inspect the end-user experience.")}</div><p class="dm-note">${(globalThis.PlatformLanguage?.text("settings","m_7ced1188e01de2","No verification or reminder email is sent by this test workflow.") ?? "No verification or reminder email is sent by this test workflow.")}</p></div>`
            : `<div class="dm-stack"><div class="dm-callout"><strong>${(globalThis.PlatformLanguage?.text("settings","m_93a318cf3fe7c1","Waiting for registrar confirmation.") ?? "Waiting for registrar confirmation.")}</strong>${(globalThis.PlatformLanguage?.text("settings","m_62a9f6ffb8e41b"," FirstMate will keep checking the registrant verification status. A reminder option becomes available only if it is still incomplete after one hour.") ?? " FirstMate will keep checking the registrant verification status. A reminder option becomes available only if it is still incomplete after one hour.")}</div><p class="dm-note">${(globalThis.PlatformLanguage?.text("settings","m_b4e522c39f6665","You can close this workflow and return later without losing progress.") ?? "You can close this workflow and return later without losing progress.")}</p></div>`;
      }
      if (state.step === 'resources') {
        const sites = state.sites.filter((site)=>clean(site.site_kind)!=='customer_portal'&&clean(site.status)!=='archived');
        return `<div class="dm-stack"><div><h4 style="margin:0 0 5px;font-size:13px">${(globalThis.PlatformLanguage?.text("settings","m_9dc897dcba7a79","Choose a website") ?? "Choose a website")}</h4><p class="dm-note" style="margin-bottom:10px">${(globalThis.PlatformLanguage?.text("settings","m_d9cc78af9742bf","This domain will become the selected website’s primary domain.") ?? "This domain will become the selected website’s primary domain.")}</p><div class="dm-site-grid">${String(sites.map((site)=>`<button type="button" class="dm-site-tile ${state.websiteMode===`existing:${site.id}`?'selected':''}" data-website-choice="existing:${esc(site.id)}"><span class="icon"><i class="fas fa-window-maximize"></i></span><strong>${esc(site.name||'Website')}</strong><small>${esc(clean(site.status||'draft').replace(/_/g,' '))}</small></button>`).join(''))}<button type="button" class="dm-site-tile ${String(state.websiteMode==='create'?'selected':'')}" data-website-choice="create"><span class="icon"><i class="fas fa-plus"></i></span><strong>${(globalThis.PlatformLanguage?.text("settings","m_a7b6365a404298","Create a new website") ?? "Create a new website")}</strong><small>${(globalThis.PlatformLanguage?.text("settings","m_30e9f05dba7fa9","Start a fresh hosted website for this domain.") ?? "Start a fresh hosted website for this domain.")}</small></button></div></div>
        ${String(state.websiteMode==='create'?`<label class="dm-field"><span>New website name <em class="dm-required">Required</em></span><input class="dm-input" name="website_name" value="${esc(state.websiteName)}" placeholder="Main Website" required></label>`:'')}
        <div><h4 style="margin:0 0 5px;font-size:13px">${(globalThis.PlatformLanguage?.text("settings","m_715488f4d0b6d4","Default email address") ?? "Default email address")}</h4><p class="dm-note" style="margin-bottom:9px">${(globalThis.PlatformLanguage?.text("settings","m_33079737eef674","FirstMate will use this address for incoming email and as the default sender for automated website email. Provider and DNS activation will be completed during email setup.") ?? "FirstMate will use this address for incoming email and as the default sender for automated website email. Provider and DNS activation will be completed during email setup.")}</p><label class="dm-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_4327ac34fcf20c","Email address ") ?? "Email address ")}<em class="dm-required">${(globalThis.PlatformLanguage?.text("settings","m_db97f048cd99aa","Required") ?? "Required")}</em></span><div class="dm-email-builder"><input class="dm-input" name="default_email_local_part" value="${String(esc(state.defaultEmailLocalPart))}" aria-label="${(globalThis.PlatformLanguage?.text("settings","m_e7e9c2f0efc1df","Default email name") ?? "Default email name")}" required><span class="dm-email-domain">@${String(esc(state.domain))}</span></div></label></div></div>`;
      }
      return `<div class="dm-success"><div class="icon"><i class="fas fa-check"></i></div><h3>${((v0) => globalThis.PlatformLanguage?.text("settings","m_4ce45455f4515a",`${v0} is ready`,{v0}) ?? `${v0} is ready`)(esc(state.domain))}</h3><p>${String(state.registration?.website_id?'The domain and default email address are attached to your website. Open Web Editor to continue building.':'The domain setup has been saved.')}</p></div>`;
    }

    function footerActionsHtml(){
      if (state.busy) return '';
      if (state.step === 'done') return `<button class="dm-btn primary" data-finish><i class="fas fa-arrow-up-right-from-square"></i>${(globalThis.PlatformLanguage?.text("settings","m_c600b08bd97509"," Open Web Editor") ?? " Open Web Editor")}</button>`;
      if (state.step === 'verify') {
        const verified=state.registration?.verified_at||state.registration?.status==='ready_to_connect'||state.registration?.status==='active';
        const reminderAt=Date.parse(clean(state.registration?.verification_reminder_available_at));
        const reminderReady=Number.isFinite(reminderAt)&&reminderAt<=Date.now();
        if (verified) return `<button class="dm-btn" data-back>${(globalThis.PlatformLanguage?.text("settings","m_121372231b5699","Back") ?? "Back")}</button><button class="dm-btn primary" data-next>${(globalThis.PlatformLanguage?.text("settings","m_854c72abba5166","Continue ") ?? "Continue ")}<i class="fas fa-arrow-right"></i></button>`;
        if (state.registration?.simulated) return `<button class="dm-btn" data-back>${(globalThis.PlatformLanguage?.text("settings","m_121372231b5699","Back") ?? "Back")}</button><button class="dm-btn primary" data-check><i class="fas fa-flask"></i>${(globalThis.PlatformLanguage?.text("settings","m_357b27f0dd099b"," Complete test verification") ?? " Complete test verification")}</button>`;
        return `<button class="dm-btn" data-back>${(globalThis.PlatformLanguage?.text("settings","m_121372231b5699","Back") ?? "Back")}</button>${String(state.path==='existing'?'<button class="dm-btn" data-resend>Copy DNS values</button>':reminderReady?'<button class="dm-btn" data-resend>Send reminder email</button>':'')}<button class="dm-btn primary" data-check><i class="fas fa-rotate"></i>${(globalThis.PlatformLanguage?.text("settings","m_ffb92d3f243a29"," Check status") ?? " Check status")}</button>`;
      }
      return `${state.step==='choose'?'':`<button class="dm-btn" data-back>${(globalThis.PlatformLanguage?.text("settings","m_121372231b5699","Back") ?? "Back")}</button>`}<button class="dm-btn primary" data-next>${state.step==='review'?(state.path==='existing'?'Create connection':state.path==='transfer'?'Start transfer':'Register domain'):'Continue'} <i class="fas fa-arrow-right"></i></button>`;
    }

    function renderStep(container){
      const [title,subtitle] = headerCopy();
      container.innerHTML = `<div class="dm-workspace-head"><h3>${esc(title)}</h3><p>${esc(subtitle)}</p></div>${state.error?`<div class="dm-error-panel" role="alert"><i class="fas fa-circle-exclamation"></i><span>${esc(state.error)}</span></div>`:''}${bodyHtml()}`;
      container.querySelectorAll('[data-path]').forEach((button) => button.addEventListener('click', () => {
        state.path=button.dataset.path;
        state.visitedSteps=new Set(['choose','domain']);
        go('domain');
      }));
      container.querySelector('[data-search]')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        state.domain=clean(data.get('domain')).toLowerCase();
        setBusy(true);
        try {
          const response=await window.DomainsAPI.quote(orgId,[state.domain],Number(data.get('period')||1),'register');
          state.quote=response.quote; state.item=null; setBusy(false);
        } catch(error) { setBusy(false,error?.message||'Could not search domains.'); }
      });
      container.querySelectorAll('[data-domain]').forEach((button)=>button.addEventListener('click',()=>{ state.item=(state.quote?.items||[]).find((item)=>item.domain===button.dataset.domain)||null; state.domain=clean(button.dataset.domain); render(); }));
      container.querySelectorAll('[data-website-choice]').forEach((button)=>button.addEventListener('click',()=>{ captureVisibleDraft(); state.websiteMode=clean(button.dataset.websiteChoice); render(); }));
      container.querySelector('[name="website_name"]')?.addEventListener('input',(event)=>{ state.websiteName=event.currentTarget.value; });
      container.querySelector('[name="default_email_local_part"]')?.addEventListener('input',(event)=>{ state.defaultEmailLocalPart=event.currentTarget.value; });
    }

    function renderFooter(container){
      container.innerHTML = footerActionsHtml();
      container.querySelector('[data-back]')?.addEventListener('click',()=>{ captureVisibleDraft(); go(prevStep()); });
      container.querySelector('[data-next]')?.addEventListener('click',handleNext);
      container.querySelector('[data-finish]')?.addEventListener('click',finishWizard);
      container.querySelector('[data-check]')?.addEventListener('click',checkVerification);
      container.querySelector('[data-resend]')?.addEventListener('click',resendVerification);
    }

    function readVisibleFields(){
      const values = {};
      root()?.querySelectorAll('input[name],select[name]').forEach((field)=>{ values[field.name]=clean(field.value); });
      return values;
    }
    async function handleNext(){
      state.error='';
      if (state.step==='choose') { if (!state.path) { state.error='Choose how you want to add the domain.'; render(); return; } go('domain'); return; }
      if (state.step==='domain') {
        const values=readVisibleFields();
        if (state.path==='register') {
          if (!state.item) { state.error='Search for and select an available domain.'; render(); return; }
        } else {
          state.domain=clean(values.domain).toLowerCase();
          if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(state.domain)) { state.error='Enter a valid domain name.'; render(); return; }
          if (state.path==='transfer') {
            state.authCode=values.auth_code;
            if (!state.authCode) { state.error='Enter the transfer authorization code.'; render(); return; }
            setBusy(true);
            try {
              const response=await window.DomainsAPI.quote(orgId,[state.domain],1,'transfer');
              state.quote=response.quote; state.item=response.quote?.items?.[0];
              if (!state.item?.available) throw new Error('A transfer price is not available for this domain.');
              setBusy(false); go('contact'); return;
            } catch(error) { setBusy(false,error?.message||'Could not price this transfer.'); return; }
          }
        }
        go(nextStep()); return;
      }
      if (state.step==='contact') {
        const values=readVisibleFields();
        state.contact={ ...state.contact, ...values };
        state.contact.country=clean(state.contact.country).toUpperCase();
        state.contact.email=clean(state.contact.email).toLowerCase();
        state.contact.phone=normalizeRegistrantPhone(state.contact.phone,state.contact.country);
        state.fieldErrors=validateContact(state.contact);
        if (Object.keys(state.fieldErrors).length) {
          const missing=Object.keys(state.fieldErrors).map((key)=>contactLabels[key]||key).join(', ');
          state.error=`Please correct the highlighted registrant fields: ${missing}. Your entries have been preserved.`;
          render();
          return;
        }
        go('billing'); return;
      }
      if (state.step==='billing') { go('review'); return; }
      if (state.step==='review') {
        const attested=root()?.querySelector('[data-attest]')?.checked===true;
        if (!attested) { state.error='Confirm the authorization before continuing.'; render(); return; }
        setBusy(true);
        try {
          let response;
          if (state.path==='register') response=await window.DomainsAPI.register(orgId,{quote_id:state.quote.id,domain:state.domain,contact:state.contact,accept_price:String(state.item.price),attestation:true,allow_premium:state.item.premium===true});
          else if (state.path==='transfer') response=await window.DomainsAPI.transfer(orgId,{quote_id:state.quote.id,domain:state.domain,auth_code:state.authCode,contact:state.contact,accept_price:String(state.item.price),attestation:true,allow_premium:state.item.premium===true});
          else response=await window.DomainsAPI.connect(orgId,state.domain);
          state.registration=response.registration;
          setBusy(false); go('verify'); return;
        } catch(error) { setBusy(false,domainRequestError(error,'The domain request could not be completed.')); return; }
      }
      if (state.step==='verify') {
        const verified=state.registration?.verified_at||state.registration?.status==='ready_to_connect'||state.registration?.status==='active';
        if (!verified) { state.error='Complete verification before continuing.'; render(); return; }
        await loadResources();
        go('resources');
        return;
      }
      if (state.step==='resources') {
        const values=readVisibleFields();
        state.websiteName=clean(values.website_name||state.websiteName);
        state.defaultEmailLocalPart=clean(values.default_email_local_part||state.defaultEmailLocalPart).toLowerCase();
        if (!state.websiteMode) { state.error='Choose an existing website or create a new one.'; render(); return; }
        if (state.websiteMode==='create'&&!state.websiteName) { state.error='Enter a name for the new website.'; render(); return; }
        if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(state.defaultEmailLocalPart)) {
          state.error='Enter a valid default email name using letters, numbers, periods, underscores, or hyphens.';
          render();
          return;
        }
        const website=state.websiteMode==='create'?{mode:'create',name:state.websiteName}:{mode:'existing',id:state.websiteMode.slice(9)};
        setBusy(true);
        try {
          const response=await window.DomainsAPI.attachResources(orgId,state.domain,{website,default_email_local_part:state.defaultEmailLocalPart});
          state.registration=response.registration;
          state.connectedWebsiteId=clean(response.website_id||response.registration?.website_id);
          setBusy(false); go('done');
        } catch(error) { setBusy(false,error?.message||'Could not connect the domain resources.'); }
      }
    }
    async function checkVerification(){
      setBusy(true);
      try {
        const response=await window.DomainsAPI.checkVerification(orgId,state.domain);
        state.registration=response.registration;
        if (state.registration?.verified_at||state.registration?.status==='ready_to_connect'||state.registration?.status==='active') {
          await loadResources();
        }
        setBusy(false);
      } catch(error) { setBusy(false,error?.message||'Could not check verification.'); }
    }
    async function resendVerification(){
      if (state.path==='existing') {
        const verification=obj(state.registration?.verification);
        await navigator.clipboard?.writeText?.(`Host: ${verification.host}\nValue: ${verification.value}`);
        state.error='DNS values copied.'; render(); return;
      }
      setBusy(true);
      try { const response=await window.DomainsAPI.resendVerification(orgId,state.domain); state.registration=response.registration; setBusy(false); state.error='Verification reminder sent.'; render(); }
      catch(error) { setBusy(false,error?.message||'Could not send the verification reminder.'); }
    }
    async function loadResources(){
      try {
        const sites=await (window.WebsitesAPI?.sites?.list?.(orgId).catch(()=>({sites:[]}))||{sites:[]});
        state.sites=Array.isArray(sites?.sites)?sites.sites:[];
        const available=state.sites.filter((site)=>clean(site.site_kind)!=='customer_portal'&&clean(site.status)!=='archived');
        if (!state.websiteMode) {
          const main=available.find((site)=>clean(site.name).toLowerCase()==='main website')||available[0];
          state.websiteMode=main?`existing:${main.id}`:'create';
        }
      } catch(_error) {}
    }
    async function finishWizard(){
      const websiteId=clean(state.connectedWebsiteId||state.registration?.website_id);
      if (!websiteId) {
        state.error='The website connection is missing. Go back to Website & email and select or create a website before opening Web Editor.';
        state.visitedSteps.add('resources');
        render();
        return;
      }
      const navigation=window.Portal?.navigation;
      if (!navigation?.push || !navigation?.applyCurrent) {
        state.error='Web Editor could not be opened. Refresh the portal and try again.';
        render();
        return;
      }
      navigation.push(
        { tab:'web_editor', sub:'', workflow:'', workflow_step:'', site:websiteId, page:'', view:'', domainSettings:'' },
        { source:'domain-onboarding-open-website', ownedKeys:['tab','site'] }
      );
      await navigation.applyCurrent({ source:'domain-onboarding-open-website', force:true });
      wizard?.close?.({ fromRoute:true });
    }
    loadResources();
    wizard = window.FirstMateSetupWizard.open({
      id:'domain-onboarding',
      workflowKey:'domain_onboarding',
      title:(globalThis.PlatformLanguage?.text("settings","m_7e6427ce4061f4","Domains & Hosting") ?? "Domains & Hosting"),
      icon:'fa-globe',
      initialStepId:state.step,
      state,
      steps:() => stepsFor(state.path).map((entry) => ({
        id:entry.id,
        label:entry.label,
        render:(container) => renderStep(container),
        renderFooter:(container) => renderFooter(container),
        status:() => stepStatus(entry.id)
      })),
      subtitle:() => { const [title, subtitle] = headerCopy(); return `${title} · ${subtitle}`; },
      railNote:() => `${orderTestMode?`<span class="dm-test-indicator"><i class="fas fa-flask"></i>${(globalThis.PlatformLanguage?.text("settings","m_1fbbd370250cd9"," Test mode") ?? " Test mode")}</span><br>`:''}Private registration, renewal protection, and domain lock are enabled where supported.`,
      stepNavigable:(stepId) => state.visitedSteps.has(stepId),
      canClose:(reason) => reason === 'button' || reason === 'route' || !state.busy,
      onBeforeStep:() => { if (root()) captureVisibleDraft(); },
      onStepChange:(stepId) => {
        state.error = '';
        if (stepId !== 'contact') state.fieldErrors = {};
        state.step = stepId;
        state.visitedSteps.add(stepId);
      },
      writeRoute:(patch, routeOptions) => {
        if (options.writeRoute) { options.writeRoute(patch, routeOptions); return; }
        window.Portal?.navigation?.write?.({ tab:'company_settings', sub:'domains', ...patch }, { ...routeOptions, ownedKeys:['tab','sub','workflow','workflow_step'] });
      },
      closeRoute:options.closeRoute
    });
    return { close };
  }

  async function legacyMount(options = {}){
    ensureCss();
    const pane=options.pane;
    const orgId=clean(options.orgId);
    if (!pane||!orgId) return;
    pane.innerHTML=`<div class="dm-card"><p class="dm-note"><i class="fas fa-circle-notch fa-spin"></i>${(globalThis.PlatformLanguage?.text("settings","m_27be9dd638fd07"," Loading domains…") ?? " Loading domains…")}</p></div>`;
    try {
      const [configResult,listResult,registrantDefaults]=await Promise.all([
        window.DomainsAPI.config(),
        window.DomainsAPI.list(orgId),
        loadRegistrantDefaults(orgId, options.registrantDefaults)
      ]);
      const config=configResult||{};
      const domains=Array.isArray(listResult?.domains)?listResult.domains:[];
      pane.innerHTML=`<div class="dm-page"><div class="dm-hero"><div><h3>${(globalThis.PlatformLanguage?.text("settings","m_7e6427ce4061f4","Domains & Hosting") ?? "Domains & Hosting")}</h3><p>${(globalThis.PlatformLanguage?.text("settings","m_b220ed6c45c214","Register, transfer, or connect domains, then attach them to a FirstMate website and default email address.") ?? "Register, transfer, or connect domains, then attach them to a FirstMate website and default email address.")}</p></div><button class="dm-btn primary" data-new-domain><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("settings","m_36735857529693"," Add domain") ?? " Add domain")}</button></div>
        ${String(config.configured&&config.encryption_configured?'':`<div class="dm-callout warn"><strong>Domain purchasing is not configured.</strong> Existing-domain connections remain available, but registration and transfer require server credentials and encryption.</div>`)}
        <section class="dm-card"><div class="dm-card-head"><div><h4>${(globalThis.PlatformLanguage?.text("settings","m_7e3507920a3b24","Your domains") ?? "Your domains")}</h4><p class="dm-note">${(globalThis.PlatformLanguage?.text("settings","m_2704e3a346d938","Verification and website connection status update here.") ?? "Verification and website connection status update here.")}</p></div></div><div class="dm-owned">${String(domains.length?domains.map((domain)=>`<div class="dm-owned-row"><div><strong>${esc(domain.domain||'')}</strong><p class="dm-note">${esc(domain.simulated?'Simulated domain':domain.acquisition_type==='existing'?'Connected domain':domain.acquisition_type==='transfer'?'Domain transfer':'Registered domain')}${domain.website_id?' · Website connected':''}</p></div><span class="dm-badge ${esc(domain.status||'')}">${esc(clean(domain.status||'pending').replace(/_/g,' '))}</span></div>`).join(''):'<p class="dm-note">No domains have been added yet.</p>')}</div></section></div>`;
      let wizard=null;
      const launch=(path='',step='')=>{ if (wizard||document.querySelector('[data-fm-wizard="domain-onboarding"]')) return; wizard=openWizard({...options,orgId,config,registrantDefaults,onComplete:async()=>{wizard=null;await mount(options);}},path,step); };
      pane.querySelector('[data-new-domain]')?.addEventListener('click',()=>launch());
      if (clean(options.route?.workflow)==='domain_onboarding') launch(clean(options.path||''),clean(options.route?.workflow_step||''));
    } catch(error) {
      pane.innerHTML=`<div class="dm-callout danger">${esc(error?.message||'Could not load Domains & Hosting.')}</div>`;
    }
  }

  async function mount(options = {}){
    ensureCss();
    const pane=options.pane;
    const orgId=clean(options.orgId);
    if(!pane||!orgId)return;
    pane.innerHTML=`<div class="dm-card"><p class="dm-note"><i class="fas fa-circle-notch fa-spin"></i>${(globalThis.PlatformLanguage?.text("settings","m_a80f8f278ef5a0"," Loading domains...") ?? " Loading domains...")}</p></div>`;
    try{
      const [configResult,listResult,registrantDefaults]=await Promise.all([
        window.DomainsAPI.config(),
        window.DomainsAPI.list(orgId),
        loadRegistrantDefaults(orgId,options.registrantDefaults)
      ]);
      const config=configResult||{};
      let domains=Array.isArray(listResult?.domains)?listResult.domains:[];
      let selectedDomain='';
      let message='';
      let busy=false;
      let wizard=null;
      const typeLabel=(domain)=>domain.simulated?'Simulated domain':domain.acquisition_type==='existing'?'Connected at another registrar':domain.acquisition_type==='transfer'?'Transferred domain':'Registered domain';
      const dateLabel=(value)=>{
        const timestamp=Date.parse(clean(value));
        return Number.isFinite(timestamp)?new Date(timestamp).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):'Not available';
      };
      const confirmAction=async(text,title,okLabel)=>{
        if(window.PlatformUI?.confirm)return !!(await window.PlatformUI.confirm(text,{title,okLabel,danger:true}));
        if(window.Portal?.ui?.confirm)return !!(await window.Portal.ui.confirm(text));
        return window.confirm(text);
      };
      const launch=(path='',step='')=>{
        if(wizard||document.querySelector('[data-fm-wizard="domain-onboarding"]'))return;
        wizard=openWizard({...options,orgId,config,registrantDefaults,onComplete:async()=>{wizard=null;await mount(options);}},path,step);
      };
      const replaceDomain=(updated)=>{
        domains=domains.map((domain)=>clean(domain.domain)===clean(updated.domain)?{...domain,...updated,website:updated.website===undefined?domain.website:updated.website}:domain);
      };
      const reload=async()=>{
        const result=await window.DomainsAPI.list(orgId);
        domains=Array.isArray(result?.domains)?result.domains:[];
      };
      const domainCard=(domain)=>`<article class="dm-owned-row">
        <div class="dm-domain-card-head"><div class="dm-domain-card-title"><strong>${String(esc(domain.domain||''))}</strong><p class="dm-note">${String(esc(typeLabel(domain)))}</p></div><span class="dm-badge ${String(esc(domain.status||''))}">${String(esc(clean(domain.status||'pending').replace(/_/g,' ')))}</span></div>
        <div class="dm-domain-meta">
          <span><i class="fas fa-window-maximize"></i><b>${String(esc(domain.website?.name||'No website connected'))}</b></span>
          <span><i class="fas fa-envelope"></i><b>${String(esc(domain.default_email||'Email not configured'))}</b></span>
          <span><i class="fas fa-calendar"></i><b>${String(esc(domain.expires_at?`Expires ${dateLabel(domain.expires_at)}`:'Expiration unavailable'))}</b></span>
        </div>
        <div class="dm-card-actions"><button class="dm-btn" data-manage-domain="${String(esc(domain.domain))}"><i class="fas fa-sliders"></i>${(globalThis.PlatformLanguage?.text("settings","m_773cb43b56c274"," Manage") ?? " Manage")}</button></div>
      </article>`;
      const listHtml=()=>`<div class="dm-page">
        ${String(options.embedded?'':`<div class="dm-hero"><div><h3>Domains & Hosting</h3><p>Register, transfer, or connect domains, then attach them to a FirstMate website and default email address.</p></div><button class="dm-btn primary" data-new-domain><i class="fas fa-plus"></i> Add domain</button></div>`)}
        ${String(options.embedded?`<div class="dm-card-head"><div><h4>Your domains</h4><p class="dm-note">Manage website routing, renewal protection, nameservers, privacy, and transfers.</p></div><button class="dm-btn primary" data-new-domain><i class="fas fa-plus"></i> Add domain</button></div>`:'')}
        ${String(config.configured&&config.encryption_configured?'':`<div class="dm-callout warn"><strong>Domain purchasing is not configured.</strong> Existing-domain connections remain available, but registration and transfer require server credentials and encryption.</div>`)}
        <section class="dm-card"><div class="dm-card-head"><div><h4>${String(options.embedded?'Domain portfolio':'Your domains')}</h4><p class="dm-note">${(globalThis.PlatformLanguage?.text("settings","m_1e4516f36d3029","Each card shows the website currently served on that domain.") ?? "Each card shows the website currently served on that domain.")}</p></div></div>
          <div class="dm-owned">${String(domains.length?domains.map(domainCard).join(''):'<p class="dm-note">No domains have been added yet.</p>')}</div>
        </section></div>`;
      const detailHtml=(domain)=>{
        const external=domain.acquisition_type==='existing';
        const nameservers=Array.isArray(domain.nameservers)?domain.nameservers.join('\n'):'';
        return `<div class="dm-page">
          <div class="dm-hero"><div class="dm-detail-heading"><button class="dm-detail-back" data-domain-back aria-label="${(globalThis.PlatformLanguage?.text("settings","m_993cffffd61784","Back to all domains") ?? "Back to all domains")}" title="${(globalThis.PlatformLanguage?.text("settings","m_993cffffd61784","Back to all domains") ?? "Back to all domains")}"><i class="fas fa-arrow-left"></i></button><div><h3>${String(esc(domain.domain))}</h3><p>${((v1,v2) => globalThis.PlatformLanguage?.text("settings","m_bfcaea81bcc4ed",`${v1} &middot; ${v2}`,{v1,v2}) ?? `${v1} &middot; ${v2}`)(esc(typeLabel(domain)),esc(clean(domain.status||'pending').replace(/_/g,' ')))}</p></div></div>${String(domain.website_id?`<button class="dm-btn" data-open-website="${esc(domain.website_id)}"><i class="fas fa-arrow-up-right-from-square"></i> Open ${esc(domain.website?.name||'website')}</button>`:'')}</div>
          ${String(message?`<div class="dm-callout" role="status"><i class="fas fa-circle-info"></i> ${esc(message)}</div>`:'')}
          ${String(busy?'<div class="dm-callout"><i class="fas fa-circle-notch fa-spin"></i> Saving domain changes...</div>':'')}
          <div class="dm-manage-grid">
            <section class="dm-manage-card"><h4><i class="fas fa-window-maximize"></i>${(globalThis.PlatformLanguage?.text("settings","m_341b4942338454"," Website & email") ?? " Website & email")}</h4>
              <div class="dm-setting-row"><div class="dm-setting-copy"><strong>${(globalThis.PlatformLanguage?.text("settings","m_902cd6598c5257","Connected website") ?? "Connected website")}</strong><p>${String(esc(domain.website?.name||'No website connected'))}</p></div>${String(domain.website_id?`<button class="dm-btn" data-open-website="${esc(domain.website_id)}">Open</button>`:'<span class="dm-badge">Not connected</span>')}</div>
              <div class="dm-setting-row"><div class="dm-setting-copy"><strong>${(globalThis.PlatformLanguage?.text("settings","m_715488f4d0b6d4","Default email address") ?? "Default email address")}</strong><p>${String(esc(domain.default_email||'Not configured'))}</p></div><span class="dm-badge">${String(domain.email_configuration_status==='active'?'Active':'Pending setup')}</span></div>
            </section>
            <section class="dm-manage-card"><h4><i class="fas fa-shield-halved"></i>${(globalThis.PlatformLanguage?.text("settings","m_12ca16778536e1"," Protection & renewal") ?? " Protection & renewal")}</h4>
              <div class="dm-setting-row"><div class="dm-setting-copy"><strong>${(globalThis.PlatformLanguage?.text("settings","m_4d5a168f5fd12e","Domain privacy") ?? "Domain privacy")}</strong><p>${String(external?'Managed at the current registrar.':'Registrant information stays private where supported.')}</p></div><button class="dm-switch on" disabled aria-label="${(globalThis.PlatformLanguage?.text("settings","m_d391c915a7335b","Domain privacy enabled") ?? "Domain privacy enabled")}"></button></div>
              <div class="dm-setting-row"><div class="dm-setting-copy"><strong>${(globalThis.PlatformLanguage?.text("settings","m_7acab65048e339","Auto-renew") ?? "Auto-renew")}</strong><p>${String(external?'Managed at the current registrar.':'Renew automatically before expiration.')}</p></div><button class="dm-switch ${String(domain.auto_renew!==false?'on':'')}" data-domain-toggle="auto_renew" ${String(external||busy?'disabled':'')}></button></div>
              <div class="dm-setting-row"><div class="dm-setting-copy"><strong>${(globalThis.PlatformLanguage?.text("settings","m_eb664d5a225fc1","Registrar lock") ?? "Registrar lock")}</strong><p>${String(external?'Managed at the current registrar.':'Blocks unauthorized transfers and registry changes.')}</p></div><button class="dm-switch ${String(domain.locked!==false?'on':'')}" data-domain-toggle="locked" ${String(external||busy?'disabled':'')}></button></div>
            </section>
            <section class="dm-manage-card"><h4><i class="fas fa-network-wired"></i>${(globalThis.PlatformLanguage?.text("settings","m_f7e82cb670723d"," DNS & nameservers") ?? " DNS & nameservers")}</h4>
              <p class="dm-note">${String(external?'Update these with the registrar where this domain is registered.':'Assign two or more authoritative nameservers. DNS record editing will appear here when the Cloudflare API connection is authorized.')}</p>
              <textarea class="dm-textarea" data-domain-nameservers placeholder="${(globalThis.PlatformLanguage?.text("settings","m_7646ae24b6c57c","abby.ns.cloudflare.com&#10;mark.ns.cloudflare.com") ?? "abby.ns.cloudflare.com&#10;mark.ns.cloudflare.com")}" ${String(external||busy?'disabled':'')}>${String(esc(nameservers))}</textarea>
              <div class="dm-card-actions"><button class="dm-btn primary" data-save-nameservers ${String(external||busy?'disabled':'')}><i class="fas fa-floppy-disk"></i>${(globalThis.PlatformLanguage?.text("settings","m_bba93a61b42863"," Save nameservers") ?? " Save nameservers")}</button></div>
            </section>
            <section class="dm-manage-card"><h4><i class="fas fa-address-card"></i>${(globalThis.PlatformLanguage?.text("settings","m_62d1668cdfb9ec"," Registration") ?? " Registration")}</h4>
              <div class="dm-setting-row"><div class="dm-setting-copy"><strong>${(globalThis.PlatformLanguage?.text("settings","m_95af41e20221e6","Expiration") ?? "Expiration")}</strong><p>${String(esc(dateLabel(domain.expires_at)))}</p></div></div>
              <div class="dm-setting-row"><div class="dm-setting-copy"><strong>${(globalThis.PlatformLanguage?.text("settings","m_78ef82dff0cf42","Registrant contact") ?? "Registrant contact")}</strong><p>${(globalThis.PlatformLanguage?.text("settings","m_c3d10b3fb197a6","Protected from the public directory. Contact changes require registry verification.") ?? "Protected from the public directory. Contact changes require registry verification.")}</p></div></div>
            </section>
            <section class="dm-manage-card dm-danger-zone"><h4><i class="fas fa-arrow-right-arrow-left"></i>${(globalThis.PlatformLanguage?.text("settings","m_0aa7532fd241c1"," Domain actions") ?? " Domain actions")}</h4>
              <p class="dm-note">${String(external?'Disconnecting removes the website assignment from FirstMate; it does not cancel the domain.':'Transfer out unlocks the domain and sends its authorization code to the private registrant contact. It does not cancel the domain.')}</p>
              <div class="dm-card-actions">${String(external?'':`<button class="dm-btn" data-transfer-out ${busy?'disabled':''}><i class="fas fa-paper-plane"></i> Transfer out</button>`)}<button class="dm-btn danger" data-disconnect ${String(busy?'disabled':'')}><i class="fas fa-link-slash"></i>${(globalThis.PlatformLanguage?.text("settings","m_8a064cc0e8391e"," Disconnect from FirstMate") ?? " Disconnect from FirstMate")}</button></div>
            </section>
          </div></div>`;
      };
      const render=()=>{
        const domain=domains.find((entry)=>clean(entry.domain)===selectedDomain);
        pane.innerHTML=domain?detailHtml(domain):listHtml();
        pane.querySelector('[data-new-domain]')?.addEventListener('click',()=>launch());
        pane.querySelectorAll('[data-manage-domain]').forEach((button)=>button.addEventListener('click',()=>{selectedDomain=clean(button.dataset.manageDomain);message='';render();}));
        pane.querySelector('[data-domain-back]')?.addEventListener('click',()=>{selectedDomain='';message='';render();});
        pane.querySelectorAll('[data-open-website]').forEach((button)=>button.addEventListener('click',()=>{
          const websiteId=clean(button.dataset.openWebsite);
          if(options.onOpenWebsite)options.onOpenWebsite(websiteId);
          else window.Portal?.navigation?.navigate?.({tab:'web_editor',site:websiteId,page:'',domainSettings:''},{source:'domains-open-website',ownedKeys:['tab','site']});
        }));
        pane.querySelectorAll('[data-domain-toggle]').forEach((button)=>button.addEventListener('click',async()=>{
          const domain=domains.find((entry)=>clean(entry.domain)===selectedDomain);
          if(!domain||busy)return;
          const key=clean(button.dataset.domainToggle);
          const next=domain[key]===false;
          if(key==='locked'&&!next&&!await confirmAction('Unlocking the domain makes it eligible for transfer. Continue?','Unlock domain','Unlock'))return;
          busy=true;message='';render();
          try{const response=await window.DomainsAPI.updateManagement(orgId,selectedDomain,{[key]:next});replaceDomain(response.registration);}
          catch(error){message=error?.message||'Could not update the domain.';}
          busy=false;render();
        }));
        pane.querySelector('[data-save-nameservers]')?.addEventListener('click',async()=>{
          const nameservers=clean(pane.querySelector('[data-domain-nameservers]')?.value).split(/\s+/).map(clean).filter(Boolean);
          if(nameservers.length<2){message='Enter at least two valid nameserver hostnames.';render();return;}
          busy=true;message='';render();
          try{const response=await window.DomainsAPI.updateManagement(orgId,selectedDomain,{nameservers});replaceDomain(response.registration);}
          catch(error){message=error?.message||'Could not update the nameservers.';}
          busy=false;render();
        });
        pane.querySelector('[data-transfer-out]')?.addEventListener('click',async()=>{
          if(!await confirmAction('FirstMate will unlock this domain and send the transfer authorization code to its private registrant contact. Continue?','Transfer domain out','Send authorization code'))return;
          busy=true;message='';render();
          try{const response=await window.DomainsAPI.requestTransferOut(orgId,selectedDomain);replaceDomain(response.registration);message=config.order_test_mode?'Test mode: the unlock and transfer email were simulated.':'The authorization code was sent to the registrant contact.';}
          catch(error){message=error?.message||'Could not prepare the domain transfer.';}
          busy=false;render();
        });
        pane.querySelector('[data-disconnect]')?.addEventListener('click',async()=>{
          if(!await confirmAction('Disconnect this domain from FirstMate? The registration itself will not be canceled.','Disconnect domain','Disconnect'))return;
          busy=true;message='';render();
          try{await window.DomainsAPI.disconnect(orgId,selectedDomain);await reload();selectedDomain='';}
          catch(error){message=error?.message||'Could not disconnect the domain.';}
          busy=false;render();
        });
      };
      render();
      if(clean(options.route?.workflow)==='domain_onboarding')launch(clean(options.path||''),clean(options.route?.workflow_step||''));
      return{refresh:reload,open:launch};
    }catch(error){
      pane.innerHTML=`<div class="dm-callout danger">${esc(error?.message||'Could not load Domains & Hosting.')}</div>`;
    }
  }

  window.FirstMateDomainsSettings={ mount, open:openWizard };
})();
