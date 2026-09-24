/* Shared settings search catalogue used by the portal top bar and Settings rail. */
(function(root){
  const catalog = [];
  const add = (section, tab, entries) => entries.forEach((entry) => {
    const value = typeof entry === 'string' ? { title:entry } : entry;
    catalog.push({ section, tab, view:'', keywords:'', ...value });
  });

  add('my_settings', 'My Settings', [
    'My language', 'Show translations automatically', 'Left column width',
    { title:(globalThis.PlatformLanguage?.text("settings","m_f58512207821a0","Language & translation") ?? "Language & translation"), keywords:'foreign messages localization' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_2805026f294644","Appearance") ?? "Appearance"), keywords:'sidebar display' }
  ]);
  add('company', 'Company', [
    'Company name', 'Company logo', 'Company phone', 'Company email', 'Business address',
    'Brand colors', 'Default branch', 'Company identity', 'Contact details', 'Branding'
  ]);
  add('money', 'Money', [
    { title:(globalThis.PlatformLanguage?.text("settings","m_f16c79ddfcf747","Payment settings") ?? "Payment settings"), view:'payments', keywords:'online payments card ach' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_b1cfecd1c6d08e","Payment accounts") ?? "Payment accounts"), view:'accounts', keywords:'bank stripe processor' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_40f9425502b89f","Payment disputes") ?? "Payment disputes"), view:'disputes', keywords:'chargeback' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_18dc609c73fed7","Payment defaults") ?? "Payment defaults"), view:'payments', keywords:'deposit invoice' }
  ]);
  add('calls', 'Calls', ['Call queues', 'Call assignments', 'Call follow-ups', 'Call outcomes', 'Phone call workflow']);
  add('contacts', 'Contacts', [
    { title:(globalThis.PlatformLanguage?.text("settings","m_dd7c09f845edda","Import contacts") ?? "Import contacts"), view:'import', keywords:'csv vcard upload' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_21c1377746ce5f","Contact import history") ?? "Contact import history"), view:'history', keywords:'previous imports undo' }
  ]);
  add('project_scopes', 'Project Scopes', ['Scope library', 'Add project scope', 'Create from template', 'Clone scope', 'Automation boards', 'Project workflows', 'Automation triggers', 'Automation actions']);
  add('feedback', 'Feedback', [
    { title:(globalThis.PlatformLanguage?.text("settings","m_40390cdba7b5db","Feedback delivery") ?? "Feedback delivery"), view:'delivery' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_d4349c36aae182","Feedback workflow") ?? "Feedback workflow"), view:'workflow' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_781d4602fae423","Feedback responses") ?? "Feedback responses"), view:'responses' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_25aca3d07d8eca","Review requests") ?? "Review requests"), view:'delivery' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_d0201580beb20c","Customer rating scale") ?? "Customer rating scale"), view:'workflow' }
  ]);
  add('equipment', 'Equipment', ['Equipment types', 'Equipment operating defaults', 'Equipment categories']);
  add('live_chat', 'Live Chat', [
    { title:(globalThis.PlatformLanguage?.text("settings","m_d03a3864e5debd","Chat widget") ?? "Chat widget"), view:'widget' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_e268628e71275b","Chat availability") ?? "Chat availability"), view:'hours', keywords:'hours schedule' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_6529324131a51e","Chat routing") ?? "Chat routing"), view:'routing' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_8486d5fa847daf","Chat team") ?? "Chat team"), view:'team' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_bd3b1064741670","Live chat AI agent") ?? "Live chat AI agent"), view:'ai' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_5f4470ddc00b44","Chat greeting") ?? "Chat greeting"), view:'widget' }
  ]);
  add('comms', 'Communications', [
    { title:(globalThis.PlatformLanguage?.text("settings","m_58f88a4c743040","Communication preferences") ?? "Communication preferences"), view:'general', keywords:'email sms inbox' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_3cc8ac595c76f1","Message templates") ?? "Message templates"), view:'templates', keywords:'reusable email sms copy' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_c96e046123187e","Inbound email address") ?? "Inbound email address"), view:'general', keywords:'inbox' }
  ]);
  add('assistant', 'AI Agents', ['AI assistant behavior', 'AI assistant data access', 'AI customer messaging', 'AI agent permissions']);
  add('channels', 'Channels', ['Team channels', 'Channel defaults', 'Channel members']);
  add('users', 'Users', [
    { title:(globalThis.PlatformLanguage?.text("settings","m_57420a03b49adf","People") ?? "People"), view:'people', keywords:'users teammates invite' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_b65aaa94c18c60","Roles & access") ?? "Roles & access"), view:'access', keywords:'permissions permission sets security' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_642c9edaff0fdb","Invite user") ?? "Invite user"), view:'people', keywords:'add teammate employee' }
  ]);
  add('payroll', 'Payroll', ['Pay schedules', 'Payroll assignments', 'Earnings', 'Contractor pay', 'Timesheet defaults']);
  add('reports', 'Reports', ['Measurement report defaults', 'Customer report defaults', 'Report branding']);
  add('documents', 'Documents', ['Required project documents', 'Document defaults', 'Document requirements']);
  add('configuration', 'Configuration', [
    { title:(globalThis.PlatformLanguage?.text("settings","m_2d1233007f5250","Custom fields") ?? "Custom fields"), view:'custom_fields', keywords:'project contact fields' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_172e88e9e61719","Terminology") ?? "Terminology"), view:'terminology', keywords:'rename labels wording' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_99f191126afd49","Project display") ?? "Project display"), view:'projects', keywords:'project configuration layout' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_ef207345c8196c","Celebrations") ?? "Celebrations"), view:'celebrations', keywords:'confetti success animation' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_5430e6902b900e","Insights") ?? "Insights"), view:'insights', keywords:'recommendations tips tooltip agent contextual help' }
  ]);
  add('scheduling', 'Scheduling', ['Appointment confirmations', 'Scheduling availability', 'Assignment rules', 'Booking windows']);
  add('crews', 'Crews and Subcontractors', [
    { title:(globalThis.PlatformLanguage?.text("settings","m_40d0afffa9e25d","Crews and resource groups") ?? "Crews and resource groups"), view:'groups', keywords:'crew members teams' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_8a99cca02b36a4","Organization connections") ?? "Organization connections"), view:'connections', keywords:'subcontractors vendors companies' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_093e042581e1a6","Crew compensation") ?? "Crew compensation"), view:'groups', keywords:'pay rates commissions' }
  ]);
  add('storage', 'Storage', ['Media storage usage', 'Storage limits', 'Deleted media', 'Storage plan']);
  add('sms', 'SMS', ['Messaging registration', '10DLC registration', 'SMS setup', 'Messaging profile']);
  add('domains', 'Domains & Hosting', ['Register domain', 'Connect domain', 'Website hosting', 'DNS settings']);
  add('app_flags', 'Features & Apps', [
    { title:(globalThis.PlatformLanguage?.text("settings","m_713f0340a07ac2","Features & Apps") ?? "Features & Apps"), view:'', keywords:'feature flags enable disable' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_4d4f031a019ad9","Manage My Apps") ?? "Manage My Apps"), view:'manage_apps', keywords:'installed applications' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_536d6b65f599fc","App Locations") ?? "App Locations"), view:'app_locations', keywords:'navigation placement' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_3f7df83412b6a8","App presets") ?? "App presets"), view:'presets', keywords:'feature configuration sets' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_9864b866a47464","Permission Sets") ?? "Permission Sets"), view:'permissions', keywords:'roles access' }
  ]);
  add('pricebook', 'Pricebook', [
    { title:(globalThis.PlatformLanguage?.text("settings","m_a24fa117966050","Pricebook editor") ?? "Pricebook editor"), view:'editor', keywords:'items pricing labor material' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_e899c8b9ef96de","Generate pricebook items") ?? "Generate pricebook items"), view:'generate', keywords:'ai import create' },
    'Proposal formulas'
  ]);
  add('proposals', 'Proposals', ['Proposal defaults', 'Proposal terms', 'Proposal presentation', 'New proposal defaults']);
  add('forms', 'Forms and Leads', [
    { title:(globalThis.PlatformLanguage?.text("settings","m_09e64e54fa804e","Estimate request form") ?? "Estimate request form"), view:'website:estimate', keywords:'website lead form' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_b826296c47cc15","Contact form") ?? "Contact form"), view:'website:contact', keywords:'website lead form' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_5ac2e7ea01fdda","Lead import") ?? "Lead import"), view:'email', keywords:'email inbound leads' },
    { title:(globalThis.PlatformLanguage?.text("settings","m_383c27662b667a","Lead sources") ?? "Lead sources"), view:'email', keywords:'inbound capture' }
  ]);
  add('billing', 'Billing', ['Subscription plan', 'Billing balance', 'Automatic top-ups', 'Payment method', 'Billing history']);
  add('platform_billing', 'Platform Billing', ['Platform subscriptions', 'Usage charges', 'Storage charges', 'Pricing catalog', 'Platform invoices']);

  function normalize(value){
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function search(query, options = {}){
    const needle = normalize(query);
    if (!needle) return [];
    const tokens = needle.split(/\s+/).filter(Boolean);
    const allowed = options.sections ? new Set(Array.from(options.sections, String)) : null;
    return catalog
      .map((item) => {
        if (item.section !== 'users' || root.Portal?.appFlags?.has?.('platform', 'people_access')) return item;
        const titles = { People:'Users', 'Roles & access':'Permissions', 'Invite user':'Add user' };
        return { ...item, title:titles[item.title] || item.title, view:'' };
      })
      .filter((item) => !allowed || allowed.has(item.section))
      .map((item) => {
        const title = normalize(item.title);
        const tab = normalize(item.tab);
        const haystack = `${title} ${tab} ${normalize(item.keywords)}`;
        if (!tokens.every((token) => haystack.includes(token))) return null;
        const score = title === needle ? 0 : title.startsWith(needle) ? 1 : title.includes(needle) ? 2 : tab.startsWith(needle) ? 3 : 4;
        return { ...item, score };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score || a.title.localeCompare(b.title))
      .slice(0, Number(options.limit) || 20);
  }

  function open(item, options = {}){
    if (!item?.section || !root.Portal?.navigation?.navigate) return false;
    root.Portal.navigation.navigate({
      tab:'company_settings',
      sub:item.section,
      settingsView:item.view || '',
      settingsEntity:'',
      scopeTemplateView:'',
      workflow:'',
      workflow_step:''
    }, {
      source:options.source || 'settings-search',
      ownedKeys:['tab','sub','settingsView','settingsEntity','scopeTemplateView','workflow','workflow_step']
    });
    return true;
  }

  root.FirstMateSettingsSearch = { catalog:Object.freeze(catalog), search, open };
})(window);
