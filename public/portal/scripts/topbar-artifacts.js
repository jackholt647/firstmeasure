/* Lazy, extensible search providers for app-level artifacts outside projects/contacts. */
(function(root){
  const cache = new Map();
  const CACHE_MS = 60_000;
  const clean = (...values) => {
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (text) return text;
    }
    return '';
  };
  const array = (value) => Array.isArray(value) ? value : [];
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const docs = (result, key) => array(result?.[key] || result?.documents || result?.items).map((entry) => ({ id:entry?.id, ...object(entry?.data), ...object(entry) }));
  const dateLabel = (value) => {
    const date = new Date(value || '');
    return Number.isFinite(date.getTime()) ? date.toLocaleString([], { dateStyle:'medium', timeStyle:'short' }) : '';
  };
  const money = (cents) => Number.isFinite(Number(cents)) ? new Intl.NumberFormat(undefined, { style:'currency', currency:'USD' }).format(Number(cents) / 100) : '';
  const row = (type, id, title, subtitle, fields, route, raw = {}) => ({
    type, id:clean(id), title:clean(title, TYPE_MAP[type]?.singular, 'Result'), subtitle:clean(subtitle),
    search_text:[title, subtitle, ...array(fields)].map(clean).filter(Boolean).join(' ').toLowerCase(), route, raw
  });

  const TYPES = [
    { id:'project', label:(globalThis.PlatformLanguage?.text("platform","m_19156e80fc8a6e","Projects") ?? "Projects"), singular:'Project', icon:'fa-folder-open' },
    { id:'contact', label:(globalThis.PlatformLanguage?.text("platform","m_6fe082da60f3b0","Contacts") ?? "Contacts"), singular:'Contact', icon:'fa-user' },
    { id:'equipment', label:(globalThis.PlatformLanguage?.text("platform","m_2813f320a63b94","Equipment") ?? "Equipment"), singular:'Equipment', icon:'fa-truck-pickup' },
    { id:'event', label:(globalThis.PlatformLanguage?.text("platform","m_8bd9547de561b6","Events") ?? "Events"), singular:'Event', icon:'fa-calendar-day' },
    { id:'document', label:(globalThis.PlatformLanguage?.text("platform","m_5d7c7ad6033624","Documents") ?? "Documents"), singular:'Document', icon:'fa-file-lines' },
    { id:'scope', label:(globalThis.PlatformLanguage?.text("platform","m_7b531fdbf47e2b","Scopes") ?? "Scopes"), singular:'Scope template', icon:'fa-layer-group' },
    { id:'channel', label:(globalThis.PlatformLanguage?.text("platform","m_dc8b4f6c066b30","Channels") ?? "Channels"), singular:'Channel', icon:'fa-hashtag' },
    { id:'setting', label:(globalThis.PlatformLanguage?.text("platform","m_7d461dc7d355cc","Settings") ?? "Settings"), singular:'Setting', icon:'fa-gear' },
    { id:'user', label:(globalThis.PlatformLanguage?.text("platform","m_50ab7fe67b1e45","Users") ?? "Users"), singular:'User', icon:'fa-user-group' }
  ];
  const TYPE_MAP = Object.fromEntries(TYPES.map((type) => [type.id, type]));

  const providers = {
    user: async ({ orgId }) => {
      const result = await root.PlatformAPI?.users?.list?.(orgId);
      return docs(result, 'users').filter((user) => !user.deleted).map((user) => row(
        'user', user.id, clean(user.name, user.display_name, user.email), clean(user.email, user.title, user.role),
        [user.phone, user.org_permission_level, user.status],
        { tab:'photos_feed', user:user.id, userTab:'activity' }, user
      ));
    },
    equipment: async ({ orgId, branchId }) => {
      const result = await root.EquipmentAPI?.units?.(orgId, { branchId });
      return docs(result, 'units').map((unit) => row(
        'equipment', unit.id, clean(unit.name, unit.identifier, unit.serial_number),
        [clean(unit.identifier, unit.serial_number), clean(unit.status)].filter(Boolean).join(' · '),
        [unit.serial_number, unit.type_name, unit.category_name, unit.make, unit.model, unit.ownership],
        { tab:'equipment', equipmentView:'fleet', equipmentItem:unit.id }, unit
      ));
    },
    event: async ({ orgId }) => {
      const result = await root.PlatformAPI?.calendarEvents?.list?.(orgId);
      return docs(result, 'events').map((event) => {
        const start = clean(event.start_at, event.start, event.date);
        return row(
          'event', event.id, clean(event.title, event.project_title, 'Scheduled item'),
          [dateLabel(start), clean(event.project_title, event.project_address)].filter(Boolean).join(' · '),
          [event.description, event.status, event.kind, event.event_type, event.project_id],
          { tab:'scheduling', scheduleView:'day', date:start ? start.slice(0, 10) : '' }, event
        );
      });
    },
    invoice: async ({ orgId }) => {
      const result = await root.PaymentsAPI?.invoices?.listAll?.(orgId);
      return docs(result, 'invoices').map((invoice) => row(
        'document', `invoice:${invoice.id}`, clean(invoice.number, invoice.invoice_number, invoice.title, `Invoice ${invoice.id}`),
        ['Invoice', clean(invoice.project_title, invoice.customer_name), clean(invoice.status), money(invoice.total_cents ?? invoice.amount_cents)].filter(Boolean).join(' · '),
        [invoice.project_id, invoice.customer_email, invoice.due_at, invoice.memo],
        { tab:'invoices', invoicesView:['paid','void'].includes(clean(invoice.status).toLowerCase()) ? 'history' : 'outstanding', invoice:invoice.id }, invoice
      ));
    },
    receipt: async ({ orgId }) => {
      const result = await root.PaymentsAPI?.receipts?.listFor?.(orgId, {});
      return docs(result, 'receipts').map((receipt) => row(
        'document', `receipt:${receipt.id}`, clean(receipt.title, receipt.merchant_name, receipt.file_name, `Receipt ${receipt.id}`),
        ['Receipt', clean(receipt.project_title, receipt.vendor), money(receipt.total_cents), clean(receipt.purchase_date)].filter(Boolean).join(' · '),
        [receipt.project_id, receipt.notes, receipt.status],
        { tab:'receipts', receipt:receipt.id }, receipt
      ));
    },
    document: async ({ orgId }) => {
      const settled = await Promise.allSettled([
        root.DocumentsAPI?.templates?.list?.(orgId),
        root.DocumentsAPI?.documents?.listStandalone?.(orgId)
      ]);
      const templates = settled[0].status === 'fulfilled' ? docs(settled[0].value, 'templates') : [];
      const standalone = settled[1].status === 'fulfilled' ? docs(settled[1].value, 'documents') : [];
      return [
        ...templates.map((item) => row('document', `template:${item.id}`, clean(item.name, item.title), 'Document template', [item.description, item.kind, item.status], { tab:'documents_studio', studioSection:'templates' }, item)),
        ...standalone.map((item) => row('document', item.id, clean(item.name, item.title), 'Standalone document', [item.description, item.kind, item.status], { tab:'documents_studio', studioSection:'templates' }, item))
      ];
    },
    scope: async ({ orgId, branchId }) => {
      const result = await root.PlatformAPI?.scopes?.list?.(orgId, branchId, { includeDisabled:true });
      return docs(result, 'templates').map((scope) => row(
        'scope', scope.id, clean(scope.name, scope.title), clean(scope.description, scope.status),
        [scope.kind, scope.key],
        { tab:'company_settings', sub:'scope_templates', settingsView:'editor', settingsEntity:`scope:${scope.id}`, scopeTemplateView:'details' }, scope
      ));
    },
    channel: async ({ orgId }) => {
      const result = await root.ChannelsAPI?.channels?.list?.(orgId);
      return docs(result, 'channels').map((channel) => row(
        'channel', channel.id, clean(channel.name, channel.title), clean(channel.topic, channel.description),
        [channel.kind, channel.visibility], { tab:'channels', channel:channel.id }, channel
      ));
    }
  };

  async function providerRows(type, context){
    const provider = providers[type];
    if (!provider) return [];
    const key = `${context.orgId}:${context.branchId}:${type}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.rows;
    if (cached?.promise) return cached.promise;
    const promise = Promise.resolve(provider(context)).then((rows) => {
      cache.set(key, { at:Date.now(), rows:array(rows) });
      return array(rows);
    }).catch(() => {
      cache.set(key, { at:Date.now(), rows:[] });
      return [];
    });
    cache.set(key, { at:0, rows:[], promise });
    return promise;
  }

  function matches(row, query){
    const tokens = String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every((token) => row.search_text.includes(token));
  }

  async function search(query, options = {}){
    const active = new Set(array(options.types));
    const context = { orgId:clean(options.orgId), branchId:clean(options.branchId, 'default') };
    const providerTypes = Object.keys(providers).filter((type) => active.has(type) || (active.has('document') && ['invoice','receipt'].includes(type)));
    const groups = await Promise.all(providerTypes.map((type) => providerRows(type, context)));
    const settings = active.has('setting')
      ? (root.FirstMateSettingsSearch?.search?.(query, { limit:40 }) || []).map((setting) => row(
          'setting', `${setting.section}:${setting.view || ''}:${setting.title}`, setting.title, `${setting.tab} settings`,
          [setting.keywords], null, { setting }
        ))
      : [];
    return [...groups.flat(), ...settings].filter((item) => matches(item, query)).slice(0, Number(options.limit) || 80);
  }

  function open(result){
    if (result?.type === 'setting') return root.FirstMateSettingsSearch?.open?.(result.raw?.setting, { source:'global-artifact-search' }) === true;
    if (!result?.route || !root.Portal?.navigation?.navigate) return false;
    root.Portal.navigation.navigate(result.route, { source:`global-${result.type}-search`, ownedKeys:Object.keys(result.route) });
    return true;
  }

  root.FirstMateArtifactSearch = { TYPES:Object.freeze(TYPES), type:(id) => TYPE_MAP[id], search, open, clearCache:() => cache.clear() };
})(window);
