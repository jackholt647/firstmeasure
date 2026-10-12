/* Settings > Price Book > Suppliers.
 * A supplier is an external connection with a supplier role. It owns a catalogue of price book items
 * (carried, SKU, price) and a delivery fee. A location stores only how it differs from its supplier,
 * so nothing is copied and a supplier-level change reaches every location that has not overridden it.
 */
(function(root){
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const text = (value) => String(value ?? '').trim();
  const dollars = (cents) => (cents == null || cents === '' || !Number.isFinite(Number(cents)) ? '' : (Number(cents) / 100).toFixed(2).replace(/\.00$/, ''));
  const toCents = (value) => { const cleaned = text(value).replace(/[^0-9.]/g, ''); return cleaned === '' || !Number.isFinite(Number(cleaned)) ? null : Math.round(Number(cleaned) * 100); };
  const label = (value) => text(value).replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

  function injectStyles(){
    if (document.getElementById('fm-supplier-settings-style')) return;
    const style = document.createElement('style');
    style.id = 'fm-supplier-settings-style';
    style.textContent = `
      .sup-wrap{display:grid;grid-template-columns:240px minmax(0,1fr);gap:14px;min-height:480px;height:100%;padding:0 14px 14px;box-sizing:border-box;font-size:12px;color:#344054}
      .sup-list{display:flex;flex-direction:column;gap:4px;min-height:0;overflow:auto;padding:8px;border:1px solid #e4e7ec;border-radius:10px;background:#fff}
      .sup-list button{display:block;width:100%;padding:8px 10px;border:0;border-radius:7px;background:transparent;text-align:left;color:#344054;cursor:pointer}
      .sup-list button:hover{background:#f2f4f7}.sup-list button.active{background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary-readable,var(--primary,#d93025))}
      .sup-list button strong{display:block;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sup-list button small{display:block;margin-top:1px;font-size:10px;color:#667085}
      .sup-list button[data-sup-select]{display:grid;grid-template-columns:28px minmax(0,1fr);column-gap:8px;align-items:center}.sup-list button[data-sup-select] .sup-mark{grid-row:1 / span 2}
      .sup-mark{width:28px;height:28px;border-radius:6px;border:1px solid #e4e7ec;background:#fff;object-fit:contain;display:grid;place-items:center;font-size:12px;font-weight:700;color:#667085;box-sizing:border-box}
      .sup-logo{flex:none;position:relative;width:40px;height:40px;border:1px dashed #d0d5dd;border-radius:8px;background:#f9fafb;display:grid;place-items:center;color:#98a2b3;cursor:pointer;overflow:hidden}.sup-logo.has{border-style:solid;background:#fff}.sup-logo:hover{border-color:#98a2b3}
      .sup-logo img{width:100%;height:100%;object-fit:contain}.sup-logo input{position:absolute;inset:0;opacity:0;cursor:pointer;font-size:0}
      .sup-list .sup-new{border:1px dashed #d0d5dd;margin-bottom:4px;font-weight:600;text-align:center}
      .sup-main{min-width:0;min-height:0;display:flex;flex-direction:column;gap:10px;overflow:hidden;padding:12px;border:1px solid #e4e7ec;border-radius:10px;background:#fff}
      .sup-empty{margin:auto;text-align:center;color:#667085}
      .sup-head{display:flex;align-items:center;gap:8px}.sup-head input{flex:1;min-width:0;height:34px;padding:0 10px;border:1px solid #d0d5dd;border-radius:8px;font-size:15px;font-weight:700;color:#101828}
      .sup-btn{height:32px;padding:0 12px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}
      .sup-btn:hover:not(:disabled){border-color:#98a2b3}.sup-btn:disabled{opacity:.5;cursor:default}
      .sup-btn.primary{border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:var(--on-primary,#fff)}
      .sup-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
      .sup-fields label{display:flex;flex-direction:column;gap:3px;font-size:10px;font-weight:600;color:#667085}
      .sup-fields input{height:30px;padding:0 8px;border:1px solid #d0d5dd;border-radius:7px;font-size:12px;color:#101828;min-width:0}
      .sup-locs{display:flex;align-items:center;flex-wrap:wrap;gap:6px}
      .sup-chip{height:26px;padding:0 10px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#475467;font-size:11px;font-weight:600;cursor:pointer}
      .sup-chip.active{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.07);color:var(--primary-readable,var(--primary,#d93025))}
      .sup-chip small{font-weight:500;color:#98a2b3;margin-left:4px}.sup-link{border:0;background:transparent;color:#475467;font-size:11px;text-decoration:underline;cursor:pointer;padding:0}
      .sup-tools{display:flex;align-items:center;gap:8px}.sup-tools input{flex:1;min-width:0;height:30px;padding:0 9px;border:1px solid #d0d5dd;border-radius:7px;font-size:12px}
      .sup-items{flex:1;min-height:0;overflow:auto;border:1px solid #eaecf0;border-radius:8px}
      .sup-items table{width:100%;border-collapse:collapse}.sup-items th,.sup-items td{padding:4px 8px;border-bottom:1px solid #f0f2f5;text-align:left;font-size:12px;vertical-align:middle}
      .sup-items thead th{position:sticky;top:0;z-index:1;background:#f9fafb;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#667085}
      .sup-items tr.sup-cat th{background:#f2f4f7;font-size:11px;color:#344054}.sup-items tr.sup-cat th span{font-weight:500;color:#667085;margin-left:6px}
      .sup-items tr.sup-cat button{margin-left:8px}.sup-items td.sup-name small{display:block;font-size:10px;color:#98a2b3}
      .sup-items input[type=text]{width:100%;min-width:0;height:26px;box-sizing:border-box;padding:0 6px;border:1px solid transparent;border-radius:5px;background:#f6f7f9;font-size:12px;color:#101828}
      .sup-items input[type=text]:hover,.sup-items input[type=text]:focus{border-color:#d0d5dd;background:#fff}.sup-items input::placeholder{color:#98a2b3}
      .sup-items tr.off td.sup-name{color:#98a2b3}.sup-items tr.own td{background:rgba(var(--primary-rgb,217,48,37),.035)}
      .sup-items td.sup-price{width:120px}.sup-items td.sup-sku{width:150px}.sup-items td.sup-check{width:28px}.sup-items td.sup-reset{width:28px}
      .sup-reset button{border:0;background:transparent;color:#98a2b3;cursor:pointer}.sup-reset button:hover{color:#344054}
      .sup-note{font-size:11px;color:#667085}
      @media(max-width:860px){.sup-wrap{grid-template-columns:1fr}.sup-list{max-height:160px}}
    `;
    document.head.append(style);
  }

  function mount(host, options = {}){
    injectStyles();
    const api = () => root.MaterialsAPI?.suppliers;
    const orgId = () => text(typeof options.orgId === 'function' ? options.orgId() : options.orgId);
    const toast = options.toast || (() => {});
    const state = { suppliers: [], selectedId: '', locationId: '', draft: null, dirty: false, search: '', loading: true, error: '', saving: false };
    const items = () => (Array.isArray(options.pricebook?.getState?.().items) ? options.pricebook.getState().items : []);

    const draftFrom = (supplier) => ({
      id: supplier.id || '', revision: supplier.revision || 0, name: supplier.name || '', logo: supplier.logo || '', order_email: supplier.order_email || '', phone: supplier.phone || '', address: supplier.address || '',
      fee: dollars(supplier.delivery_fee?.amount_cents), freeAbove: dollars(supplier.delivery_fee?.free_above_cents),
      offerings: new Map((supplier.offerings || []).map((row) => [row.item_id, { sku: row.sku || '', price_cents: row.price_cents ?? null }])),
      locations: (supplier.locations || []).map((location) => ({
        id: location.id, revision: location.revision || 0, name: location.name || '', order_email: location.order_email || '', phone: location.phone || '', address: location.address || '',
        fee: dollars(location.delivery_fee?.amount_cents), freeAbove: dollars(location.delivery_fee?.free_above_cents), dirty: false,
        overrides: new Map((location.overrides || []).map((row) => [row.item_id, { ...row }]))
      }))
    });
    const logoMark = (supplier) => supplier.logo ? `<img class="sup-mark" src="${esc(supplier.logo)}" alt="">` : `<span class="sup-mark">${esc(text(supplier.name).slice(0, 1).toUpperCase() || '?')}</span>`;
    const currentLocation = () => state.draft?.locations.find((location) => location.id === state.locationId) || null;
    const offer = (itemId) => {
      const base = state.draft.offerings.get(itemId) || null, location = currentLocation(), override = location?.overrides.get(itemId) || null;
      const carried = override?.carried ?? !!base;
      return { base, override, carried, sku: override?.sku !== undefined ? override.sku : base?.sku || '', price_cents: override && Object.prototype.hasOwnProperty.call(override, 'price_cents') ? override.price_cents : base?.price_cents ?? null };
    };
    const markDirty = () => { state.dirty = true; const location = currentLocation(); if (location) location.dirty = true; host.querySelector('[data-sup-save]')?.removeAttribute('disabled'); };

    async function load(keep = ''){
      state.loading = true; state.error = ''; render();
      try {
        if (!api()) throw Error('The supplier service is unavailable.');
        await options.pricebook?.loadState?.();
        state.suppliers = (await api().list(orgId())).suppliers || [];
        const selected = state.suppliers.find((row) => row.id === (keep || state.selectedId)) || state.suppliers[0] || null;
        state.selectedId = selected?.id || ''; state.draft = selected ? draftFrom(selected) : null; state.dirty = false;
        if (!currentLocation()) state.locationId = '';
      } catch (error) { state.error = error?.message || 'Suppliers could not be loaded.'; }
      state.loading = false; render();
    }

    const feeInput = (draft) => { const amount = toCents(draft.fee); return amount == null ? null : { amount_cents: amount, free_above_cents: toCents(draft.freeAbove) }; };
    async function save(){
      const draft = state.draft; if (!draft || state.saving) return;
      if (!text(draft.name)) { toast('Name needed', 'Give the supplier a name.', false); return; }
      state.saving = true; render();
      try {
        const body = { name: text(draft.name), logo: text(draft.logo), order_email: text(draft.order_email), phone: text(draft.phone), address: text(draft.address), delivery_fee: feeInput(draft), offerings: [...draft.offerings].map(([item_id, row]) => ({ item_id, sku: text(row.sku), price_cents: row.price_cents ?? null })) };
        const saved = draft.id ? (await api().save(orgId(), draft.id, { ...body, expected_revision: draft.revision })).supplier : (await api().create(orgId(), body)).supplier;
        for (const location of draft.locations.filter((entry) => entry.dirty || !entry.id || String(entry.id).startsWith('new:'))) {
          const input = { name: text(location.name) || 'Location', order_email: text(location.order_email), phone: text(location.phone), address: text(location.address), delivery_fee: feeInput(location), overrides: [...location.overrides.values()] };
          if (String(location.id).startsWith('new:')) await api().createLocation(orgId(), saved.id, input);
          else await api().saveLocation(orgId(), saved.id, location.id, { ...input, expected_revision: location.revision });
        }
        state.saving = false;
        toast('Supplier saved', saved.name, true);
        offerLowerPrices(saved.name, [...draft.offerings].map(([item_id, row]) => [item_id, row.price_cents]));
        state.locationId = String(state.locationId).startsWith('new:') ? '' : state.locationId;
        await load(saved.id);
      } catch (error) { state.saving = false; render(); toast('Could not save supplier', error?.message || 'Please try again.', false); }
    }

    // Supplier prices are costs, so they are compared with and written to the price book's base cost, never its sell price.
    function applyBaseCosts(costs){
      const changed = items().filter((item) => costs.has(item.id)).map((item) => ({ ...item, internalCost: costs.get(item.id) / 100, internal_cost: costs.get(item.id) / 100 }));
      if (changed.length) options.pricebook.importItems(changed, { mode: 'merge' });
      return changed.length;
    }
    function offerLowerPrices(name, prices){
      if (!options.pricebook?.importItems) return;
      const byId = new Map(items().map((item) => [item.id, item]));
      const lower = new Map(prices.filter(([id, cents]) => cents != null && byId.has(id) && (!(Number(byId.get(id).internalCost) > 0) || cents < Math.round(Number(byId.get(id).internalCost) * 100))));
      if (!lower.size) return;
      if (root.confirm(`${lower.size} item${lower.size === 1 ? ' is' : 's are'} cheaper at ${name} than the base cost in your price book. Update the price book base cost to these prices?`)) toast('Price book updated', `${applyBaseCosts(lower)} base cost${lower.size === 1 ? '' : 's'} updated.`, true);
    }
    function setLowestEverywhere(){
      const lowest = new Map();
      const consider = (id, cents) => { if (cents != null && (!lowest.has(id) || cents < lowest.get(id))) lowest.set(id, cents); };
      state.suppliers.forEach((supplier) => (supplier.id === state.draft?.id ? [] : supplier.offerings).forEach((row) => consider(row.item_id, row.price_cents)));
      state.draft?.offerings.forEach((row, id) => consider(id, row.price_cents));
      const byId = new Map(items().map((item) => [item.id, item]));
      const changes = new Map([...lowest].filter(([id, cents]) => byId.has(id) && Math.round(Number(byId.get(id).internalCost || 0) * 100) !== cents));
      if (!changes.size) { toast('Nothing to update', 'Every priced item already matches its lowest supplier price.', true); return; }
      const down = [...changes].filter(([id, cents]) => cents < Math.round(Number(byId.get(id).internalCost || 0) * 100) || !(Number(byId.get(id).internalCost) > 0)).length;
      if (root.confirm(`Set the price book base cost of ${changes.size} item${changes.size === 1 ? '' : 's'} to the lowest supplier price? ${down} will go down or be filled in and ${changes.size - down} will go up.`)) toast('Price book updated', `${applyBaseCosts(changes)} base costs updated.`, true);
    }

    function itemRows(){
      const needle = state.search.toLowerCase(), location = currentLocation(), groups = new Map();
      items().forEach((item) => {
        if (needle && !`${item.name} ${item.code || ''} ${item.category || ''}`.toLowerCase().includes(needle)) return;
        const key = text(item.type || item.category) || 'Other';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      });
      if (!groups.size) return `<tr><td colspan="5" class="sup-note" style="padding:14px">${items().length ? 'No price book items match.' : 'The price book has no items yet.'}</td></tr>`;
      return [...groups].map(([group, rows]) => {
        const carried = rows.filter((item) => offer(item.id).carried).length;
        return `<tr class="sup-cat"><th colspan="5">${esc(label(group))}<span>${carried} of ${rows.length} carried</span><button type="button" class="sup-link" data-sup-all="${esc(group)}">Carries all</button><button type="button" class="sup-link" data-sup-none="${esc(group)}">None</button></th></tr>${rows.map((item) => {
          const current = offer(item.id), own = !!current.override;
          return `<tr class="${current.carried ? '' : 'off'}${own ? ' own' : ''}" data-sup-item="${esc(item.id)}"><td class="sup-check"><input type="checkbox" data-sup-carried ${current.carried ? 'checked' : ''} aria-label="Carries ${esc(item.name)}"></td><td class="sup-name">${esc(item.name)}<small>${esc([item.code ? `SKU ${item.code}` : 'No SKU in price book', item.manufacturer, `base cost ${Number(item.internalCost) > 0 ? '$' + Number(item.internalCost).toFixed(2) : 'not set'}`].filter(Boolean).join(' · '))}</small></td><td class="sup-sku"><input type="text" data-sup-sku value="${esc(location ? (current.override?.sku ?? '') : current.sku)}" placeholder="${esc(location ? current.base?.sku || 'Supplier SKU' : 'Supplier SKU')}" ${current.carried ? '' : 'disabled'} aria-label="Supplier SKU for ${esc(item.name)}"></td><td class="sup-price"><input type="text" inputmode="decimal" data-sup-price value="${esc(location ? (current.override && Object.prototype.hasOwnProperty.call(current.override, 'price_cents') ? dollars(current.override.price_cents) : '') : dollars(current.price_cents))}" placeholder="${esc(location && current.base?.price_cents != null ? dollars(current.base.price_cents) : 'Unknown')}" ${current.carried ? '' : 'disabled'} aria-label="Price per ${esc(item.unit || 'unit')} for ${esc(item.name)}" title="Price per ${esc(item.unit || 'unit')}"></td><td class="sup-reset">${location && own ? `<button type="button" data-sup-reset title="Use the supplier's own values again" aria-label="Reset ${esc(item.name)} to the supplier's values"><i class="fas fa-rotate-left"></i></button>` : ''}</td></tr>`;
        }).join('')}`;
      }).join('');
    }

    function render(){
      const draft = state.draft, location = currentLocation();
      const list = `<aside class="sup-list"><button type="button" class="sup-new" data-sup-new><i class="fas fa-plus"></i> Add supplier</button>${state.suppliers.map((row) => `<button type="button" class="${row.id === state.selectedId ? 'active' : ''}" data-sup-select="${esc(row.id)}">${logoMark(row)}<strong>${esc(row.name)}</strong><small>${row.offerings.length} item${row.offerings.length === 1 ? '' : 's'}${row.locations.length ? ` · ${row.locations.length} location${row.locations.length === 1 ? '' : 's'}` : ''}</small></button>`).join('')}${draft && !draft.id ? '<button type="button" class="active"><strong>New supplier</strong><small>Not saved yet</small></button>' : ''}</aside>`;
      if (state.loading || state.error || !draft) { host.innerHTML = `<div class="sup-wrap">${list}<section class="sup-main"><div class="sup-empty">${state.loading ? 'Loading suppliers…' : esc(state.error) || 'Add the companies you buy from. Each one lists which price book items it carries, at what price, and what it charges for delivery.'}</div></section></div>`; return; }
      const target = location || draft;
      host.innerHTML = `<div class="sup-wrap">${list}<section class="sup-main">
        <div class="sup-head"><label class="sup-logo${draft.logo ? ' has' : ''}" title="${draft.logo ? 'Change the logo' : 'Add a logo'}">${draft.logo ? `<img src="${esc(draft.logo)}" alt="">` : '<i class="fas fa-image" aria-hidden="true"></i>'}<input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-sup-logo aria-label="Supplier logo"></label>${draft.logo ? '<button type="button" class="sup-link" data-sup-logo-clear>Remove logo</button>' : ''}<input data-sup-field="name" data-sup-owner="supplier" value="${esc(draft.name)}" placeholder="Supplier name" aria-label="Supplier name"><button type="button" class="sup-btn primary" data-sup-save ${state.dirty && !state.saving ? '' : 'disabled'}>${state.saving ? 'Saving…' : 'Save'}</button>${draft.id ? '<button type="button" class="sup-btn" data-sup-delete title="Remove this supplier"><i class="fas fa-trash"></i></button>' : ''}</div>
        <div class="sup-locs">${draft.locations.length ? `<button type="button" class="sup-chip${location ? '' : ' active'}" data-sup-location="">All locations</button>${draft.locations.map((entry) => `<button type="button" class="sup-chip${entry.id === state.locationId ? ' active' : ''}" data-sup-location="${esc(entry.id)}">${esc(entry.name || 'Location')}<small>${entry.overrides.size + (text(entry.fee) ? 1 : 0) ? `${entry.overrides.size + (text(entry.fee) ? 1 : 0)} different` : 'same as supplier'}</small></button>`).join('')}<button type="button" class="sup-link" data-sup-add-location>Add location</button>` : `<span class="sup-note">One location.</span><button type="button" class="sup-link" data-sup-add-location>Add another location</button>`}</div>
        <div class="sup-fields">${location ? `<label>Location name<input data-sup-field="name" value="${esc(location.name)}"></label>` : ''}<label>Order email<input data-sup-field="order_email" value="${esc(target.order_email)}" placeholder="${esc(location ? draft.order_email || 'orders@supplier.com' : 'orders@supplier.com')}"></label><label>Phone<input data-sup-field="phone" value="${esc(target.phone)}" placeholder="${esc(location ? draft.phone : '')}"></label><label>Address<input data-sup-field="address" value="${esc(target.address)}"></label><label>Delivery fee ($)<input data-sup-field="fee" inputmode="decimal" value="${esc(target.fee)}" placeholder="${esc(location ? (text(draft.fee) ? `${draft.fee} (supplier)` : 'None') : 'None')}"></label><label>Free delivery above ($)<input data-sup-field="freeAbove" inputmode="decimal" value="${esc(target.freeAbove)}" placeholder="${esc(location && text(draft.freeAbove) ? `${draft.freeAbove} (supplier)` : 'Never')}"></label>${location ? '<label>&nbsp;<button type="button" class="sup-btn" data-sup-remove-location>Remove location</button></label>' : ''}</div>
        <div class="sup-tools"><input data-sup-search value="${esc(state.search)}" placeholder="Search price book items" aria-label="Search price book items"><button type="button" class="sup-btn" data-sup-lowest title="Set each item's base cost in the price book to its lowest supplier price">Set base costs to lowest price</button></div>
        <div class="sup-items"><table><thead><tr><th></th><th>Price book item</th><th>Supplier SKU</th><th>Price</th><th></th></tr></thead><tbody>${itemRows()}</tbody></table></div>
        <div class="sup-note">${location ? `Showing ${esc(location.name || 'this location')}. Greyed values come from the supplier; type over one to give this location its own.` : 'Prices are per price book unit. Leave a price blank when the supplier carries the item but you do not know the price.'}</div>
      </section></div>`;
    }

    const confirmLeave = () => !state.dirty || root.confirm('Discard unsaved supplier changes?');
    host.addEventListener('click', async (event) => {
      const button = event.target.closest('button'); if (!button || !host.contains(button)) return;
      const data = button.dataset, draft = state.draft, location = currentLocation();
      if ('supNew' in data) { if (!confirmLeave()) return; state.selectedId = ''; state.locationId = ''; state.draft = draftFrom({}); state.dirty = true; render(); host.querySelector('[data-sup-field="name"]')?.focus(); }
      else if (data.supSelect) { if (!confirmLeave()) return; state.selectedId = data.supSelect; state.locationId = ''; state.draft = draftFrom(state.suppliers.find((row) => row.id === data.supSelect)); state.dirty = false; render(); }
      else if ('supSave' in data) save();
      else if ('supLogoClear' in data) { draft.logo = ''; state.dirty = true; render(); }
      else if ('supDelete' in data) { if (!root.confirm(`Remove ${draft.name}? Its catalogue and locations are removed with it.`)) return; try { await api().archive(orgId(), draft.id); state.selectedId = ''; state.dirty = false; toast('Supplier removed', draft.name, true); await load(); } catch (error) { toast('Could not remove supplier', error?.message || 'Please try again.', false); } }
      else if ('supLocation' in data) { state.locationId = data.supLocation; render(); }
      else if ('supAddLocation' in data) { const id = `new:${Date.now()}`; draft.locations.push({ id, revision: 0, name: draft.locations.length ? `Location ${draft.locations.length + 1}` : 'Second location', order_email: '', phone: '', address: '', fee: '', freeAbove: '', dirty: true, overrides: new Map() }); state.locationId = id; state.dirty = true; render(); host.querySelector('.sup-fields [data-sup-field="name"]')?.select(); }
      else if ('supRemoveLocation' in data && location) { if (!root.confirm(`Remove ${location.name || 'this location'}?`)) return; try { if (!String(location.id).startsWith('new:')) await api().archiveLocation(orgId(), draft.id, location.id); draft.locations = draft.locations.filter((entry) => entry !== location); state.locationId = ''; render(); } catch (error) { toast('Could not remove location', error?.message || 'Please try again.', false); } }
      else if ('supLowest' in data) setLowestEverywhere();
      else if (data.supAll || data.supNone) {
        const group = data.supAll || data.supNone, carry = !!data.supAll;
        items().filter((item) => (text(item.type || item.category) || 'Other') === group).forEach((item) => setCarried(item.id, carry));
        markDirty(); render();
      } else if ('supReset' in data && location) { location.overrides.delete(button.closest('[data-sup-item]').dataset.supItem); markDirty(); render(); }
    });
    // Logos are stored with the supplier, so they are scaled to fit a 128px box before saving.
    function readLogo(file){
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file), image = new Image();
        image.onload = () => {
          URL.revokeObjectURL(url);
          const scale = Math.min(1, 128 / Math.max(image.naturalWidth || 128, image.naturalHeight || 128));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round((image.naturalWidth || 128) * scale)); canvas.height = Math.max(1, Math.round((image.naturalHeight || 128) * scale));
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/png'));
        };
        image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file could not be read as an image.')); };
        image.src = url;
      });
    }
    function setCarried(itemId, carry){
      const location = currentLocation(), draft = state.draft;
      if (!location) { if (carry) { if (!draft.offerings.has(itemId)) draft.offerings.set(itemId, { sku: '', price_cents: null }); } else draft.offerings.delete(itemId); return; }
      const inherited = draft.offerings.has(itemId), override = { ...(location.overrides.get(itemId) || { item_id: itemId }) };
      if (carry === inherited) delete override.carried; else override.carried = carry;
      if (Object.keys(override).length > 1) location.overrides.set(itemId, override); else location.overrides.delete(itemId);
    }
    host.addEventListener('change', (event) => {
      const input = event.target;
      if (input.matches('[data-sup-logo]')) {
        const file = input.files?.[0]; if (!file) return;
        readLogo(file).then((logo) => { state.draft.logo = logo; state.dirty = true; render(); }).catch((error) => toast('Could not use that logo', error?.message || 'Try a PNG or JPEG.', false));
        return;
      }
      if (input.matches('[data-sup-carried]')) { setCarried(input.closest('[data-sup-item]').dataset.supItem, input.checked); markDirty(); render(); }
    });
    host.addEventListener('input', (event) => {
      const input = event.target, draft = state.draft, location = currentLocation();
      if (input.matches('[data-sup-search]')) { state.search = input.value; const body = host.querySelector('.sup-items tbody'); if (body) body.innerHTML = itemRows(); return; }
      if (input.dataset.supField) { (input.dataset.supOwner === 'supplier' ? draft : location || draft)[input.dataset.supField] = input.value; markDirty(); return; }
      const row = input.closest('[data-sup-item]'); if (!row) return;
      const itemId = row.dataset.supItem, field = input.matches('[data-sup-sku]') ? 'sku' : input.matches('[data-sup-price]') ? 'price_cents' : '';
      if (!field) return;
      const value = field === 'sku' ? input.value.trim() : toCents(input.value);
      if (!location) { const entry = draft.offerings.get(itemId) || { sku: '', price_cents: null }; entry[field] = field === 'sku' ? value : value; draft.offerings.set(itemId, entry); }
      else {
        const override = { ...(location.overrides.get(itemId) || { item_id: itemId }) };
        if (input.value.trim() === '') delete override[field]; else override[field] = value;
        if (Object.keys(override).length > 1) location.overrides.set(itemId, override); else location.overrides.delete(itemId);
        row.classList.toggle('own', location.overrides.has(itemId));
      }
      markDirty();
    });
    load();
    return { reload: () => load(), destroy(){ host.innerHTML = ''; } };
  }

  root.FirstMateSupplierSettings = { mount };
})(window);
