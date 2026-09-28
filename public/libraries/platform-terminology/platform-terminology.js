/* libraries/platform-terminology/platform-terminology.js
 * Branch-scoped display terminology for navigation and shared product concepts.
 * Stable application, route, and database ids never pass through this layer.
 */
(function(){
  const root = window;

  const term = (key, label, kind = 'entity') => ({ key, label, kind });
  const section = (id, title, note, terms) => ({ id, title, note, terms });

  const CATALOG = [
    section('projects', 'Projects', 'Project navigation, views, and the primary project record.', [
      term('portal_tab', 'My Projects', 'navigation'), term('crew_portal_tab', 'Projects', 'navigation'), term('overview_tab', 'Overview', 'navigation'), term('map_tab', 'Map', 'navigation'),
      term('project', 'Project'), term('projects', 'Projects'), term('stage', 'Stage'), term('status', 'Status'), term('owner', 'Owner'), term('address', 'Address'), term('submitted_date', 'Submitted')
    ]),
    section('contacts', 'Contacts', 'Contact navigation and customer-facing record names.', [
      term('portal_tab', 'My Contacts', 'navigation'), term('contact', 'Contact'), term('contacts', 'Contacts'), term('customer', 'Customer'), term('customers', 'Customers'), term('homeowner', 'Homeowner'), term('homeowners', 'Homeowners'), term('primary_contact', 'Primary Contact'), term('linked_projects', 'Linked Projects'), term('activity', 'Activity')
    ]),
    section('photos', 'Photos', 'Photo navigation, galleries, and activity views.', [
      term('portal_tab', 'Feed', 'navigation'), term('project_tab', 'Photos', 'navigation'), term('photos_view', 'Photos', 'view'), term('activity_view', 'Activity', 'view'), term('photo', 'Photo'), term('photos', 'Photos'), term('album', 'Album'), term('albums', 'Albums'), term('upload', 'Upload'), term('caption', 'Caption')
    ]),
    section('proposals', 'Proposals', 'Proposal navigation, records, options, and display statuses.', [
      term('portal_tab', 'Proposals', 'navigation'), term('project_tab', 'Proposals', 'navigation'), term('settings_tab', 'Proposals', 'navigation'), term('proposal', 'Proposal'), term('proposals', 'Proposals'), term('template', 'Template'), term('option', 'Option'), term('variation', 'Variation'), term('signature', 'Signature'), term('draft_status', 'Draft', 'status'), term('sent_status', 'Sent', 'status'), term('viewed_status', 'Viewed', 'status'), term('signed_status', 'Signed', 'status'), term('archived_status', 'Archived', 'status'), term('void_status', 'Void', 'status')
    ]),
    section('documents', 'Documents', 'Project document navigation and document records.', [
      term('project_tab', 'Docs', 'navigation'), term('settings_tab', 'Documents', 'navigation'), term('document', 'Document'), term('documents', 'Documents'), term('required_document', 'Required Document'), term('folder', 'Folder'), term('attachment', 'Attachment'), term('markup', 'Markup')
    ]),
    section('document_engine', 'Documents (Engine)', 'Document engine navigation: templated documents, the project Documents tab, and the studio.', [
      term('project_tab', 'Documents', 'navigation'), term('studio_tab', 'Doc Studio', 'navigation'), term('document', 'Document'), term('documents', 'Documents'), term('template', 'Template'), term('templates', 'Templates'), term('theme', 'Theme'), term('themes', 'Themes'), term('snapshot', 'Snapshot'), term('draft_status', 'Draft', 'status'), term('issued_status', 'Issued', 'status'), term('sent_status', 'Sent', 'status'), term('viewed_status', 'Viewed', 'status'), term('signed_status', 'Signed', 'status'), term('completed_status', 'Completed', 'status'), term('declined_status', 'Declined', 'status'), term('void_status', 'Void', 'status')
    ]),
    section('scope', 'Scope', 'Scope navigation, templates, flags, and scope records.', [
      term('project_tab', 'Scope', 'navigation'), term('templates_settings_tab', 'Scope Templates', 'navigation'), term('flags_settings_tab', 'Scope Flags', 'navigation'), term('details_view', 'Details', 'view'), term('commissions_view', 'Commissions', 'view'), term('scope', 'Scope'), term('scope_item', 'Scope Item'), term('scope_items', 'Scope Items'), term('phase', 'Phase'), term('phases', 'Phases'), term('flag', 'Flag'), term('flags', 'Flags'), term('template', 'Template'), term('templates', 'Templates')
    ]),
    section('materials', 'Materials', 'Material records and crew project navigation.', [
      term('crew_project_tab', 'Materials', 'navigation'), term('material', 'Material'), term('materials', 'Materials'), term('material_list', 'Material List'), term('material_lists', 'Material Lists'), term('quantity', 'Quantity'), term('unit', 'Unit'), term('supplier', 'Supplier'), term('order_request', 'Order Request')
    ]),
    section('money', 'Money', 'Project Money navigation, views, summaries, ledgers, and entry forms.', [
      term('project_tab', 'Money', 'navigation'), term('payments_settings_tab', 'Payments', 'navigation'),
      term('workspace', 'Money'), term('overview', 'Overview', 'view'), term('invoices', 'Invoices', 'view'), term('recurring', 'Recurring', 'view'), term('expense_lists', 'Expense Lists', 'view'), term('receipts', 'Receipts', 'view'), term('commissions', 'Commissions', 'view'),
      term('ledger', 'Ledger'), term('payments', 'Payments'), term('expenses', 'Expenses'), term('activity', 'Activity'), term('transaction', 'Transaction'), term('transactions', 'Transactions'), term('receipt', 'Receipt'),
      term('money_in', 'Money In'), term('money_out', 'Money Out'), term('balance', 'Balance'), term('revenue', 'Revenue'), term('collected', 'Collected'), term('remaining', 'Remaining'), term('cost_forecast', 'Cost Forecast'), term('forecast_profit', 'Forecast Profit'), term('profit_to_date', 'Profit To Date'), term('payment_schedule', 'Payment Schedule'),
      term('collected_payment', 'Collected Payment'), term('collected_payments', 'Collected Payments'), term('scheduled_payment', 'Scheduled Payment'), term('scheduled_payments', 'Scheduled Payments'), term('add_collected_payment', 'Add Collected Payment', 'action'), term('save_collected_payment', 'Save Collected Payment', 'action'), term('take_collected_payment', 'Take a Collected Payment', 'action'),
      term('expense', 'Expense'), term('add_expense', 'Add Expense', 'action'), term('expense_list', 'Expense List'), term('recipient', 'Recipient'), term('invoice', 'Invoice'), term('invoice_history', 'Invoice History'), term('generate_invoice', 'Generate Invoice', 'action'), term('invoice_items', 'Invoice Items'), term('invoice_total', 'Invoice Total'),
      term('recurring_agreements', 'Recurring Agreements'), term('recurring_totals', 'Recurring Totals'), term('project_expenses', 'Project Expenses'), term('projected', 'Projected'), term('tracked_actual', 'Tracked Actual'), term('variance', 'Variance'), term('current_forecast', 'Current Forecast'),
      term('commission_payment', 'Commission Payment'), term('commission_payments', 'Commission Payments'), term('commission_recipient', 'Commission Recipient'), term('commission_recipients', 'Commission Recipients'), term('upcoming', 'Upcoming'), term('accrued', 'Accrued'), term('timing', 'Timing')
    ]),
    section('receipts', 'Receipts', 'Receipt navigation and receipt-processing records.', [
      term('portal_tab', 'Receipts', 'navigation'), term('crew_portal_tab', 'Receipts', 'navigation'), term('receipt', 'Receipt'), term('receipts', 'Receipts'), term('expense_evidence', 'Expense Evidence'), term('upload_receipts', 'Upload Receipts', 'action'), term('recent_receipts', 'Recent Receipts'), term('extracted_line_items', 'Extracted Line Items'), term('review_apply', 'Review & Apply', 'action')
    ]),
    section('financials', 'Financials', 'Company financial navigation, views, and summary measures.', [
      term('portal_tab', 'Financials', 'navigation'), term('profitability_view', 'Profitability', 'view'), term('cash_flow_view', 'Cash flow', 'view'), term('project_profitability', 'Project Profitability'), term('projected_revenue', 'Projected Revenue'), term('projected_profit', 'Projected Profit'), term('customer_owed', 'Customer Owed'), term('margin', 'Margin'), term('revenue', 'Revenue'), term('expenses', 'Expenses')
    ]),
    section('payroll', 'Payroll', 'Payroll navigation, batch views, and payroll records.', [
      term('portal_tab', 'Payroll', 'navigation'), term('settings_tab', 'Payroll', 'navigation'), term('upcoming_view', 'Upcoming payroll', 'view'), term('history_view', 'Batch history', 'view'), term('payroll_batch', 'Payroll Batch'), term('payee', 'Payee'), term('gross', 'Gross'), term('deductions', 'Deductions'), term('net', 'Net'), term('paid_at', 'Paid At')
    ]),
    section('scheduling', 'Scheduling', 'Scheduling navigation, calendar views, and assignments.', [
      term('portal_tab', 'Scheduling', 'navigation'), term('project_tab', 'Schedule', 'navigation'), term('crew_portal_tab', 'Schedule', 'navigation'), term('settings_tab', 'Scheduling', 'navigation'), term('calendar_view', 'Calendar', 'view'), term('routing_view', 'Routing', 'view'), term('production_view', 'Production', 'view'), term('sales_view', 'Sales', 'view'), term('day_view', 'Day', 'view'), term('four_day_view', '4 Day', 'view'), term('week_view', 'Week', 'view'), term('month_view', 'Month', 'view'), term('appointment', 'Appointment'), term('visit', 'Visit'), term('shift', 'Shift'), term('assignment', 'Assignment')
    ]),
    section('calls', 'Calls', 'Call navigation, workflow settings, queues, and outcomes.', [
      term('portal_tab', 'Calls', 'navigation'), term('workflows_settings_tab', 'Call Workflows', 'navigation'), term('call', 'Call'), term('calls', 'Calls'), term('call_queue', 'Call Queue'), term('new_leads_queue', 'New Leads'), term('follow_ups_queue', 'Follow-ups'), term('new_customers_queue', 'New Customers'), term('answered', 'Answered', 'status'), term('left_voicemail', 'Left Voicemail', 'status'), term('no_answer', 'No Answer', 'status'), term('appointment_booked', 'Appointment Booked', 'status'), term('not_interested', 'Not Interested', 'status'), term('call_notes', 'Call Notes')
    ]),
    section('canvassing', 'Canvassing', 'Canvassing navigation, pins, and lead records.', [
      term('portal_tab', 'Canvassing', 'navigation'), term('pin', 'Pin'), term('pins', 'Pins'), term('lead', 'Lead'), term('leads', 'Leads'), term('territory', 'Territory'), term('canvasser', 'Canvasser'), term('create_lead', 'Create Lead', 'action'), term('contact_result', 'Contact Result')
    ]),
    section('customer_portal', 'Customer Portal', 'Customer portal navigation and shared content views.', [
      term('project_tab', 'Customer Portal', 'navigation'), term('overview_view', 'Overview', 'view'), term('media_view', 'Media', 'view'), term('customer_portal', 'Customer Portal'), term('update', 'Update'), term('updates', 'Updates'), term('shared_document', 'Shared Document'), term('shared_photo', 'Shared Photo')
    ]),
    section('crew', 'Crew', 'Field application home navigation and crew records.', [
      term('today_portal_tab', 'Today', 'navigation'), term('crew_member', 'Crew Member'), term('crew_members', 'Crew Members'), term('assigned_work', 'Assigned Work'), term('clock_in', 'Clock In', 'action'), term('clock_out', 'Clock Out', 'action'), term('break', 'Break')
    ]),
    section('earnings', 'Earnings', 'Field earnings navigation and payment summaries.', [
      term('crew_portal_tab', 'Earnings', 'navigation'), term('crew_project_tab', 'Earnings', 'navigation'), term('earnings', 'Earnings'), term('owed', 'Owed'), term('paid', 'Paid'), term('projected', 'Projected')
    ]),
    section('payments', 'Payments', 'Field project payment navigation.', [
      term('crew_project_tab', 'Payments', 'navigation'), term('payment', 'Payment'), term('payments', 'Payments')
    ]),
    section('change_orders', 'Change Orders', 'Field project change-order navigation and records.', [
      term('crew_project_tab', 'Change Orders', 'navigation'), term('change_order', 'Change Order'), term('change_orders', 'Change Orders')
    ]),
    section('checklists', 'Checklists', 'Field project checklist navigation and records.', [
      term('crew_project_tab', 'Checklist', 'navigation'), term('checklist', 'Checklist'), term('checklists', 'Checklists'), term('checklist_item', 'Checklist Item'), term('checklist_items', 'Checklist Items')
    ]),
    section('equipment', 'Equipment', 'Equipment and fleet navigation, unit records, and maintenance terms.', [
      term('portal_tab', 'Equipment', 'navigation'), term('settings_tab', 'Equipment', 'navigation'), term('fleet_view', 'Fleet', 'view'), term('timeline_view', 'Timeline', 'view'), term('maintenance_view', 'Maintenance', 'view'), term('utilization_view', 'Utilization', 'view'),
      term('equipment', 'Equipment'), term('equipment_unit', 'Unit'), term('equipment_units', 'Units'), term('equipment_type', 'Equipment Type'), term('equipment_types', 'Equipment Types'), term('category', 'Category'), term('categories', 'Categories'),
      term('work_order', 'Work Order'), term('work_orders', 'Work Orders'), term('service_program', 'Service Program'), term('meter', 'Meter'), term('downtime', 'Downtime'), term('operator', 'Operator'),
      term('available_status', 'Available', 'status'), term('in_use_status', 'In Use', 'status'), term('down_status', 'Down', 'status'), term('reserved_status', 'Reserved', 'status'), term('retired_status', 'Retired', 'status')
    ]),
    section('crm', 'CRM', 'CRM settings navigation, pipeline views, and lead records.', [
      term('settings_tab', 'CRM', 'navigation'), term('stages_view', 'Stages', 'view'), term('call_workflows_view', 'Call workflows', 'view'), term('projects_view', 'Projects', 'view'), term('miscellaneous_view', 'Miscellaneous', 'view'), term('lead', 'Lead'), term('leads', 'Leads'), term('opportunity', 'Opportunity'), term('pipeline', 'Pipeline'), term('source', 'Source')
    ]),
    section('leads', 'Forms and Leads', 'Lead intake settings, form views, and submissions.', [
      term('settings_tab', 'Forms and Leads', 'navigation'), term('lead_import_view', 'Lead Import', 'view'), term('contact_form_view', 'Contact Form', 'view'), term('appointment_form_view', 'Appointment Form', 'view'), term('instant_estimate_view', 'Instant Estimate', 'view'), term('form', 'Form'), term('forms', 'Forms'), term('submission', 'Submission'), term('submissions', 'Submissions')
    ]),
    section('pricebook', 'Pricebook', 'Pricebook settings navigation and catalog records.', [
      term('settings_tab', 'Pricebook', 'navigation'), term('pricebook', 'Pricebook'), term('item', 'Item'), term('items', 'Items'), term('category', 'Category'), term('manufacturer', 'Manufacturer'), term('unit', 'Unit'), term('price', 'Price'), term('formula', 'Formula')
    ]),
    section('reports', 'Reports', 'Project and settings report navigation and report records.', [
      term('project_tab', 'Reports', 'navigation'), term('settings_tab', 'Reports', 'navigation'), term('standard_view', 'Standard', 'view'), term('customer_view', 'Customer', 'view'), term('weather_view', 'Weather', 'view'), term('changes_pending_view', 'Changes Pending', 'view'), term('support_view', 'Support', 'view'), term('report', 'Report'), term('reports', 'Reports'), term('measurement', 'Measurement'), term('result', 'Result'), term('export', 'Export'), term('period', 'Period')
    ]),
    section('workforce', 'Workforce', 'Workforce settings navigation. Detailed workforce nouns remain connected to workforce configuration.', [
      term('settings_tab', 'Crews and Subcontractors', 'navigation'), term('organization_connections_view', 'Organization Connections', 'view')
    ]),
    section('settings', 'Settings', 'Settings shell navigation and administration-only areas.', [
      term('portal_tab', 'Settings', 'navigation'), term('company_tab', 'Company', 'navigation'), term('users_tab', 'Users', 'navigation'), term('people_view', 'People', 'view'), term('roles_access_view', 'Roles & access', 'view'), term('terminology_tab', 'Terminology', 'navigation'), term('configuration_tab', 'Configuration', 'navigation'), term('storage_tab', 'Storage', 'navigation'), term('sms_tab', 'SMS', 'navigation'), term('feature_flags_tab', 'Feature Flags', 'navigation')
    ]),
    section('billing', 'Billing', 'Billing settings navigation and subscription records.', [
      term('settings_tab', 'Billing', 'navigation'), term('subscription', 'Subscription'), term('plan', 'Plan'), term('billing_contact', 'Billing Contact'), term('invoice', 'Invoice'), term('payment_method', 'Payment Method')
    ]),
    section('ui', 'Interface', 'Shared interface modes that are intentionally company-configurable.', [
      term('routing_mode', 'Routing', 'view')
    ])
  ];


  CATALOG.find(group=>group.id==='financials').terms.push(term('reconcile_view','Reconcile','view'),term('payouts_view','Payouts','view'));
  CATALOG.find(group=>group.id==='scheduling').terms.push(term('gantt_view','Gantt','view'));
  CATALOG.find(group=>group.id==='contacts').terms.push(term('settings_tab','Contacts','navigation'));
  CATALOG.find(group=>group.id==='settings').terms.push(...[['feedback_tab','Feedback'],['live_chat_tab','Live Chat'],['comms_tab','Communications'],['assistant_tab','AI Agents'],['channels_tab','Channels'],['domains_tab','Domains']].map(([key,label])=>term(key,label,'navigation')));
  // Every registered surface and legacy domain noun belongs to this catalog.
  const additions = {
  "work": [
    [
      "phase",
      "Phase"
    ],
    [
      "phases",
      "Phases"
    ],
    [
      "stage",
      "Stage"
    ],
    [
      "stages",
      "Stages"
    ],
    [
      "task",
      "To-do"
    ],
    [
      "tasks",
      "To-dos"
    ],
    [
      "board",
      "Board"
    ],
    [
      "boards",
      "Boards"
    ]
  ],
  "workforce": [
    [
      "resource_group_singular",
      "Crew"
    ],
    [
      "resource_group_plural",
      "Crews"
    ],
    [
      "worker_singular",
      "Crew Member"
    ],
    [
      "worker_plural",
      "Crew Members"
    ],
    [
      "organization_connection_singular",
      "Subcontractor"
    ],
    [
      "organization_connection_plural",
      "Subcontractors"
    ],
    [
      "management_application",
      "Main App"
    ],
    [
      "field_application",
      "Crew App"
    ]
  ],
  "roles": [
    [
      "sales_appointments",
      "Sales Appointments"
    ],
    [
      "inside_sales",
      "Inside Sales"
    ]
  ],
  "event_types": [
    [
      "sales_appointment",
      "Sales Appointment"
    ],
    [
      "sales_follow_up",
      "Sales Follow-up"
    ],
    [
      "project_work",
      "Project Work"
    ],
    [
      "material_delivery",
      "Material Delivery"
    ]
  ],
  "web_editor": [
    [
      "tab",
      "Web Editor"
    ]
  ],
  "comms": [
    [
      "project_tab",
      "Communications"
    ]
  ],
  "checklists": [
    [
      "project_tab",
      "Checklists"
    ]
  ],
  "training": [
    [
      "portal_tab",
      "Training"
    ],
    [
      "studio_portal_tab",
      "Training Studio"
    ]
  ],
  "invoices": [
    [
      "portal_tab",
      "Invoices"
    ]
  ],
  "stats": [
    [
      "portal_tab",
      "Stats"
    ]
  ],
  "chat": [
    [
      "portal_tab",
      "Chat"
    ]
  ],
  "channels": [
    [
      "portal_tab",
      "Channels"
    ]
  ],
  "sales": [
    [
      "today_portal_tab",
      "Today"
    ],
    [
      "overview_tab",
      "Overview"
    ]
  ],
  "scheduling": [
    [
      "sales_portal_tab",
      "Schedule"
    ]
  ],
  "earnings": [
    [
      "sales_portal_tab",
      "Earnings"
    ]
  ],
  "assistant": [
    [
      "portal_tab",
      "Assistant"
    ]
  ],
  "feedback": [
    [
      "portal_tab",
      "Feedback"
    ]
  ],
  "crew": [
    [
      "overview_tab",
      "Overview"
    ]
  ],
  "contacts": [
    [
      "field_customer_tab",
      "Customer"
    ]
  ],
  "signatures": [
    [
      "crew_project_tab",
      "Signatures"
    ]
  ]
};
  for (const [id, rows] of Object.entries(additions)) {
    let group = CATALOG.find(entry => entry.id === id);
    if (!group) { group = section(id, id.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase()), 'Shared display labels. Record identifiers and authored content stay unchanged.', []); CATALOG.push(group); }
    for (const [key, label] of rows) if (!group.terms.some(item => item.key === key)) group.terms.push(term(key, label, key.endsWith('tab') || key === 'tab' ? 'navigation' : 'entity'));
  }

  // Preserve the labels of newly catalogued surfaces.
  for(const [id,label] of Object.entries({'comms.project_tab':'Comms','chat.portal_tab':'Communications','assistant.portal_tab':'FirstMate Assistant','sales.overview_tab':'Visit','crew.overview_tab':'Visit','checklists.crew_project_tab':'Checklists','signatures.crew_project_tab':'Work','settings.domains_tab':'Domains & Hosting'})){
    const [namespace,key]=id.split('.');const row=CATALOG.find(group=>group.id===namespace)?.terms.find(row=>row.key===key);if(row)row.label=label;
  }

  const DEFAULT_LABELS = Object.fromEntries(CATALOG.map((entry) => [entry.id, Object.fromEntries(entry.terms.map((item) => [item.key, item.label]))]));
  let current = { orgId:'', branchId:'default', mappings:{ schema_version:1, labels:DEFAULT_LABELS }, config:null };
  let loading = null;
  let loadingKey = '', loadSequence = 0;

  function clean(value){ return String(value ?? '').trim(); }
  function object(value){ return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function mergedMappings(input = {}){
    const mappings = object(input);
    const labels = object(mappings.labels);
    return {
      ...mappings,
      schema_version:Number(mappings.schema_version || 1),
      labels:Object.fromEntries(Object.entries({ ...DEFAULT_LABELS, ...labels }).map(([namespace, values]) => [namespace, { ...object(DEFAULT_LABELS[namespace]), ...object(values) }]))
    };
  }
  function splitKey(path){
    const value = clean(path);
    const dot = value.indexOf('.');
    return dot > 0 ? [value.slice(0, dot), value.slice(dot + 1)] : ['', value];
  }
  function get(path, fallback = '', options = {}){
    if (!clean(path)) return clean(fallback);
    const [namespace, key] = splitKey(path);
    const source = mergedMappings(options.mappings || options.config?.mappings || current.mappings);
    const defaultLabel = clean(DEFAULT_LABELS?.[namespace]?.[key]) || clean(fallback) || key;
    const legacy = clean(source.labels?.[namespace]?.[key]);
    return root.PlatformLanguage?.term?.(path, defaultLabel, source) || legacy || defaultLabel;
  }
  function appLabel(appOrMeta = {}, fallback = ''){
    const app = appOrMeta.app || appOrMeta;
    const key = clean(appOrMeta.terminologyKey || app?.terminologyKey);
    return key ? get(key, fallback || appOrMeta.title || appOrMeta.label || app?.title || app?.label) : clean(fallback || appOrMeta.title || appOrMeta.label || app?.title || app?.label);
  }
  function setConfig(config = {}, options = {}){
    current = {
      orgId:clean(options.orgId || config.org_id || current.orgId),
      branchId:clean(options.branchId || config.branch_id || current.branchId || 'default') || 'default',
      mappings:mergedMappings(config.mappings || options.mappings || config),
      config
    };
    root.PlatformLanguage?.setTerminology?.(current.mappings);
    if (options.silent !== true) root.dispatchEvent(new CustomEvent('fm:terminology:updated', { detail:{ orgId:current.orgId, branchId:current.branchId, mappings:current.mappings } }));
    return current;
  }
  async function load(orgId, branchId = 'default', options = {}){
    const organizationId = clean(orgId);
    const branch = clean(branchId || 'default') || 'default';
    if (!organizationId || !root.PlatformScheduling?.loadBranchConfig) return current;
    const key = `${organizationId}:${branch}`;
    if (loading && loadingKey === key && options.refresh !== true) return loading;
    const sequence = ++loadSequence;
    loadingKey = key;
    if(current.orgId !== organizationId || current.branchId !== branch) setConfig({mappings:{}},{orgId:organizationId,branchId:branch,silent:true});
    loading = root.PlatformScheduling.loadBranchConfig(organizationId, branch, { refresh:options.refresh === true })
      .then(async (config) => {
        const persisted=await root.PlatformAPI?.terminologyConfiguration?.(organizationId,branch);
        if(sequence !== loadSequence) return current;
        return setConfig({...config,mappings:persisted?.mappings || config.mappings || {}},{orgId:organizationId,branchId:branch,silent:options.silent});
      })
      .finally(() => { if(sequence === loadSequence) loading = null; });
    return loading;
  }
  function sections(mappings = current.mappings){
    const resolved = mergedMappings(mappings);
    return CATALOG.map((entry) => ({
      ...entry,
      rows:entry.terms.map((item) => ({ ...item, id:`${entry.id}.${item.key}`, namespace:entry.id, value:clean(resolved.labels?.[entry.id]?.[item.key]) || item.label }))
    }));
  }

  // PlatformScheduling owns persistence for variable_mappings. Add the shared
  // catalog defaults to that module without creating a second storage path.
  const schedulingDefaults = root.PlatformScheduling?.DEFAULT_MAPPINGS;
  if (schedulingDefaults?.labels) {
    Object.entries(DEFAULT_LABELS).forEach(([namespace, labels]) => {
      schedulingDefaults.labels[namespace] = { ...labels, ...object(schedulingDefaults.labels[namespace]) };
    });
  }

  root.PlatformTerminology = {
    CATALOG,
    DEFAULT_LABELS,
    mergedMappings,
    sections,
    get,
    appLabel,
    setConfig,
    load,
    refresh(orgId, branchId){ return load(orgId, branchId, { refresh:true }); },
    current(){ return current; }
  };
})();
