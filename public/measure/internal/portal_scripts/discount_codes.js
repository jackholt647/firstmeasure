/* portal_scripts/discount_codes.js
 * Dollars-based coupon admin UI (NEW SYSTEM)
 * - credits == USD dollars stored in credits_balance
 * - Default amounts are multiples of $7 (roof cost) but editable
 * - uses Node internal coupon_admin_* endpoints
 */
(function(){
  if (!window.Portal) return;

  const ROOF_COST = 7;

  const cfg = () => window.Portal.cfg;

  function canManageCoupons(){
    // keep it consistent with Node canManageCoupons():
    // admin OR manage_users
    const p = cfg().perms || {};
    const role = (cfg().user && cfg().user.role) || '';
    return role === 'admin' || !!p.manage_users;
  }

  function toInt(v, fallback=0){
    const n = parseInt(String(v ?? '').trim(), 10);
    return Number.isFinite(n) ? n : fallback;
  }
  function clampInt(n, min, max){
    n = toInt(n, min);
    if (Number.isFinite(min)) n = Math.max(min, n);
    if (Number.isFinite(max)) n = Math.min(max, n);
    return n;
  }
  function fmtMoney(n){
    n = toInt(n, 0);
    return `$${n}`;
  }
  function roofsFromDollars(d){
    d = toInt(d, 0);
    return Math.max(0, Math.floor(d / ROOF_COST));
  }

  function ensureMarkup(){
    const host = document.getElementById('portalPluginViews');
    if (!host) return;

    if (!document.getElementById('view-discount-codes')) {
      const wrap = document.createElement('div');
      wrap.id = 'view-discount-codes';
      wrap.style.display = 'none';
      wrap.innerHTML = `
        <div class="header-bar">
          <h1>Discount Codes</h1>
          <div style="display:flex; gap:10px;">
            <button class="btn-secondary" id="dcRefreshBtn"><i class="fas fa-sync"></i> Refresh</button>
            <button class="btn-primary" id="dcNewBtn"><i class="fas fa-plus"></i> New Code</button>
          </div>
        </div>

        <div style="margin:10px 0 18px; color:#666; font-weight:700; font-size:13px;">
          Coupons now grant <b>credit dollars</b>. Each roof costs <b>$${ROOF_COST}</b>.
          Defaults below are in multiples of $${ROOF_COST}, but you can set any amount.
        </div>

        <table>
          <thead>
            <tr>
              <th>Code Hash</th>
              <th>Status</th>
              <th>Total ($)</th>
              <th>Remaining ($)</th>
              <th>Per Redeem ($)</th>
              <th>Max Redemptions</th>
              <th>Used</th>
              <th>Once/User</th>
              <th>Created</th>
              <th style="text-align:right">Actions</th>
            </tr>
          </thead>
          <tbody id="discountCodesTable">
            <tr><td colspan="10" style="text-align:center; padding:30px;">Loading...</td></tr>
          </tbody>
        </table>
      `;
      host.appendChild(wrap);
    }

    if (!document.getElementById('discountCodeModal')) {
      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.id = 'discountCodeModal';
      modal.innerHTML = `
        <div class="modal-card md-user" style="width:560px;">
          <div class="modal-header">
            <h2 id="dcModalTitle">Discount Code</h2>
            <button id="dcCloseX" style="border:none; background:none; cursor:pointer;"><i class="fas fa-times"></i></button>
          </div>

          <div class="modal-body">
            <div id="dcFormArea">
              <input type="hidden" id="dcMode" value="create">
              <input type="hidden" id="dcCodeHash" value="">

              <div class="form-row">
                <label>Code (shown once on create)</label>
                <input id="dcCode" placeholder="Optional. Leave blank to auto-generate." autocomplete="off">
                <div style="font-size:11px; color:#777; margin-top:6px;">
                  Leave blank to auto-generate. Server returns it once.
                </div>
              </div>

              <div class="form-row">
                <label>Status</label>
                <select id="dcStatus" style="width:100%; padding:10px; border:1px solid #ccc; border-radius:6px;">
                  <option value="active">active</option>
                  <option value="disabled">disabled</option>
                </select>
              </div>

              <div class="form-row">
                <label>Total Credit ($)</label>
                <input id="dcCreditsTotal" type="number" min="1" value="70">
                <div style="font-size:11px; color:#777; margin-top:6px;">
                  Default is 10 roofs = $${ROOF_COST * 10}. (You can set any amount.)
                </div>
              </div>

              <div class="form-row">
                <label>Credit Per Redeem ($)</label>
                <input id="dcCreditsPer" type="number" min="1" value="${ROOF_COST}">
                <div style="font-size:11px; color:#777; margin-top:6px;">
                  Default is 1 roof = $${ROOF_COST}. (You can set any amount.)
                </div>
              </div>

              <div class="form-row">
                <label>Max Redemptions</label>
                <input id="dcMaxRed" type="number" min="1" value="10">
              </div>

              <div class="form-row">
                <label style="display:flex; align-items:center; gap:10px; text-transform:none;">
                  <input id="dcOncePerUser" type="checkbox" checked>
                  Once per user
                </label>
              </div>

              <div style="margin-top:14px; padding:10px 12px; border:1px solid #eee; border-radius:10px; background:#fafafa; color:#555; font-size:12px; font-weight:800;">
                <div><b>Quick helper:</b> $${ROOF_COST} ≈ 1 roof.</div>
                <div style="margin-top:6px;">
                  Total roofs: <span id="dcHelperTotal">—</span> •
                  Per redeem roofs: <span id="dcHelperPer">—</span>
                </div>
              </div>
            </div>

            <div id="dcDetailsArea" style="display:none;">
              <div class="meta-group">
                <div class="meta-label">Redemptions</div>
                <div class="meta-val" id="dcRedSummary">—</div>
              </div>
              <div class="meta-group">
                <div class="meta-label">Redeemed By</div>
                <div id="dcRedeemList" style="max-height:320px; overflow:auto; border:1px solid #eee; border-radius:8px; padding:10px; background:#fafafa;"></div>
              </div>
            </div>
          </div>

          <div class="modal-footer">
            <button class="btn-danger" id="dcDeleteBtn" style="margin-right:auto; display:none;">Delete</button>
            <button class="btn-secondary" id="dcCloseBtn">Close</button>
            <button class="btn-secondary" id="dcViewBtn" style="display:none;">View Usage</button>
            <button class="btn-primary" id="dcSaveBtn">Save</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }
  }

  const DiscountCodes = {
    items: [],
    showingDetails: false,

    async api(payload){
      return await Portal.apiPost(cfg().endpoints.server, payload);
    },

    openModal(){ Portal.openModal('discountCodeModal'); },
    closeModal(){ Portal.closeModal('discountCodeModal'); },

    syncModalAreas(){
      const form = document.getElementById('dcFormArea');
      const det  = document.getElementById('dcDetailsArea');
      const viewBtn = document.getElementById('dcViewBtn');

      if (form) form.style.display = this.showingDetails ? 'none' : 'block';
      if (det)  det.style.display  = this.showingDetails ? 'block' : 'none';
      if (viewBtn) viewBtn.textContent = this.showingDetails ? 'Back to Edit' : 'View Usage';
    },

    toggleDetails(){
      this.showingDetails = !this.showingDetails;
      this.syncModalAreas();
    },

    updateHelpers(){
      const total = toInt(document.getElementById('dcCreditsTotal')?.value, 0);
      const per   = toInt(document.getElementById('dcCreditsPer')?.value, 0);
      const tEl = document.getElementById('dcHelperTotal');
      const pEl = document.getElementById('dcHelperPer');
      if (tEl) tEl.textContent = `${roofsFromDollars(total)} roofs`;
      if (pEl) pEl.textContent = `${roofsFromDollars(per)} roofs`;
    },

    wire(){
      document.getElementById('dcRefreshBtn')?.addEventListener('click', () => this.refresh());
      document.getElementById('dcNewBtn')?.addEventListener('click', () => this.openCreate());

      document.getElementById('dcCloseX')?.addEventListener('click', () => this.closeModal());
      document.getElementById('dcCloseBtn')?.addEventListener('click', () => this.closeModal());
      document.getElementById('dcSaveBtn')?.addEventListener('click', () => this.save());
      document.getElementById('dcViewBtn')?.addEventListener('click', () => this.toggleDetails());
      document.getElementById('dcDeleteBtn')?.addEventListener('click', () => this.deleteCurrent());

      // live helper updates
      const total = document.getElementById('dcCreditsTotal');
      const per   = document.getElementById('dcCreditsPer');
      total?.addEventListener('input', () => this.updateHelpers());
      per?.addEventListener('input', () => this.updateHelpers());
    },

    async onShow(){
      await this.refresh();
    },

    async refresh(){
      const tb = document.getElementById('discountCodesTable');
      if (tb) tb.innerHTML = `<tr><td colspan="10" style="text-align:center; padding:30px;">Loading...</td></tr>`;

      const data = await this.api({ action:'coupon_admin_list' }).catch(()=>({}));
      this.items = data.coupons || [];

      if (!tb) return;
      tb.innerHTML = '';

      if (!this.items.length) {
        tb.innerHTML = `<tr><td colspan="10" style="text-align:center; padding:30px; color:#999;">No codes.</td></tr>`;
        return;
      }

      this.items.forEach(c => {
        const used = Number(c.redemptions_count || 0);
        const total = toInt(c.credits_total, 0);
        const rem   = toInt(c.credits_remaining, 0);
        const per   = toInt(c.credits_per_redeem, 0);

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="mono">${Portal.escapeHtml(c.code_hash || '')}</td>
          <td>${Portal.escapeHtml(c.status || '')}</td>
          <td title="~${roofsFromDollars(total)} roofs">${Portal.escapeHtml(fmtMoney(total))}</td>
          <td title="~${roofsFromDollars(rem)} roofs">${Portal.escapeHtml(fmtMoney(rem))}</td>
          <td title="~${roofsFromDollars(per)} roofs">${Portal.escapeHtml(fmtMoney(per))}</td>
          <td>${Number(c.max_redemptions || 0)}</td>
          <td>${used}</td>
          <td>${c.once_per_user ? 'yes' : 'no'}</td>
          <td>${Portal.escapeHtml((c.created_at||'') ? String(c.created_at).replace('T',' ').replace('Z','') : '')}</td>
          <td style="text-align:right">
            <button class="btn-secondary btn-sm" data-edit="${Portal.escapeHtml(c.code_hash || '')}">Edit</button>
            <button class="btn-secondary btn-sm" data-usage="${Portal.escapeHtml(c.code_hash || '')}">Usage</button>
          </td>
        `;
        tr.querySelector('[data-edit]')?.addEventListener('click', () => this.openEdit(c.code_hash));
        tr.querySelector('[data-usage]')?.addEventListener('click', () => this.openDetails(c.code_hash));
        tb.appendChild(tr);
      });
    },

    openCreate(){
      document.getElementById('dcModalTitle').innerText = 'New Discount Code';
      document.getElementById('dcMode').value = 'create';
      document.getElementById('dcCodeHash').value = '';

      const code = document.getElementById('dcCode');
      code.value = '';
      code.disabled = false;

      document.getElementById('dcStatus').value = 'active';

      // Defaults: multiples of $7 (10 roofs total; 1 roof per redeem)
      document.getElementById('dcCreditsTotal').value = String(ROOF_COST * 10);
      document.getElementById('dcCreditsPer').value = String(ROOF_COST);
      document.getElementById('dcMaxRed').value = 10;
      document.getElementById('dcOncePerUser').checked = true;

      document.getElementById('dcDeleteBtn').style.display = 'none';
      document.getElementById('dcViewBtn').style.display = 'none';

      this.showingDetails = false;
      this.syncModalAreas();
      this.openModal();
      this.updateHelpers();
    },

    async openEdit(codeHash){
      const data = await this.api({ action:'coupon_admin_get', code_hash: codeHash }).catch(()=>({}));
      if (!data.success) return alert(data.error || 'Failed to load');

      const c = data.coupon || {};

      document.getElementById('dcModalTitle').innerText = 'Edit Discount Code';
      document.getElementById('dcMode').value = 'edit';
      document.getElementById('dcCodeHash').value = c.code_hash || codeHash;

      const code = document.getElementById('dcCode');
      code.value = '';
      code.disabled = true;

      document.getElementById('dcStatus').value = (c.status === 'disabled') ? 'disabled' : 'active';

      // dollars
      document.getElementById('dcCreditsTotal').value = String(toInt(c.credits_total, ROOF_COST * 10));
      document.getElementById('dcCreditsPer').value   = String(toInt(c.credits_per_redeem, ROOF_COST));
      document.getElementById('dcMaxRed').value       = String(toInt(c.max_redemptions, 1));
      document.getElementById('dcOncePerUser').checked = !!c.once_per_user;

      document.getElementById('dcDeleteBtn').style.display = 'inline-flex';
      document.getElementById('dcViewBtn').style.display = 'inline-flex';

      this.renderDetails(c);
      this.showingDetails = false;
      this.syncModalAreas();
      this.openModal();
      this.updateHelpers();
    },

    async openDetails(codeHash){
      await this.openEdit(codeHash);
      this.showingDetails = true;
      this.syncModalAreas();
    },

    renderDetails(c){
      const used = Math.max(0, Number(c.redemptions_count || 0));
      const max  = Number(c.max_redemptions || 0);
      const total= toInt(c.credits_total, 0);
      const rem  = toInt(c.credits_remaining, 0);

      const sum = document.getElementById('dcRedSummary');
      if (sum) {
        sum.textContent = `${used}/${max} redemptions • ${fmtMoney(rem)}/${fmtMoney(total)} remaining • ~${roofsFromDollars(rem)} roofs left`;
      }

      const list = document.getElementById('dcRedeemList');
      if (!list) return;

      const reds = Array.isArray(c.redemptions) ? c.redemptions : [];
      if (!reds.length) {
        list.innerHTML = `<div style="color:#999; font-style:italic;">No redemptions yet.</div>`;
        return;
      }

      list.innerHTML = reds.slice().reverse().map(r => {
        const email = Portal.escapeHtml(r.email || '');
        const dollars = toInt(r.credits, 0); // server still calls it "credits" but it's dollars now
        const ts = Portal.escapeHtml((r.ts||'').replace('T',' ').replace('Z',''));
        return `<div style="padding:8px 6px; border-bottom:1px solid #eee;">
                  <div style="font-weight:800;">${email}</div>
                  <div style="font-size:12px; color:#666;">+${fmtMoney(dollars)} • ~${roofsFromDollars(dollars)} roofs • ${ts}</div>
                </div>`;
      }).join('');
    },

    async save(){
      const mode = document.getElementById('dcMode').value;
      return (mode === 'create') ? this.create() : this.update();
    },

    async create(){
      const code = (document.getElementById('dcCode').value || '').trim();

      // dollars, default multiples of $7 but user can set any
      const credits_total = clampInt(document.getElementById('dcCreditsTotal').value, 1, 1000000);
      const credits_per_redeem = clampInt(document.getElementById('dcCreditsPer').value, 1, 1000000);
      const max_redemptions = clampInt(document.getElementById('dcMaxRed').value, 1, 1000000);
      const once_per_user = document.getElementById('dcOncePerUser').checked ? '1' : '0';

      const btn = document.getElementById('dcSaveBtn');
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Saving…'; }

      try {
        const payload = {
          action:'coupon_admin_create',
          credits_total: String(credits_total),
          credits_per_redeem: String(credits_per_redeem),
          max_redemptions: String(max_redemptions),
          once_per_user
        };
        if (code) payload.code = code;

        const data = await this.api(payload);
        if (!data.success) throw new Error(data.error || 'Create failed');

        alert(
          `Created code:\n\n${data.code}\n\n` +
          `Value: ${fmtMoney(credits_total)} total (≈ ${roofsFromDollars(credits_total)} roofs)\n\n` +
          `Copy it now — it won’t be shown again.`
        );

        await this.refresh();
        this.closeModal();
      } catch (e) {
        alert(String(e.message || e));
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = 'Save'; }
      }
    },

    async update(){
      const code_hash = document.getElementById('dcCodeHash').value;
      if (!code_hash) return;

      const status = document.getElementById('dcStatus').value;

      const credits_total = clampInt(document.getElementById('dcCreditsTotal').value, 1, 1000000);
      const credits_per_redeem = clampInt(document.getElementById('dcCreditsPer').value, 1, 1000000);
      const max_redemptions = clampInt(document.getElementById('dcMaxRed').value, 1, 1000000);
      const once_per_user = document.getElementById('dcOncePerUser').checked ? '1' : '0';

      const btn = document.getElementById('dcSaveBtn');
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Saving…'; }

      try {
        const data = await this.api({
          action:'coupon_admin_update',
          code_hash,
          status,
          credits_total: String(credits_total),
          credits_per_redeem: String(credits_per_redeem),
          max_redemptions: String(max_redemptions),
          once_per_user
        });

        if (!data.success) throw new Error(data.error || 'Update failed');

        await this.refresh();

        const d2 = await this.api({ action:'coupon_admin_get', code_hash }).catch(()=>({}));
        if (d2.success) this.renderDetails(d2.coupon || {});

        alert('Saved.');
      } catch (e) {
        alert(String(e.message || e));
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = 'Save'; }
      }
    },

    async deleteCurrent(){
      const code_hash = document.getElementById('dcCodeHash').value;
      if (!code_hash) return;
      if (!confirm('Delete this discount code? This cannot be undone.')) return;

      const data = await this.api({ action:'coupon_admin_delete', code_hash }).catch(()=>({}));
      if (!data.success) return alert(data.error || 'Delete failed');

      await this.refresh();
      this.closeModal();
    }
  };

  if (canManageCoupons()) {
    ensureMarkup();

    Portal.registerPlugin({
      id: 'discount-codes',
      title: 'Discount Codes',
      iconClass: 'fas fa-tag'
    });

    DiscountCodes.wire();

    const origSwitch = Portal.switchView.bind(Portal);
    Portal.switchView = async function(id, btn){
      await origSwitch(id, btn);
      if (id === 'discount-codes') await DiscountCodes.onShow();
    };

    window.DiscountCodes = DiscountCodes;
  }
})();
