/* FirstMate account switcher — browser UI for server-side remembered account sessions. */
(function () {
  'use strict';

  const rootId = 'fmAccountSwitcherMenu';
  const cacheKey = 'fm_account_switcher_accounts_v1';
  const endpoint = (path) => `${String(window.__APP?.platformApiBase || '/v1/platform').replace(/\/+$/, '')}${path}`;

  function cookie(name) {
    const prefix = `${encodeURIComponent(name)}=`;
    return (document.cookie || '').split(';').map((value) => value.trim()).reduce((found, value) => (
      found || (value.indexOf(prefix) === 0 ? decodeURIComponent(value.slice(prefix.length)) : '')
    ), '');
  }

  function escapeHtml(value) {
    const node = document.createElement('span');
    node.textContent = String(value || '');
    return node.innerHTML;
  }

  function initials(name, email) {
    const words = String(name || email || '?').trim().split(/\s+/).filter(Boolean);
    return (words.slice(0, 2).map((word) => word.charAt(0)).join('') || '?').toUpperCase();
  }

  function readCachedAccounts() {
    try {
      const value = JSON.parse(localStorage.getItem(cacheKey) || '[]');
      return Array.isArray(value) ? value.filter((account) => account && account.email) : [];
    } catch (_) {
      return [];
    }
  }

  function writeCachedAccounts(accounts) {
    try {
      localStorage.setItem(cacheKey, JSON.stringify((accounts || []).map((account) => ({
        account_id: String(account.account_id || ''),
        email: String(account.email || ''),
        name: String(account.name || ''),
        organization_name: String(account.organization_name || ''),
        active: !!account.active,
        needs_reauth: !!account.needs_reauth,
        last_used_at: String(account.last_used_at || '')
      }))));
    } catch (_) {}
  }

  function currentAccount() {
    const email = String(window.__APP?.userEmail || '').trim().toLowerCase();
    if (!email) return null;
    return {
      account_id: '',
      email,
      name: String(window.__APP?.userName || email).trim(),
      organization_name: String(window.__APP?.userCompany || '').trim(),
      active: true,
      needs_reauth: false,
      last_used_at: ''
    };
  }

  function mergeCurrentAccount(accounts) {
    const current = currentAccount();
    const next = Array.isArray(accounts) ? accounts.map((account) => ({ ...account, active: false })) : [];
    if (!current) return next;
    const existing = next.find((account) => String(account.email || '').toLowerCase() === current.email);
    if (existing) Object.assign(existing, {
      email: current.email,
      name: current.name,
      organization_name: current.organization_name || existing.organization_name,
      active: true,
      needs_reauth: false
    });
    else next.unshift(current);
    return next;
  }

  class AccountSwitcher {
    constructor(button) {
      this.button = button;
      this.menu = null;
      this.accounts = mergeCurrentAccount(readCachedAccounts());
      this.actionAccountKey = '';
      this.cookieNames = { csrf: 'fm_platform_session_csrf' };
      this.refreshPromise = null;
      this.closeTimer = 0;
      this.boundOutside = (event) => this.onOutside(event);
      this.boundKeydown = (event) => { if (event.key === 'Escape') this.close(); };
      button.addEventListener('click', () => this.toggle());
    }

    csrf() { return cookie(this.cookieNames.csrf || 'fm_platform_session_csrf'); }

    async request(path, options = {}) {
      const response = await fetch(endpoint(path), {
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(options.method && options.method !== 'GET' ? { 'X-Platform-CSRF': this.csrf() } : {})
        },
        ...options
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) {
        const error = new Error(body.message || 'We could not update your accounts.');
        error.code = body.error || '';
        throw error;
      }
      return body;
    }

    async refreshAccounts() {
      if (this.refreshPromise) return this.refreshPromise;
      this.refreshPromise = this.request('/auth/accounts')
        .then((result) => {
          this.cookieNames = result.cookie_names || this.cookieNames;
          const previous = new Map(this.accounts.map((account) => [account.account_id || account.email, account]));
          const fetched = Array.isArray(result.accounts) ? result.accounts.map((account) => ({
            ...account,
            needs_reauth: !!previous.get(account.account_id || account.email)?.needs_reauth
          })) : [];
          this.accounts = mergeCurrentAccount(fetched);
          writeCachedAccounts(this.accounts);
          if (this.menu && !this.menu.hidden) this.renderList();
          return this.accounts;
        })
        .catch(() => this.accounts)
        .finally(() => { this.refreshPromise = null; });
      return this.refreshPromise;
    }

    ensureMenu() {
      if (this.menu) return;
      const menu = document.createElement('section');
      menu.id = rootId;
      menu.className = 'fm-account-switcher-menu';
      menu.setAttribute('role', 'dialog');
      menu.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("account-switcher","m_b5e633539db02a","Choose an account") ?? "Choose an account"));
      menu.hidden = true;
      document.body.appendChild(menu);
      this.menu = menu;
    }

    position() {
      if (!this.menu) return;
      const rect = this.button.getBoundingClientRect();
      const width = Math.min(360, Math.max(300, window.innerWidth - 24));
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      this.menu.style.width = `${width}px`;
      this.menu.style.left = `${left}px`;
      this.menu.style.bottom = `${Math.max(12, window.innerHeight - rect.top + 10)}px`;
    }

    async open() {
      this.ensureMenu();
      window.clearTimeout(this.closeTimer);
      this.closeTimer = 0;
      this.menu.classList.remove('closing');
      this.menu.hidden = false;
      this.button.setAttribute('aria-expanded', 'true');
      this.position();
      document.addEventListener('pointerdown', this.boundOutside, true);
      document.addEventListener('keydown', this.boundKeydown);
      this.renderList();
      void this.refreshAccounts();
    }

    close() {
      if (!this.menu || this.menu.hidden || this.menu.classList.contains('closing')) return;
      this.menu.classList.add('closing');
      this.actionAccountKey = '';
      this.button.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', this.boundOutside, true);
      document.removeEventListener('keydown', this.boundKeydown);
      window.clearTimeout(this.closeTimer);
      this.closeTimer = window.setTimeout(() => {
        this.closeTimer = 0;
        this.menu.hidden = true;
        this.menu.classList.remove('closing');
      }, 220);
    }

    toggle() { this.menu?.hidden || this.menu?.classList.contains('closing') ? this.open() : this.menu ? this.close() : this.open(); }

    onOutside(event) {
      if (this.menu && !this.menu.contains(event.target) && !this.button.contains(event.target)) this.close();
    }

    renderError(error) {
      if (!this.menu) return;
      this.menu.innerHTML = `<div class="fm-account-switcher-head"><strong>${(globalThis.PlatformLanguage?.text("account-switcher","m_3a204df60cc9c8","Accounts") ?? "Accounts")}</strong><button type="button" data-fm-account-close aria-label="${(globalThis.PlatformLanguage?.text("account-switcher","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button></div><p class="fm-account-switcher-error">${String(escapeHtml(error.message || 'Unable to load accounts.'))}</p>`;
      this.menu.querySelector('[data-fm-account-close]')?.addEventListener('click', () => this.close());
    }

    renderList() {
      if (!this.menu) return;
      const actionAccount = this.accounts.find((account) => (
        String(account.account_id || account.email || '') === this.actionAccountKey
      ));
      const accountRows = this.accounts.map((account) => {
        const active = !!account.active;
        const needsReauth = !!account.needs_reauth;
        const displayName = account.name || account.email;
        const accountKey = String(account.account_id || account.email || '');
        const actionsOpen = this.actionAccountKey === accountKey;
        return `<div class="fm-account-row${String(active ? ' is-active' : '')}">
          <button type="button" class="fm-account-select" data-fm-account-select="${String(escapeHtml(account.account_id))}" ${String(active ? 'aria-current="true"' : '')}>
            <span class="fm-account-avatar">${String(escapeHtml(initials(displayName, account.email)))}</span>
            <span class="fm-account-copy"><strong>${String(escapeHtml(displayName))}</strong><small>${String(escapeHtml(account.email))}</small>${String(needsReauth ? '<small class="fm-account-reauth">Sign in again</small>' : (account.organization_name ? `<small>${escapeHtml(account.organization_name)}</small>` : ''))}</span>
            ${String(active ? '<i class="fas fa-check fm-account-current" aria-label="Current account"></i>' : (needsReauth ? '<i class="fas fa-right-to-bracket fm-account-current" aria-label="Sign in again"></i>' : ''))}
          </button>
          <button type="button" class="fm-account-more" data-fm-account-more="${String(escapeHtml(accountKey))}" aria-label="${((v9) => globalThis.PlatformLanguage?.text("account-switcher","m_5bdb5ea8fb0e0d",`More options for ${v9}`,{v9}) ?? `More options for ${v9}`)(escapeHtml(account.email))}" aria-haspopup="menu" aria-expanded="${String(actionsOpen ? 'true' : 'false')}"><i class="fas fa-ellipsis-vertical"></i></button>
        </div>`;
      }).join('');
      const actionMenu = actionAccount ? `<div class="fm-account-row-actions" role="menu" aria-label="${((v0) => globalThis.PlatformLanguage?.text("account-switcher","m_6d7389c830a774",`Actions for ${v0}`,{v0}) ?? `Actions for ${v0}`)(escapeHtml(actionAccount.email))}">
        <button type="button" data-fm-account-remove="${String(escapeHtml(actionAccount.account_id))}" role="menuitem"><i class="fas fa-right-from-bracket"></i><span>${String(actionAccount.active ? 'Sign out' : 'Remove account')}</span></button>
      </div>` : '';
      this.menu.innerHTML = `<div class="fm-account-switcher-head"><strong>${(globalThis.PlatformLanguage?.text("account-switcher","m_b5e633539db02a","Choose an account") ?? "Choose an account")}</strong><button type="button" data-fm-account-close aria-label="${(globalThis.PlatformLanguage?.text("account-switcher","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button></div>
        <div class="fm-account-list">${String(accountRows || '<p class="fm-account-empty">No saved accounts yet.</p>')}</div>
        <div class="fm-account-switcher-actions">
          <button type="button" data-fm-account-add><i class="fas fa-user-plus"></i><span>${(globalThis.PlatformLanguage?.text("account-switcher","m_95d01441b9f49d","Add another account") ?? "Add another account")}</span></button>
          <button type="button" data-fm-account-logout-all><i class="fas fa-right-from-bracket"></i><span>${(globalThis.PlatformLanguage?.text("account-switcher","m_41632633478452","Sign out of all accounts") ?? "Sign out of all accounts")}</span></button>
        </div>${String(actionMenu)}`;
      this.menu.querySelector('[data-fm-account-close]')?.addEventListener('click', () => this.close());
      this.menu.querySelector('[data-fm-account-add]')?.addEventListener('click', () => this.openLogin());
      this.menu.querySelector('[data-fm-account-logout-all]')?.addEventListener('click', () => this.logoutAll());
      this.menu.querySelectorAll('[data-fm-account-select]').forEach((button) => button.addEventListener('click', () => {
        const account = this.accounts.find((item) => item.account_id === button.dataset.fmAccountSelect);
        if (account?.needs_reauth || !account?.account_id) this.openLogin(account?.email || '');
        else this.switchTo(button.dataset.fmAccountSelect);
      }));
      this.menu.querySelectorAll('[data-fm-account-more]').forEach((button) => button.addEventListener('click', (event) => {
        event.stopPropagation();
        const accountKey = button.dataset.fmAccountMore || '';
        this.actionAccountKey = this.actionAccountKey === accountKey ? '' : accountKey;
        this.renderList();
        if (this.actionAccountKey) this.menu.querySelector('[data-fm-account-remove]')?.focus();
      }));
      this.menu.querySelectorAll('[data-fm-account-remove]').forEach((button) => button.addEventListener('click', () => this.remove(button.dataset.fmAccountRemove)));
      this.positionActionMenu();
    }

    positionActionMenu() {
      const actions = this.menu?.querySelector('.fm-account-row-actions');
      const trigger = this.menu?.querySelector('[data-fm-account-more][aria-expanded="true"]');
      if (!actions || !trigger) return;
      const menuRect = this.menu.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      const gap = 4;
      const below = triggerRect.bottom - menuRect.top + gap;
      const above = triggerRect.top - menuRect.top - actions.offsetHeight - gap;
      const fitsBelow = below + actions.offsetHeight <= menuRect.height - 8;
      actions.style.top = `${Math.max(8, fitsBelow ? below : above)}px`;
    }

    openLogin(email = '') {
      this.close();
      document.getElementById('fmAccountLoginModal')?.remove();
      const modal = document.createElement('section');
      modal.id = 'fmAccountLoginModal';
      modal.className = 'fm-account-login-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("account-switcher","m_db9ad85fae0711","Sign in to another account") ?? "Sign in to another account"));
      modal.innerHTML = `<div class="fm-account-login-backdrop" data-fm-account-login-close></div><div class="fm-account-login-card"><header><div><strong>${(globalThis.PlatformLanguage?.text("account-switcher","m_db9ad85fae0711","Sign in to another account") ?? "Sign in to another account")}</strong><span>${(globalThis.PlatformLanguage?.text("account-switcher","m_8652b533cc3e38","Your account stays available on this device.") ?? "Your account stays available on this device.")}</span></div><button type="button" data-fm-account-login-close aria-label="${(globalThis.PlatformLanguage?.text("account-switcher","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button></header><div class="fm-account-login-widget" data-firstmate-signup data-mode="login" data-show-login="true" data-show-terms="false" data-referral="none" data-redirect="/portal/"></div></div>`;
      document.body.appendChild(modal);
      const close = () => modal.remove();
      modal.querySelectorAll('[data-fm-account-login-close]').forEach((button) => button.addEventListener('click', close));
      const host = modal.querySelector('[data-firstmate-signup]');
      if (window.FirstMateSignupWidget?.mount && host) {
        window.FirstMateSignupWidget.mount(host, {
          loginRequest: async (formData) => {
            try {
              const result = await this.request('/auth/accounts/add', {
                method: 'POST',
                body: JSON.stringify({
                  email: String(formData.get('email') || '').trim(),
                  password: String(formData.get('password') || '')
                })
              });
              return { ...result, success: true, first_login: false };
            } catch (error) {
              return { success: false, error: error.message || 'Unable to add that account.' };
            }
          }
        });
        const emailInput = host.shadowRoot?.querySelector('[data-form="login"] input[name="email"]');
        if (emailInput && email) emailInput.value = email;
        (emailInput || host.shadowRoot?.querySelector('input'))?.focus();
      } else {
        modal.querySelector('.fm-account-login-widget').textContent = (globalThis.PlatformLanguage?.text("account-switcher","m_8efe45acfa8fb0","The login form is still loading. Please try again.") ?? "The login form is still loading. Please try again.");
      }
    }

    async switchTo(accountId) {
      const account = this.accounts.find((item) => item.account_id === accountId);
      if (account?.active) return this.close();
      this.menu?.classList.add('is-busy');
      try {
        await this.request('/auth/accounts/switch', { method: 'POST', body: JSON.stringify({ account_id: accountId }) });
        this.reloadForAccount();
      } catch (error) {
        this.menu?.classList.remove('is-busy');
        if (error.code === 'remembered_account_expired' || error.code === 'remembered_account_unavailable') {
          const stale = this.accounts.find((item) => item.account_id === accountId);
          if (stale) stale.needs_reauth = true;
          writeCachedAccounts(this.accounts);
          this.openLogin(stale?.email || '');
        } else this.renderError(error);
      }
    }

    async remove(accountId) {
      const account = this.accounts.find((item) => item.account_id === accountId);
      if (!accountId || !account) {
        this.actionAccountKey = '';
        await this.refreshAccounts();
        this.renderList();
        return;
      }
      const wording = account?.active ? 'Sign out of this account?' : 'Remove this account from this device?';
      if (!window.confirm(wording)) return;
      try {
        await this.request('/auth/accounts/remove', { method: 'POST', body: JSON.stringify({ account_id: accountId }) });
        this.accounts = this.accounts.filter((item) => item.account_id !== accountId);
        writeCachedAccounts(this.accounts);
        if (account?.active) this.reloadForAccount(true);
        else this.renderList();
      } catch (error) {
        this.renderError(error);
      }
    }

    async logoutAll() {
      if (!window.confirm((globalThis.PlatformLanguage?.text("account-switcher","m_094189125cc8c4","Sign out of every remembered account on this device?") ?? "Sign out of every remembered account on this device?"))) return;
      try {
        await this.request('/auth/accounts/logout-all', { method: 'POST', body: '{}' });
        try { localStorage.removeItem(cacheKey); } catch (_) {}
        this.reloadForAccount(true);
      } catch (error) {
        this.renderError(error);
      }
    }

    reloadForAccount(toLogin = false) {
      window.location.assign(toLogin ? '/portal/login.php' : '/portal/');
    }
  }

  function injectStyles() {
    if (document.getElementById('fm-account-switcher-styles')) return;
    const style = document.createElement('style');
    style.id = 'fm-account-switcher-styles';
    style.textContent = `
      @keyframes fmAccountSwitcherOpen{from{opacity:0;transform:translateY(10px) scale(.92)}to{opacity:1;transform:translateY(0) scale(1)}}@keyframes fmAccountSwitcherClose{from{opacity:1;transform:translateY(0) scale(1)}to{opacity:0;transform:translateY(8px) scale(.94)}}
      .sidebar-footer{padding:12px 6px 4px!important;text-align:left!important}.fm-account-switcher-trigger{display:flex;width:100%;min-width:0;align-items:center;gap:9px;border:0;border-radius:12px;background:transparent;padding:8px 9px;color:#5f6368;text-align:left;font:inherit;cursor:pointer}.fm-account-switcher-trigger:hover,.fm-account-switcher-trigger[aria-expanded="true"]{background:#f1f3f4}.fm-account-switcher-trigger .fm-account-avatar{flex:0 0 30px;width:30px;height:30px;font-size:11px}.fm-account-trigger-copy{min-width:0;display:grid;gap:1px;flex:1}.fm-account-trigger-copy strong,.fm-account-trigger-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fm-account-trigger-copy strong{font-size:12px;color:#5f6368}.fm-account-trigger-copy small{font-size:11px;color:#80868b}.fm-account-trigger-chevron{font-size:11px;color:#7b8490}
      .fm-account-switcher-menu{position:fixed;z-index:2147483646;overflow:hidden;border:1px solid #dadce0;border-radius:14px;background:#fff;color:#202124;box-shadow:0 12px 34px rgba(60,64,67,.28);font:14px/1.35 Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;transform-origin:20% 100%}.fm-account-switcher-menu:not([hidden]){animation:fmAccountSwitcherOpen .2s cubic-bezier(.2,.8,.2,1)}.fm-account-switcher-menu.closing{animation:fmAccountSwitcherClose .18s cubic-bezier(.4,0,1,1) forwards}.fm-account-switcher-menu[hidden]{display:none}.fm-account-switcher-head{display:flex;align-items:center;gap:10px;min-height:50px;padding:0 12px;border-bottom:1px solid #edf0f2}.fm-account-switcher-head strong{flex:1;font-size:15px}.fm-account-switcher-head button{width:32px;height:32px;border:0;border-radius:50%;background:transparent;color:#5f6368;cursor:pointer}.fm-account-switcher-head button:hover{background:#f1f3f4}.fm-account-switcher-head .fm-account-back{margin-left:-5px}.fm-account-list{padding:6px 0;max-height:min(48vh,420px);overflow:auto}.fm-account-row{display:grid;grid-template-columns:minmax(0,1fr) 32px;align-items:stretch;padding:0 7px}.fm-account-row.is-active{background:#f8fbff}.fm-account-select{display:flex;min-width:0;align-items:center;gap:11px;border:0;background:transparent;padding:9px 7px;text-align:left;color:inherit;cursor:pointer}.fm-account-select:hover{background:#f1f3f4;border-radius:9px}.fm-account-avatar{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:50%;background:#e8f0fe;color:#185abc;font-weight:800;font-size:12px}.fm-account-copy{display:grid;min-width:0;gap:1px}.fm-account-copy strong,.fm-account-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fm-account-copy strong{font-size:13px}.fm-account-copy small{font-size:11px;color:#5f6368}.fm-account-current{margin-left:auto;color:#1a73e8}.fm-account-more{align-self:center;width:32px;height:32px;border:0;border-radius:50%;background:transparent;color:#687386;cursor:pointer}.fm-account-more:hover,.fm-account-more[aria-expanded="true"]{background:#e9eef4;color:#202124}.fm-account-row-actions{grid-column:1/-1;justify-self:end;min-width:158px;margin:-3px 3px 7px 0;padding:5px;border:1px solid #dadce0;border-radius:9px;background:#fff;box-shadow:0 8px 22px rgba(60,64,67,.24)}.fm-account-row-actions button{display:flex;width:100%;align-items:center;gap:9px;border:0;border-radius:6px;background:#fff;padding:9px 10px;color:#b3261e;font:inherit;text-align:left;cursor:pointer}.fm-account-row-actions button:hover,.fm-account-row-actions button:focus{background:#fce8e6;outline:0}.fm-account-row-actions i{width:16px;text-align:center}.fm-account-switcher-actions{padding:7px 0;border-top:1px solid #edf0f2}.fm-account-switcher-actions button{display:flex;width:100%;align-items:center;gap:13px;border:0;background:#fff;padding:11px 17px;color:#3c4043;font:inherit;text-align:left;cursor:pointer}.fm-account-switcher-actions button:hover{background:#f1f3f4}.fm-account-switcher-actions i{width:17px;text-align:center;color:#5f6368}.fm-account-switcher-actions button:last-child{color:#5f6368}.fm-account-switcher-loading,.fm-account-empty{padding:24px 18px;color:#5f6368;text-align:center}.fm-account-switcher-loading i{margin-right:7px}.fm-account-switcher-error{margin:14px 17px;color:#b3261e;font-size:12px;line-height:1.45}.fm-account-form-copy{margin:17px;color:#5f6368;font-size:12px;line-height:1.45}.fm-account-add-form{display:grid;gap:12px;padding:0 17px 18px}.fm-account-add-form label{display:grid;gap:5px;color:#3c4043;font-size:12px;font-weight:700}.fm-account-add-form input{width:100%;border:1px solid #c7cdd4;border-radius:7px;padding:10px 11px;color:#202124;font:14px inherit}.fm-account-add-form input:focus{outline:2px solid rgba(26,115,232,.22);border-color:#1a73e8}.fm-account-submit{justify-self:end;border:0;border-radius:20px;background:#1a73e8;padding:9px 17px;color:#fff;font:700 13px inherit;cursor:pointer}.fm-account-submit:disabled{opacity:.68;cursor:wait}.fm-account-switcher-menu.is-busy{pointer-events:none;opacity:.72}
      .fm-account-row-actions{position:absolute;z-index:3;right:10px;min-width:150px;margin:0;padding:3px;border:1px solid #e5e8eb;border-radius:8px;background:#fff;box-shadow:0 4px 12px rgba(60,64,67,.14)}.fm-account-row-actions button{display:flex;width:100%;align-items:center;gap:8px;border:0;border-radius:5px;background:#fff;padding:7px 9px;color:#3c4043;font:inherit;font-size:12.5px;text-align:left;cursor:pointer}.fm-account-row-actions button:hover,.fm-account-row-actions button:focus{background:#f5f7f8;outline:0}.fm-account-row-actions i{width:15px;text-align:center;color:#a33b32;font-size:11px}
      .fm-account-reauth{color:#b45309!important;font-weight:700}.fm-account-login-modal{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:20px}.fm-account-login-backdrop{position:absolute;inset:0;background:rgba(15,23,42,.54)}.fm-account-login-card{position:relative;width:min(460px,100%);max-height:calc(100vh - 40px);overflow:auto;border-radius:18px;background:#fff;box-shadow:0 24px 80px rgba(15,23,42,.35)}.fm-account-login-card header{display:flex;align-items:flex-start;gap:12px;padding:19px 20px 15px;border-bottom:1px solid #edf0f2}.fm-account-login-card header>div{display:grid;gap:3px;flex:1}.fm-account-login-card header strong{font-size:17px;color:#202124}.fm-account-login-card header span{font-size:12px;color:#5f6368}.fm-account-login-card header button{width:32px;height:32px;border:0;border-radius:50%;background:transparent;color:#5f6368;cursor:pointer}.fm-account-login-card header button:hover{background:#f1f3f4}.fm-account-login-widget{padding:0 20px 20px}.fm-account-login-widget .fm-auth{margin:0}
      @media (max-width:720px){.fm-account-switcher-menu{bottom:12px!important;left:12px!important;width:calc(100vw - 24px)!important}.sidebar-footer{padding-bottom:8px!important}}
      @media (prefers-reduced-motion:reduce){.fm-account-switcher-menu:not([hidden]),.fm-account-switcher-menu.closing{animation:none}}
    `;
    document.head.appendChild(style);
  }

  function init() {
    const button = document.getElementById('accountSwitcherButton');
    if (!button || button.dataset.fmAccountSwitcherReady) return;
    button.dataset.fmAccountSwitcherReady = 'true';
    injectStyles();
    window.FirstMateAccountSwitcher = new AccountSwitcher(button);
    // Fetch once after portal boot, but never make the chooser wait for it.
    void window.FirstMateAccountSwitcher.refreshAccounts();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
