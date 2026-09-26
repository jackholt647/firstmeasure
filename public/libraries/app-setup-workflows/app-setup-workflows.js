/* Declarative setup workflows for FirstMate capability apps.
 *
 * This layer deliberately sits above FirstMateSetupWizard. The shared wizard
 * owns modal chrome, routing, responsiveness, and autosave affordances; this
 * file owns app inventory, fields, validation, persistence, and hand-offs.
 * Existing external workflows (10DLC, Money/payments, domains/websites) remain
 * independent and are only reached through adapters declared near the bottom.
 */
(function(){
  'use strict';
  if (window.FirstMateAppSetupWorkflows) return;

  const MODULE_ID = 'app_setup_workflows';
  const SCHEMA_VERSION = 1;
  const clean = (value) => String(value ?? '').trim();
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const array = (value) => Array.isArray(value) ? value : [];
  const now = () => new Date().toISOString();
  const timezone = () => { try { return Intl.DateTimeFormat(globalThis.PlatformLanguage?.formatLocale?.()).resolvedOptions().timeZone || 'America/Los_Angeles'; } catch (error) { return 'America/Los_Angeles'; } };
  const option = (value, label, description = '', icon = '') => ({ value, label, description, icon });
  const field = (id, label, type = 'text', config = {}) => ({ id, label, type, ...config });
  const step = (id, label, title, description, fields = []) => ({ id, label, title, description, fields });
  const workflow = (key, label, mode, icon, summary, steps, extra = {}) => ({ key, label, mode, icon, summary, steps, ...extra });

  const inventory = [
    workflow('platform.lead_import', 'Lead Import', 'required', 'fa-file-import', 'Choose intake sources and a routing owner before new leads begin arriving.', [
      step('sources', 'Lead sources', 'Where will leads come from?', 'Turn on only the intake paths your team is ready to monitor.', [
        field('sources', 'Lead sources', 'multi', { required:true, options:[option('website','Website forms','Contact and appointment forms embedded on your site.','fa-window-maximize'), option('email','Inbound email','Turn messages sent to a lead inbox into leads.','fa-envelope'), option('spreadsheet','Spreadsheet imports','Import an existing lead list when needed.','fa-file-csv')] })
      ]),
      step('routing', 'Routing', 'Decide who receives new leads', 'This becomes the default when a source does not provide a more specific assignment.', [
        field('routing_mode', 'Default routing', 'radio', { required:true, options:[option('unassigned','Leave unassigned','A manager assigns each lead.'), option('owner','Send to one owner','Route every new lead to the person below.'), option('round_robin','Round robin','Distribute leads across the sales team.')] }),
        field('default_owner', 'Default owner name or email', 'text', { requiredWhen:(values) => values.routing_mode === 'owner', visibleWhen:(values) => values.routing_mode === 'owner', placeholder:(globalThis.PlatformLanguage?.text("app-setup-workflows","m_3fbcf1137a92ed","alex@company.com") ?? "alex@company.com") }),
        field('notification_email', 'Lead notification email', 'email', { required:true, placeholder:(globalThis.PlatformLanguage?.text("app-setup-workflows","m_da94a138924315","leads@company.com") ?? "leads@company.com"), help:'FirstMate uses this as the administrative fallback for intake alerts.' })
      ]),
      step('launch', 'Launch', 'Confirm the intake handoff', 'FirstMate will enable the selected intake paths. You can build and embed individual forms next.', [
        field('consent_ready', 'Consent and follow-up process is ready', 'checkbox', { required:true, checkboxLabel:'We have a process for honoring opt-in, opt-out, and follow-up requests from imported leads.' })
      ])
    ], { handoff:{ tab:'company_settings', sub:'forms' }, capabilityValues:(values) => ({
      'platform.website_embed_import':array(values.sources).includes('website'),
      'lead_forms.contact_form':array(values.sources).includes('website'),
      'email.inbound_lead_import':array(values.sources).includes('email')
    }) }),

    workflow('apps.messaging', 'Messaging', 'required', 'fa-message', 'Complete SMS / 10DLC registration before sending business messages.', [], { external:true }),
    workflow('platform.money', 'Money', 'required', 'fa-dollar-sign', 'Finish the existing payment registration workflow before collecting payments.', [], { external:true }),

    workflow('apps.payroll', 'Payroll', 'required', 'fa-money-check-dollar', 'Create the first pay schedule and choose when earnings are recognized.', [
      step('schedule', 'Pay schedule', 'Create your first pay schedule', 'The setup flow creates a schedule only when the organization does not already have one.', [
        field('schedule_name', 'Schedule name', 'text', { required:true, defaultValue:'Standard payroll', placeholder:(globalThis.PlatformLanguage?.text("app-setup-workflows","m_6afefe9ae620f8","Standard payroll") ?? "Standard payroll") }),
        field('frequency', 'Frequency', 'select', { required:true, defaultValue:'weekly', options:[option('weekly','Weekly'),option('biweekly','Every two weeks'),option('semi_monthly','Twice a month'),option('monthly','Monthly')] }),
        field('weekday', 'Pay day', 'select', { requiredWhen:(values) => ['weekly','biweekly'].includes(values.frequency), visibleWhen:(values) => ['weekly','biweekly'].includes(values.frequency), defaultValue:'5', options:[option('1','Monday'),option('2','Tuesday'),option('3','Wednesday'),option('4','Thursday'),option('5','Friday'),option('6','Saturday'),option('0','Sunday')] }),
        field('anchor_date', 'A known pay date', 'date', { requiredWhen:(values) => values.frequency === 'biweekly', visibleWhen:(values) => values.frequency === 'biweekly', help:'Used to anchor the every-two-weeks cadence.' }),
        field('semi_monthly_days', 'Pay days', 'text', { requiredWhen:(values) => values.frequency === 'semi_monthly', visibleWhen:(values) => values.frequency === 'semi_monthly', defaultValue:'15, 31', placeholder:'15, 31', help:'Use 31 for the last day in shorter months.' }),
        field('monthly_day', 'Day of month', 'number', { requiredWhen:(values) => values.frequency === 'monthly', visibleWhen:(values) => values.frequency === 'monthly', defaultValue:1, min:1, max:31 }),
        field('timezone', 'Payroll timezone', 'text', { required:true, defaultValue:timezone(), placeholder:(globalThis.PlatformLanguage?.text("app-setup-workflows","m_1cf50d801bfa46","America/Los_Angeles") ?? "America/Los_Angeles") })
      ]),
      step('recognition', 'Earnings', 'Set the default earning policy', 'Individual people and earning types can override these defaults later.', [
        field('timing_basis', 'Recognize earnings', 'radio', { required:true, defaultValue:'worked', options:[option('worked','When work is performed','Use the date the labor or sale happened.'), option('completed','When the job is completed','Hold earnings until project completion.')] }),
        field('delay_periods', 'Payout delay (pay periods)', 'number', { required:true, defaultValue:0, min:0, max:26 }),
        field('clawback_cap_percent', 'Maximum clawback per check', 'number', { required:true, defaultValue:100, min:0, max:100, suffix:'%' })
      ]),
      step('confirm', 'Confirm', 'Ready to create the schedule', 'After setup, assign the company, roles, crews, or individuals to this schedule in Payroll settings.', [
        field('payroll_ready', 'Confirm payroll ownership', 'checkbox', { required:true, checkboxLabel:'A payroll administrator will review assignments and compensation rules before the first pay run.' })
      ])
    ], { handoff:{ tab:'company_settings', sub:'payroll' }, apply:applyPayroll }),

    workflow('apps.crew', 'Crew (Field App)', 'required', 'fa-helmet-safety', 'Choose the field tools crews receive and confirm at least one field user is assigned.', [
      step('access', 'Field access', 'Choose the crew workspace', 'Start with the minimum set of tools field teams need on day one.', [
        field('crew_scope', 'Project visibility', 'radio', { required:true, defaultValue:'assigned', options:[option('assigned','Assigned projects only','Recommended for most field users.'),option('production','All production projects','Useful for supervisors and dispatchers.')] }),
        field('crew_tools', 'Field tools', 'multi', { required:true, defaultValue:['time_clock','receipts'], options:[option('time_clock','Time clock'),option('receipts','Receipt uploads'),option('change_orders','Change orders'),option('payments','Take field payments')] })
      ]),
      step('rollout', 'People', 'Prepare the crew rollout', 'Permissions are assigned to people in Company Settings so access stays explicit.', [
        field('rollout_mode', 'Rollout', 'radio', { required:true, defaultValue:'existing', options:[option('existing','Use existing people','Assign crew access to people already in FirstMate.'),option('invite','Invite people next','Continue to Users after setup.')] }),
        field('rollout_owner', 'Rollout owner email', 'email', { required:true, placeholder:(globalThis.PlatformLanguage?.text("app-setup-workflows","m_26a0908ea5f9f5","operations@company.com") ?? "operations@company.com") }),
        field('field_users_ready', 'Field users are ready', 'checkbox', { required:true, checkboxLabel:'At least one person is invited or already exists and can be assigned crew permissions.' })
      ])
    ], { handoff:{ tab:'company_settings', sub:'users', settingsView:'people' }, capabilityValues:(values) => ({
      'crew.time_clock':array(values.crew_tools).includes('time_clock'), 'crew.receipts':array(values.crew_tools).includes('receipts'), 'crew.change_orders':array(values.crew_tools).includes('change_orders'), 'crew.field_payments':array(values.crew_tools).includes('payments')
    }) }),

    workflow('apps.sales', 'Sales (Field App)', 'required', 'fa-handshake', 'Choose the sales workspace and confirm the people who will use it.', [
      step('workspace', 'Workspace', 'Shape the sales workspace', 'Pick the everyday information salespeople should see in the field.', [
        field('sales_tools', 'Sales tools', 'multi', { required:true, defaultValue:['schedule','followups','documents'], options:[option('schedule','Appointments'),option('followups','Follow-ups'),option('documents','Proposal and document status'),option('earnings','Personal earnings'),option('team_stats','Team performance')] }),
        field('customer_scope', 'Customer visibility', 'radio', { required:true, defaultValue:'assigned', options:[option('assigned','Assigned customers only'),option('team','Sales team customers')] })
      ]),
      step('people', 'People', 'Assign the sales team', 'User roles and permissions remain in Company Settings, where administrators can audit them.', [
        field('sales_manager', 'Sales manager email', 'email', { required:true, placeholder:(globalThis.PlatformLanguage?.text("app-setup-workflows","m_575d1e6a04932e","manager@company.com") ?? "manager@company.com") }),
        field('sales_users_ready', 'Sales users are ready', 'checkbox', { required:true, checkboxLabel:'At least one salesperson is invited or already exists and can be assigned sales permissions.' })
      ])
    ], { handoff:{ tab:'company_settings', sub:'users', settingsView:'people' } }),

    workflow('apps.feedback', 'Feedback System', 'required', 'fa-star', 'Choose delivery, tailor every message, and shape the private feedback journey.', [
      { ...step('delivery', 'Delivery', 'Choose when and where requests are delivered', 'Start with timing and the channels each customer can receive.', [
        field('feedback_trigger', 'Delivery timing', 'text', { required:true, defaultValue:'workflow' }),
        field('feedback_channels', 'Delivery channels', 'multi', { required:true, defaultValue:['sms','email'], options:[option('sms','Text message'),option('email','Email'),option('portal','Customer portal')] })
      ]), render:renderFeedbackDeliveryStep },
      { ...step('messages', 'Messages', 'Tailor each delivery message', 'Preview Text, Email, and Portal copy even when a channel is turned off.', [
        field('sms_text', 'Text message', 'textarea', { required:true, defaultValue:"Hi {{customer_first_name}}, thanks for choosing {{company_name}}! We'd love to hear how everything went: {{link}}" }),
        field('email_subject', 'Email subject', 'text', { required:true, defaultValue:'How did we do, {{customer_first_name}}?' }),
        field('email_body', 'Email body', 'textarea', { required:true, defaultValue:'Hi {{customer_first_name}},\n\nThank you for choosing {{company_name}} for {{project_title}}. We\'d really appreciate a moment of your time to tell us how everything went.\n\nShare your experience here: {{link}}\n\nThank you,\nThe {{company_name}} team' }),
        field('portal_title', 'Portal headline', 'text', { required:true, defaultValue:'How did we do?' }),
        field('portal_body', 'Portal message', 'textarea', { required:true, defaultValue:'Tell us how everything went — it only takes a few seconds.' }),
        field('portal_cta', 'Portal button', 'text', { required:true, defaultValue:'Leave feedback' })
      ]), render:renderFeedbackMessagesStep },
      step('workflow', 'Feedback flow', 'Design the customer feedback journey', 'Set the private question and decide when to offer public review destinations.', [
        field('survey_question', 'Initial question', 'text', { required:true, defaultValue:'How did we do?', placeholder:(globalThis.PlatformLanguage?.text("app-setup-workflows","m_9a80ba962207b2","How did we do?") ?? "How did we do?"), wide:true }),
        field('comment_prompt', 'Comment prompt', 'text', { required:true, defaultValue:"Anything you'd like us to know?" }),
        field('low_comment_prompt', 'Low-rating prompt', 'text', { required:true, defaultValue:'What could we have done better?' }),
        field('review_mode', 'Public review invitation', 'radio', { required:true, defaultValue:'threshold', options:[option('threshold','At a rating'),option('always','Invite everyone'),option('never','Keep all feedback private')] }),
        field('review_threshold', 'Minimum rating', 'select', { requiredWhen:(values) => values.review_mode === 'threshold', visibleWhen:(values) => values.review_mode === 'threshold', defaultValue:'4', options:[option('3','3 stars'),option('4','4 stars'),option('5','5 stars')] }),
        field('review_label', 'Review destination label', 'text', { visibleWhen:(values) => values.review_mode !== 'never', defaultValue:'Google', placeholder:(globalThis.PlatformLanguage?.text("app-setup-workflows","m_de640c90c8d483","Google") ?? "Google") }),
        field('review_url', 'Review destination URL', 'url', { requiredWhen:(values) => values.review_mode !== 'never', visibleWhen:(values) => values.review_mode !== 'never', placeholder:'https://g.page/r/…/review' })
      ])
    ], { handoff:{ tab:'company_settings', sub:'feedback' }, prepare:prepareFeedback, apply:applyFeedback }),

    workflow('calls.app', 'Calls', 'required', 'fa-phone', 'Verify the call provider before the calling workspace is used.', [
      step('provider', 'Provider check', 'Check calling infrastructure', 'Calls require a configured LiveKit or TURN provider. This is a deployment setting, not an organization secret.', [
        field('provider_summary', 'Provider status', 'info', { tone:(values) => values.provider_ready ? 'success' : 'warning', body:(values) => values.provider_ready ? `The ${clean(values.provider_name) || 'call'} provider is ready.` : 'The call provider is not ready. A platform operator must configure it before setup can finish.' }),
        field('provider_acknowledged', 'Provider confirmed', 'checkbox', { required:true, validate:(value, values) => values.provider_ready ? '' : 'The call provider must report ready before Calls can be activated.', checkboxLabel:'I understand calling depends on the platform provider status shown above.' })
      ]),
      step('defaults', 'Call defaults', 'Choose recording defaults', 'These choices enable the matching call features; individual calls still show their own controls.', [
        field('recording_default', 'Recording', 'radio', { required:true, defaultValue:'off', options:[option('off','Off by default'),option('audio','Audio recording available'),option('video','Audio and video recording available')] }),
        field('recording_consent', 'Recording consent', 'checkbox', { requiredWhen:(values) => values.recording_default !== 'off', visibleWhen:(values) => values.recording_default !== 'off', checkboxLabel:'Our team will obtain any consent required before recording.' })
      ])
    ], { prepare:prepareCalls, capabilityValues:(values) => ({ 'calls.rooms':true, 'calls.recording':values.recording_default !== 'off', 'calls.record_video':values.recording_default === 'video' }), handoff:{ tab:'calls' } }),

    workflow('platform.scheduling', 'Scheduling', 'optional', 'fa-calendar-days', 'Set a work week and choose which scheduling tools to introduce first.', [
      step('calendar', 'Work week', 'Set scheduling defaults', 'These preferences seed the organization setup record and can be refined in Scheduling settings.', [
        field('work_days', 'Working days', 'multi', { required:true, defaultValue:['mon','tue','wed','thu','fri'], options:[option('mon','Monday'),option('tue','Tuesday'),option('wed','Wednesday'),option('thu','Thursday'),option('fri','Friday'),option('sat','Saturday'),option('sun','Sunday')] }),
        field('day_start', 'Day starts', 'time', { required:true, defaultValue:'08:00' }), field('day_end', 'Day ends', 'time', { required:true, defaultValue:'17:00' })
      ]),
      step('tools', 'Tools', 'Choose scheduling tools', 'Enable only the scheduling surfaces your team is ready to use.', [
        field('scheduling_tools', 'Scheduling tools', 'multi', { required:true, defaultValue:['appointments'], options:[option('appointments','Customer appointments'),option('dispatch','Crew dispatch'),option('routing','Route optimization'),option('gantt','Project Gantt view'),option('travel','Travel time')] })
      ])
    ], { handoff:{ tab:'company_settings', sub:'scheduling' }, capabilityValues:(values) => ({ 'scheduling.appointment_slots':array(values.scheduling_tools).includes('appointments'), 'scheduling.crew_dispatch':array(values.scheduling_tools).includes('dispatch'), 'scheduling.routing':array(values.scheduling_tools).includes('routing'), 'scheduling.gantt':array(values.scheduling_tools).includes('gantt'), 'scheduling.travel_time':array(values.scheduling_tools).includes('travel') }) }),

    workflow('platform.contacts', 'My Contacts', 'optional', 'fa-address-book', 'Choose a default contact view and decide whether to import a list.', [
      step('defaults', 'Contact defaults', 'Personalize the contact workspace', 'These choices do not block use of My Contacts.', [
        field('contact_sort', 'Default sort', 'select', { required:true, defaultValue:'recent', options:[option('recent','Recently active'),option('name','Name'),option('company','Company')] }),
        field('contact_import', 'Bring in existing contacts', 'radio', { required:true, defaultValue:'later', options:[option('later','Not now'),option('csv','Import a CSV next'),option('crm','Review CRM contacts first')] })
      ])
    ], { handoff:{ tab:'contacts' } }),

    workflow('apps.crm', 'CRM', 'optional', 'fa-filter', 'Choose the pipeline focus, intake ownership, and automation starting point.', [
      step('pipeline', 'Pipeline', 'Define the first CRM pipeline', 'Use a simple starting point; stages remain editable in CRM settings.', [
        field('pipeline_name', 'Pipeline name', 'text', { required:true, defaultValue:'Sales pipeline' }),
        field('pipeline_focus', 'Pipeline focus', 'radio', { required:true, defaultValue:'residential', options:[option('residential','Residential sales'),option('commercial','Commercial sales'),option('mixed','Mixed work')] })
      ]),
      step('ownership', 'Ownership', 'Choose intake ownership', 'This helps document the intended CRM rollout without forcing an automation.', [
        field('crm_owner', 'CRM owner email', 'email', { required:true }),
        field('crm_automation', 'Automation starting point', 'select', { required:true, defaultValue:'none', options:[option('none','No automation yet'),option('followup','Create follow-up reminders'),option('routing','Route new leads')] })
      ])
    ], { handoff:{ tab:'company_settings', sub:'configuration', settingsView:'projects' }, capabilityValues:(values) => ({ 'crm.pipeline':true, 'crm.automations':values.crm_automation !== 'none' }) }),

    workflow('platform.documents', 'Documents', 'optional', 'fa-file-signature', 'Choose the document types and authoring tools your team will start with.', [
      step('types', 'Document types', 'Choose your starting library', 'The full library remains available; this records the types to prioritize during rollout.', [
        field('document_types', 'Priority document types', 'multi', { required:true, defaultValue:['proposal','contract','change_order'], options:[option('proposal','Proposals'),option('contract','Contracts'),option('invoice','Invoices'),option('change_order','Change orders'),option('work_order','Work orders'),option('marketing','Marketing pieces')] })
      ]),
      step('authoring', 'Authoring', 'Choose who will build templates', 'Publishing and advanced authoring can be introduced independently.', [
        field('template_authoring', 'Template authoring', 'radio', { required:true, defaultValue:'admins', options:[option('admins','Administrators only'),option('designers','Designated document designers'),option('later','Use published templates only')] }),
        field('esign_enabled', 'E-signatures', 'checkbox', { checkboxLabel:'Enable document e-signatures.', defaultValue:true })
      ])
    ], { handoff:{ tab:'documents_studio' }, capabilityValues:(values) => ({ 'documents.templates_studio':values.template_authoring !== 'later', 'documents.esign':values.esign_enabled === true }) }),

    workflow('platform.pricebook', 'Pricebook', 'optional', 'fa-book', 'Set pricing conventions before adding products and services.', [
      step('pricing', 'Pricing defaults', 'Set pricebook conventions', 'These defaults guide the first catalog build and can be changed later.', [
        field('pricebook_currency', 'Currency', 'select', { required:true, defaultValue:'USD', options:[option('USD','USD — US Dollar'),option('CAD','CAD — Canadian Dollar')] }),
        field('tax_mode', 'Tax entry', 'radio', { required:true, defaultValue:'exclusive', options:[option('exclusive','Prices exclude tax'),option('inclusive','Prices include tax'),option('none','Do not calculate tax yet')] }),
        field('catalog_source', 'Starting point', 'radio', { required:true, defaultValue:'blank', options:[option('blank','Start from a blank catalog'),option('import','Import products next'),option('manual','Add a few items manually')] })
      ])
    ], { handoff:{ tab:'company_settings', sub:'pricebook' } }),

    workflow('platform.materials', 'Materials', 'optional', 'fa-clipboard-list', 'Choose ordering and delivery tracking defaults.', [
      step('workflow', 'Materials workflow', 'Choose how materials move through projects', 'Pricebook stays the source for material definitions and costs.', [
        field('materials_tools', 'Materials tools', 'multi', { required:true, defaultValue:['lists','delivery'], options:[option('lists','Project material lists'),option('ordering','Purchase ordering'),option('delivery','Delivery tracking'),option('amendments','Material amendments')] }),
        field('materials_owner', 'Materials owner email', 'email', { required:true })
      ])
    ], { handoff:{ tab:'viewer' }, capabilityValues:(values) => ({ 'materials.ordering':array(values.materials_tools).includes('ordering') }) }),

    workflow('platform.customer_portal', 'Customer Portal', 'optional', 'fa-door-open', 'Choose the content customers can see when a portal is shared.', [
      step('content', 'Portal content', 'Choose the default customer experience', 'Access is still granted per project; setup never publishes a project by itself.', [
        field('portal_content', 'Default content', 'multi', { required:true, defaultValue:['status','documents'], options:[option('status','Project status'),option('documents','Shared documents'),option('photos','Shared photos and video'),option('payments','Payments'),option('feedback','Feedback request')] }),
        field('portal_contact', 'Portal support email', 'email', { required:true })
      ])
    ], { handoff:{ tab:'viewer' }, capabilityValues:(values) => ({ 'platform.customer_portal_media':array(values.portal_content).includes('photos'), 'customer_portal.payments':array(values.portal_content).includes('payments') }) }),

    workflow('apps.checklists', 'Checklists', 'optional', 'fa-list-check', 'Choose the first checklist use case and supervision model.', [
      step('use', 'First use case', 'Start with one repeatable checklist', 'A focused rollout makes completion and supervision expectations clear.', [
        field('checklist_use', 'First checklist', 'select', { required:true, defaultValue:'job_start', options:[option('job_start','Job start'),option('daily','Daily field check'),option('quality','Quality inspection'),option('closeout','Project closeout'),option('safety','Safety review')] }),
        field('checklist_owner', 'Checklist owner email', 'email', { required:true }),
        field('supervision', 'Require supervisor review', 'checkbox', { defaultValue:true, checkboxLabel:'Require supervisor review for the first checklist template.' })
      ])
    ], { handoff:{ tab:'viewer' }, capabilityValues:(values) => ({ 'checklists.templates':true, 'checklists.supervision':values.supervision === true }) }),

    workflow('apps.training', 'Training', 'optional', 'fa-graduation-cap', 'Choose the first course audience and assignment policy.', [
      step('program', 'Training program', 'Plan the first training rollout', 'No course is published automatically; the Training Studio opens after setup.', [
        field('training_topic', 'First course topic', 'text', { required:true, placeholder:(globalThis.PlatformLanguage?.text("app-setup-workflows","m_75c4f4be3881c5","Field safety basics") ?? "Field safety basics") }),
        field('training_audience', 'Audience', 'select', { required:true, defaultValue:'crew', options:[option('crew','Crew'),option('sales','Sales'),option('managers','Managers'),option('everyone','Everyone')] }),
        field('quiz_required', 'Knowledge check', 'checkbox', { defaultValue:true, checkboxLabel:'Include a quiz before completion.' })
      ])
    ], { handoff:{ tab:'training_studio' }, capabilityValues:(values) => ({ 'training.studio':true, 'training.assignments':true, 'training.quizzes':values.quiz_required === true }) }),

    workflow('apps.equipment', 'Equipment', 'optional', 'fa-truck-pickup', 'Choose what to track for the initial fleet rollout.', [
      step('fleet', 'Fleet', 'Choose the initial equipment scope', 'Start with the assets that affect scheduling or field operations most.', [
        field('equipment_scope', 'Initial fleet', 'radio', { required:true, defaultValue:'vehicles', options:[option('vehicles','Vehicles and trailers'),option('heavy','Heavy equipment'),option('tools','Tools and small equipment'),option('all','All equipment')] }),
        field('equipment_tools', 'Tracking tools', 'multi', { required:true, defaultValue:['scheduling'], options:[option('scheduling','Scheduling'),option('maintenance','Maintenance'),option('meters','Hours and mileage'),option('operators','Operator requirements'),option('costing','Project costing'),option('custody','Check-out / check-in')] })
      ])
    ], { handoff:{ tab:'equipment' }, capabilityValues:(values) => ({ 'equipment.scheduling':array(values.equipment_tools).includes('scheduling'), 'equipment.maintenance':array(values.equipment_tools).includes('maintenance'), 'equipment.meters':array(values.equipment_tools).includes('meters'), 'equipment.operators':array(values.equipment_tools).includes('operators'), 'equipment.costing':array(values.equipment_tools).includes('costing'), 'equipment.custody':array(values.equipment_tools).includes('custody') }) }),

    workflow('apps.web_editor', 'Web Editor', 'optional', 'fa-globe', 'Choose the first design surface without changing website, domain, or hosting setup.', [
      step('surface', 'Design surface', 'What do you want to design first?', 'This lightweight preference flow does not alter the separately managed website or domain workflows.', [
        field('web_surface', 'Starting surface', 'radio', { required:true, defaultValue:'public', options:[option('public','Public website'),option('portal','Customer portal pages'),option('explore','Explore the editor first')] }),
        field('web_owner', 'Design owner email', 'email', { required:true })
      ])
    ], { handoff:{ tab:'web_editor' } }),

    // Registered legacy surfaces that are not currently discoverable capability
    // apps. Keeping them in the same inventory makes future catalog promotion a
    // declaration-only change.
    workflow('apps.comms', 'Project Communications', 'optional', 'fa-tower-broadcast', 'Choose communication channels and a reply owner.', [
      step('channels', 'Channels', 'Choose project communication defaults', 'These preferences guide the rollout without sending any messages.', [
        field('comms_channels', 'Channels', 'multi', { required:true, defaultValue:['email'], options:[option('email','Email'),option('sms','SMS'),option('chat','Live chat')] }),
        field('comms_owner', 'Reply owner email', 'email', { required:true })
      ])
    ], { handoff:{ tab:'company_settings', sub:'comms' } }),

    workflow('settings.live_chat', 'Live Chat', 'required', 'fa-comments', 'Choose widget availability and the team that receives new conversations.', [
      step('widget', 'Widget', 'Set the customer-facing widget', 'The embed snippet remains in Live Chat settings after setup.', [
        field('chat_label', 'Widget heading', 'text', { required:true, defaultValue:'Chat with us' }),
        field('chat_availability', 'Availability', 'radio', { required:true, defaultValue:'business_hours', options:[option('business_hours','Business hours'),option('always','Always available'),option('offline','Start offline')] })
      ]),
      step('routing', 'Routing', 'Choose who receives conversations', 'FirstMate keeps the existing detailed Live Chat settings available for later changes.', [
        field('chat_route', 'Route new chats to', 'select', { required:true, defaultValue:'team', options:[option('team','Live chat team'),option('owner','One owner'),option('round_robin','Round robin')] }),
        field('chat_owner', 'Chat owner email', 'email', { requiredWhen:(values) => values.chat_route === 'owner', visibleWhen:(values) => values.chat_route === 'owner' }),
        field('chat_ready', 'Activate chat', 'checkbox', { required:true, checkboxLabel:'The response team is ready to receive live chat notifications.' })
      ])
    ], { handoff:{ tab:'company_settings', sub:'live_chat' }, apply:applyLiveChat }),

    workflow('platform.ai_assistant', 'AI Assistant', 'optional', 'fa-wand-magic-sparkles', 'Set a default tone and the areas where assistants may help.', [
      step('behavior', 'Assistant defaults', 'Choose organization-wide assistant defaults', 'Individual agents can still have more specific instructions.', [
        field('assistant_tone', 'Default tone', 'select', { required:true, defaultValue:'professional', options:[option('professional','Professional'),option('friendly','Friendly'),option('concise','Concise'),option('technical','Technical')] }),
        field('assistant_areas', 'Initial areas', 'multi', { required:true, defaultValue:['documents'], options:[option('documents','Documents'),option('stats','Stats'),option('communications','Communications'),option('live_chat','Live chat')] })
      ])
    ], { handoff:{ tab:'company_settings', sub:'assistant' } }),

    // Apps that are useful immediately and intentionally have no setup modal.
    ...[
      ['apps.projects','Projects','fa-folder-open'], ['apps.stats','Stats','fa-chart-column'], ['platform.project_photos','Project Photos','fa-images'],
      ['platform.project_docs','Project Docs','fa-file-lines'], ['canvassing.app','Canvassing','fa-map-location-dot'], ['apps.channels','Channels','fa-comments'],
      ['apps.referrals','Referrals','fa-gift'], ['apps.firstmeasure','FirstMeasure','fa-ruler-combined']
    ].map(([key,label,icon]) => workflow(key,label,'none',icon,'No organization setup is required.',[]))
  ];

  const definitions = new Map(inventory.map((definition) => [definition.key, definition]));
  const records = new Map();
  const externalStatuses = new Map();
  const routeOpenPromises = new Map();
  let store = { schema_version:SCHEMA_VERSION, workflows:{} };
  let loadPromise = null;
  let loadedContextKey = '';
  let writePromise = Promise.resolve();
  let cssReady = false;

  function appContext(){
    const app = object(window.__APP);
    return {
      orgId:clean(app.userOrgId || app.orgId),
      branchId:clean(app.userBranchId || app.branchId || app.defaultBranchId) || 'default'
    };
  }

  function contextKey(context = appContext()){ return `${context.orgId}:${context.branchId}`; }
  function localKey(context = appContext()){ return `fm_app_setup_workflows:${contextKey(context)}`; }
  function normalizeStore(value){
    const data = object(value);
    return { ...data, schema_version:SCHEMA_VERSION, workflows:{ ...object(data.workflows) } };
  }
  function syncRecords(){
    records.clear();
    Object.entries(object(store.workflows)).forEach(([key, value]) => records.set(key, object(value)));
    window.dispatchEvent(new CustomEvent('fm:app-setup:updated', { detail:{ workflows:object(store.workflows) } }));
  }
  async function load(){
    const requestedContext = appContext();
    const requestedKey = contextKey(requestedContext);
    if (loadPromise && loadedContextKey === requestedKey) return loadPromise;
    loadedContextKey = requestedKey;
    loadPromise = (async () => {
      const context = requestedContext;
      let data = null;
      if (context.orgId && window.PlatformAPI?.branchModules?.get) {
        try {
          const module = await window.PlatformAPI.branchModules.get(context.orgId, context.branchId, MODULE_ID);
          data = object(module?.data);
        } catch (error) {}
      }
      if (!Object.keys(object(data)).length) {
        try { data = JSON.parse(localStorage.getItem(localKey(context)) || 'null'); } catch (error) { data = null; }
      }
      if (loadedContextKey !== requestedKey) return store;
      store = normalizeStore(data);
      syncRecords();
      refreshExternalStatuses().catch(() => null);
      return store;
    })();
    return loadPromise;
  }
  function status(key){
    const normalizedKey = clean(key);
    return clean(externalStatuses.get(normalizedKey) || records.get(normalizedKey)?.status) || 'not_started';
  }
  function persist(){
    const snapshot = JSON.parse(JSON.stringify(store));
    const context = appContext();
    const storageKey = localKey(context);
    writePromise = writePromise.catch(() => null).then(async () => {
      try { localStorage.setItem(storageKey, JSON.stringify(snapshot)); } catch (error) {}
      if (context.orgId && window.PlatformAPI?.branchModules?.save) {
        await window.PlatformAPI.branchModules.save(context.orgId, context.branchId, MODULE_ID, snapshot, { kind:'app_setup_workflows', schema_version:SCHEMA_VERSION });
      }
      return snapshot;
    });
    return writePromise;
  }
  async function saveRecord(key, state, recordStatus = 'in_progress'){
    const previous = object(store.workflows[key]);
    const next = {
      ...previous,
      status:recordStatus,
      values:{ ...object(state.values) },
      visited_steps:array(state.visitedSteps),
      active_step:clean(state.activeStep),
      started_at:previous.started_at || now(),
      updated_at:now(),
      ...(recordStatus === 'complete' ? { completed_at:now() } : {})
    };
    store.workflows[key] = next;
    records.set(key, next);
    window.dispatchEvent(new CustomEvent('fm:app-setup:updated', { detail:{ key, record:next } }));
    await persist();
    return next;
  }

  function ensureCss(){
    if (cssReady) return;
    cssReady = true;
    const style = document.createElement('style');
    style.id = 'fm-app-setup-workflows-css';
    style.textContent = `
      .fm-app-setup-head{max-width:760px;margin-bottom:20px}.fm-app-setup-head h2{margin:0;color:#101828;font-size:22px;line-height:1.25}.fm-app-setup-head p{margin:7px 0 0;color:#667085;font-size:12px;font-weight:700;line-height:1.6}
      .fm-app-setup-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.fm-app-setup-field{display:grid;align-content:start;gap:6px;min-width:0}.fm-app-setup-field.wide,.fm-app-setup-radio,.fm-app-setup-multi,.fm-app-setup-check,.fm-app-setup-info{grid-column:1/-1}
      .fm-app-setup-field>label,.fm-app-setup-label{color:#344054;font-size:11px;font-weight:950}.fm-app-setup-required{margin-left:3px;color:var(--primary-readable,var(--primary,#d93025))}.fm-app-setup-help{color:#667085;font-size:9px;font-weight:700;line-height:1.45}
      .fm-app-setup-control{display:flex;align-items:center;min-width:0}.fm-app-setup-control input,.fm-app-setup-control select,.fm-app-setup-control textarea{width:100%;min-height:42px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;padding:9px 11px;color:#344054;font:750 12px/1.4 inherit;outline:0}.fm-app-setup-control textarea{min-height:100px;resize:vertical}.fm-app-setup-control input:focus,.fm-app-setup-control select:focus,.fm-app-setup-control textarea:focus{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.09)}.fm-app-setup-suffix{align-self:stretch;display:grid;place-items:center;margin-left:-1px;border:1px solid #d0d5dd;border-radius:0 9px 9px 0;background:#f9fafb;padding:0 10px;color:#667085;font-size:11px;font-weight:900}.fm-app-setup-control.has-suffix input{border-radius:9px 0 0 9px}
      .fm-app-setup-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:9px}.fm-app-setup-option{position:relative;display:grid;grid-template-columns:auto minmax(0,1fr);align-items:start;gap:9px;min-height:64px;border:1px solid #e4e7ec;border-radius:11px;background:#fff;padding:11px;cursor:pointer}.fm-app-setup-option:has(input:checked){border-color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.035);box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),.06)}.fm-app-setup-option input{margin:3px 0 0;accent-color:var(--primary-readable,var(--primary,#d93025))}.fm-app-setup-option strong{display:block;color:#344054;font-size:11px}.fm-app-setup-option small{display:block;margin-top:3px;color:#667085;font-size:9px;font-weight:700;line-height:1.4}
      .fm-app-setup-check{display:flex;align-items:flex-start;gap:9px;border:1px solid #e4e7ec;border-radius:11px;background:#f9fafb;padding:12px;color:#475467;font-size:11px;font-weight:800;line-height:1.5;cursor:pointer}.fm-app-setup-check input{margin-top:2px;accent-color:var(--primary-readable,var(--primary,#d93025))}
      .fm-app-setup-info{display:flex;align-items:flex-start;gap:10px;border:1px solid #b2ddff;border-radius:11px;background:#eff8ff;padding:13px;color:#175cd3;font-size:11px;font-weight:750;line-height:1.5}.fm-app-setup-info.warning{border-color:#fec84b;background:#fffaeb;color:#93370d}.fm-app-setup-info.success{border-color:#abefc6;background:#ecfdf3;color:#067647}
      .fm-app-setup-review{display:grid;gap:10px}.fm-app-setup-review-row{display:grid;grid-template-columns:minmax(150px,.45fr) minmax(0,1fr);gap:16px;border-bottom:1px solid #f2f4f7;padding:10px 2px}.fm-app-setup-review-row span{color:#667085;font-size:10px;font-weight:850}.fm-app-setup-review-row strong{color:#344054;font-size:11px;text-align:right;overflow-wrap:anywhere}
      .fm-feedback-setup{display:grid;gap:14px}.fm-feedback-card{border:1px solid #e4e7ec;border-radius:14px;background:#fff;padding:17px;box-shadow:0 1px 3px rgba(16,24,40,.04)}.fm-feedback-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.fm-feedback-card-head strong{display:flex;align-items:center;gap:8px;color:#101828;font-size:13px}.fm-feedback-card-head strong i{color:var(--primary-readable,var(--primary,#d93025))}.fm-feedback-card p{margin:6px 0 0;color:#667085;font-size:10.5px;font-weight:700;line-height:1.5}
      .fm-feedback-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:13px}.fm-feedback-choice{appearance:none;display:flex;align-items:flex-start;gap:9px;border:1.5px solid #e4e7ec;border-radius:11px;background:#fff;padding:11px;text-align:left;color:#667085;cursor:pointer}.fm-feedback-choice.on{border-color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.045);box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),.06)}.fm-feedback-choice>i{width:18px;margin-top:1px;text-align:center}.fm-feedback-choice.on>i{color:var(--primary-readable,var(--primary,#d93025))}.fm-feedback-choice b{display:block;color:#101828;font-size:10.5px}.fm-feedback-choice span span{display:block;margin-top:3px;font-size:9px;line-height:1.4;font-weight:700}
      .fm-feedback-scope-note{display:flex;gap:9px;margin-top:11px;border:1px dashed #b2ccff;border-radius:10px;background:#f5f8ff;padding:10px;color:#344054;font-size:9.5px;font-weight:750;line-height:1.5}.fm-feedback-scope-note i{margin-top:2px;color:#4e5ba6}.fm-feedback-scope-note strong{color:#3538cd}
      .fm-feedback-message-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(230px,310px);gap:15px;align-items:start}.fm-feedback-tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;border-radius:10px;background:#f2f4f7;padding:3px;margin-bottom:13px}.fm-feedback-tabs button{appearance:none;border:0;border-radius:8px;background:transparent;padding:9px;color:#667085;font:850 10.5px/1 inherit;cursor:pointer}.fm-feedback-tabs button.on{background:#fff;color:#101828;box-shadow:0 1px 3px rgba(16,24,40,.12)}.fm-feedback-editor.off{opacity:.55}.fm-feedback-state{font-size:8.5px;font-weight:950;text-transform:uppercase;color:#067647}.fm-feedback-editor.off .fm-feedback-state{color:#667085}.fm-feedback-input{display:grid;gap:6px;margin-top:11px}.fm-feedback-input label{color:#667085;font-size:9px;font-weight:950;text-transform:uppercase;letter-spacing:.05em}.fm-feedback-input input,.fm-feedback-input textarea{width:100%;border:1px solid #d0d5dd;border-radius:9px;background:#fff;padding:9px 10px;color:#344054;font:700 11px/1.45 inherit;outline:0;resize:vertical}.fm-feedback-editor.off input,.fm-feedback-editor.off textarea{background:#f5f6f8;pointer-events:none}
      .fm-feedback-preview{border:7px solid #17212b;border-radius:25px;background:#f4f6f8;min-height:350px;overflow:hidden;box-shadow:0 14px 30px rgba(16,24,40,.15)}.fm-feedback-notch{width:44%;height:15px;margin:0 auto;border-radius:0 0 10px 10px;background:#17212b}.fm-feedback-screen{padding:15px 11px;color:#344054;font-size:10px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}.fm-feedback-bubble{max-width:90%;border-radius:14px 14px 14px 4px;background:#e7eaee;padding:10px 11px}.fm-feedback-email{border:1px solid #e4e7ec;border-radius:10px;background:#fff;overflow:hidden}.fm-feedback-email b,.fm-feedback-email span{display:block;padding:9px 10px}.fm-feedback-email b{border-bottom:1px solid #eef1f4;color:#101828}.fm-feedback-email span{white-space:pre-wrap}.fm-feedback-portal{border:1px solid #e4e7ec;border-radius:11px;background:#fff;padding:13px}.fm-feedback-portal .stars{color:#f6b83c;letter-spacing:1px}.fm-feedback-portal h4{margin:7px 0 3px;color:#101828;font-size:12px}.fm-feedback-portal p{margin:0}.fm-feedback-portal button{margin-top:10px;border:0;border-radius:8px;background:var(--primary-readable,var(--primary,#d93025));padding:8px 10px;color:#fff;font:850 9px/1 inherit}
      .fm-wizard-backdrop[data-fm-wizard^="app-setup-"]{align-items:center;padding:24px}.fm-wizard-backdrop[data-fm-wizard^="app-setup-"] .fm-wizard{height:auto;min-height:min(50dvh,calc(100dvh - 48px));max-height:min(780px,calc(100dvh - 48px))}
      @media(max-width:860px){.fm-wizard-backdrop[data-fm-wizard^="app-setup-"]{align-items:stretch;padding:0}.fm-wizard-backdrop[data-fm-wizard^="app-setup-"] .fm-wizard{height:100dvh;min-width:0;min-height:0;max-height:none;grid-template-columns:minmax(0,1fr)}.fm-wizard-backdrop[data-fm-wizard^="app-setup-"] .fm-wizard-head,.fm-wizard-backdrop[data-fm-wizard^="app-setup-"] .fm-wizard-body,.fm-wizard-backdrop[data-fm-wizard^="app-setup-"] .fm-wizard-foot{min-width:0}.fm-wizard-backdrop[data-fm-wizard^="app-setup-"] .fm-wizard-body{width:100%;grid-template-columns:minmax(0,1fr);overflow:hidden}.fm-wizard-backdrop[data-fm-wizard^="app-setup-"] .fm-wizard-rail{width:100%;min-width:0;max-width:100%;overflow:hidden}.fm-wizard-backdrop[data-fm-wizard^="app-setup-"] .fm-wizard-steps{width:100%;min-width:0;max-width:100%}.fm-wizard-backdrop[data-fm-wizard^="app-setup-"] .fm-wizard-main{width:100%;min-width:0}}
      @media(max-width:720px){.fm-app-setup-fields{grid-template-columns:1fr}.fm-app-setup-field.wide,.fm-app-setup-radio,.fm-app-setup-multi,.fm-app-setup-check,.fm-app-setup-info{grid-column:auto}.fm-app-setup-options,.fm-feedback-grid{grid-template-columns:1fr}.fm-feedback-message-layout{grid-template-columns:1fr}.fm-feedback-preview{min-height:280px}.fm-app-setup-review-row{grid-template-columns:1fr;gap:4px}.fm-app-setup-review-row strong{text-align:left}}
    `;
    document.head.appendChild(style);
  }

  function fieldVisible(definition, values){
    if (typeof definition.visibleWhen !== 'function') return true;
    try { return definition.visibleWhen(values) !== false; } catch (error) { return true; }
  }
  function fieldRequired(definition, values){
    if (typeof definition.requiredWhen === 'function') {
      try { return definition.requiredWhen(values) === true; } catch (error) { return false; }
    }
    return definition.required === true;
  }
  function optionLabel(definition, value){ return clean(definition.options?.find((entry) => String(entry.value) === String(value))?.label) || clean(value); }
  function valueLabel(definition, value){
    if (Array.isArray(value)) return value.map((item) => optionLabel(definition, item)).join(', ');
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    return optionLabel(definition, value) || 'Not set';
  }
  function validateField(definition, values){
    if (!fieldVisible(definition, values)) return '';
    const value = values[definition.id];
    const missing = Array.isArray(value) ? value.length === 0 : (definition.type === 'checkbox' ? value !== true : clean(value) === '');
    if (fieldRequired(definition, values) && missing) return `${definition.label} is required.`;
    if (!missing && definition.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(value))) return `Enter a valid email address for ${definition.label}.`;
    if (!missing && definition.type === 'url') { try { const parsed = new URL(clean(value)); if (!['http:','https:'].includes(parsed.protocol)) throw new Error(); } catch (error) { return `Enter a full web address for ${definition.label}.`; } }
    if (!missing && definition.type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number) || (definition.min != null && number < Number(definition.min)) || (definition.max != null && number > Number(definition.max))) return `${definition.label} must be between ${definition.min ?? 'the minimum'} and ${definition.max ?? 'the maximum'}.`;
    }
    if (typeof definition.validate === 'function') {
      try { return clean(definition.validate(value, values)); } catch (error) { return clean(error?.message); }
    }
    return '';
  }
  function validateStep(stepDefinition, values){ return array(stepDefinition.fields).map((entry) => validateField(entry, values)).filter(Boolean); }

  function inputMarkup(definition, values){
    const value = values[definition.id];
    const required = fieldRequired(definition, values);
    const requiredMark = required ? '<span class="fm-app-setup-required">*</span>' : '';
    const help = definition.help ? `<small class="fm-app-setup-help">${esc(definition.help)}</small>` : '';
    if (definition.type === 'info') {
      const body = typeof definition.body === 'function' ? definition.body(values) : definition.body;
      const tone = typeof definition.tone === 'function' ? definition.tone(values) : definition.tone;
      return `<div class="fm-app-setup-info ${esc(tone || '')}"><i class="fas ${tone === 'success' ? 'fa-circle-check' : 'fa-circle-info'}"></i><span><strong>${esc(definition.label)}</strong><br>${esc(body || '')}</span></div>`;
    }
    if (definition.type === 'checkbox') return `<label class="fm-app-setup-check"><input type="checkbox" data-app-setup-field="${esc(definition.id)}" ${value === true ? 'checked' : ''}><span>${esc(definition.checkboxLabel || definition.label)}${requiredMark}</span></label>`;
    if (definition.type === 'radio' || definition.type === 'multi') {
      const inputType = definition.type === 'multi' ? 'checkbox' : 'radio';
      const selected = definition.type === 'multi' ? array(value).map(String) : [String(value ?? '')];
      return `<div class="fm-app-setup-field wide fm-app-setup-${definition.type}"><span class="fm-app-setup-label">${esc(definition.label)}${requiredMark}</span><div class="fm-app-setup-options">${array(definition.options).map((entry) => `<label class="fm-app-setup-option"><input type="${inputType}" ${inputType === 'radio' ? `name="fm-app-setup-${esc(definition.id)}"` : ''} data-app-setup-field="${esc(definition.id)}" value="${esc(entry.value)}" ${selected.includes(String(entry.value)) ? 'checked' : ''}><span><strong>${entry.icon ? `<i class="fas ${esc(entry.icon)}"></i> ` : ''}${esc(entry.label)}</strong>${entry.description ? `<small>${esc(entry.description)}</small>` : ''}</span></label>`).join('')}</div>${help}</div>`;
    }
    const options = definition.type === 'select' ? `<select data-app-setup-field="${esc(definition.id)}">${array(definition.options).map((entry) => `<option value="${esc(entry.value)}" ${String(value ?? '') === String(entry.value) ? 'selected' : ''}>${esc(entry.label)}</option>`).join('')}</select>` : '';
    const input = definition.type === 'textarea'
      ? `<textarea data-app-setup-field="${esc(definition.id)}" placeholder="${esc(definition.placeholder || '')}">${esc(value ?? '')}</textarea>`
      : `<input type="${esc(definition.type || 'text')}" data-app-setup-field="${esc(definition.id)}" value="${esc(value ?? '')}" placeholder="${esc(definition.placeholder || '')}" ${definition.min != null ? `min="${esc(definition.min)}"` : ''} ${definition.max != null ? `max="${esc(definition.max)}"` : ''}>`;
    return `<div class="fm-app-setup-field ${definition.wide ? 'wide' : ''}"><label>${esc(definition.label)}${requiredMark}</label><div class="fm-app-setup-control ${definition.suffix ? 'has-suffix' : ''}">${options || input}${definition.suffix ? `<span class="fm-app-setup-suffix">${esc(definition.suffix)}</span>` : ''}</div>${help}</div>`;
  }

  function bindFields(container, stepDefinition, ctx){
    container.querySelectorAll('[data-app-setup-field]').forEach((control) => {
      const definition = array(stepDefinition.fields).find((entry) => entry.id === control.dataset.appSetupField);
      if (!definition) return;
      const eventName = ['text','email','url','tel','number','date','time','textarea'].includes(definition.type) ? 'input' : 'change';
      control.addEventListener(eventName, () => {
        if (definition.type === 'multi') {
          ctx.state.values[definition.id] = [...container.querySelectorAll(`[data-app-setup-field="${CSS.escape(definition.id)}"]:checked`)].map((entry) => entry.value);
        } else if (definition.type === 'checkbox') ctx.state.values[definition.id] = control.checked;
        else if (definition.type === 'number') ctx.state.values[definition.id] = control.value === '' ? '' : Number(control.value);
        else ctx.state.values[definition.id] = control.value;
        ctx.touch();
        if (typeof definition.visibleWhen === 'function' || array(stepDefinition.fields).some((entry) => typeof entry.visibleWhen === 'function' || typeof entry.requiredWhen === 'function' || entry.type === 'info')) ctx.refresh();
      });
    });
  }

  function reviewStep(definition){
    return {
      id:'review', label:(globalThis.PlatformLanguage?.text("app-setup-workflows","m_b0bb1e74e2a6d3","Review") ?? "Review"),
      render(container, ctx){
        const rows = array(definition.steps).flatMap((entry) => array(entry.fields)).filter((entry) => entry.type !== 'info' && fieldVisible(entry, ctx.state.values));
        container.innerHTML = `<div class="fm-app-setup-head"><h2>${((v0) => globalThis.PlatformLanguage?.htmlText("app-setup-workflows","m_8691daea5eeeb3",`Review ${v0} setup`,{v0}) ?? `Review ${v0} setup`)(esc(definition.label))}</h2><p>${(globalThis.PlatformLanguage?.htmlText("app-setup-workflows","m_9b265eeefebab0","These values are generated from the workflow declaration. Future design or field changes can be applied across every app from the same renderer.") ?? "These values are generated from the workflow declaration. Future design or field changes can be applied across every app from the same renderer.")}</p></div><div class="fm-app-setup-review">${String(rows.map((entry) => `<div class="fm-app-setup-review-row"><span>${esc(entry.label)}</span><strong>${esc(valueLabel(entry, ctx.state.values[entry.id]))}</strong></div>`).join(''))}</div>`;
      },
      validate:() => [],
      status:(ctx) => ctx.state.visitedSteps.includes('review') ? { state:'done', label:(globalThis.PlatformLanguage?.text("app-setup-workflows","m_6c3eb25c88a89f","Reviewed") ?? "Reviewed") } : null,
      nextLabel:definition.mode === 'required' ? 'Finish Setup' : 'Save Setup'
    };
  }

  function generatedSteps(definition){
    return array(definition.steps).map((entry) => ({
      id:entry.id,
      label:entry.label,
      render(container, ctx){
        if (typeof entry.render === 'function') entry.render(container, ctx, entry);
        else {
          container.innerHTML = `<div class="fm-app-setup-head"><h2>${esc(entry.title)}</h2><p>${esc(entry.description)}</p></div><div class="fm-app-setup-fields">${array(entry.fields).filter((item) => fieldVisible(item, ctx.state.values)).map((item) => inputMarkup(item, ctx.state.values)).join('')}</div>`;
          bindFields(container, entry, ctx);
        }
      },
      validate:(ctx) => validateStep(entry, ctx.state.values),
      status:(ctx) => {
        if (!ctx.state.visitedSteps.includes(entry.id)) return null;
        const issues = validateStep(entry, ctx.state.values);
        return issues.length ? { state:'needs-attention', label:((v0,v1) => globalThis.PlatformLanguage?.text("app-setup-workflows","m_e156ce60503568",`${v0} item${v1} left`,{v0,v1}) ?? `${v0} item${v1} left`)(issues.length,issues.length === 1 ? '' : 's') } : { state:'done', label:(globalThis.PlatformLanguage?.text("app-setup-workflows","m_e8e493437c1a17","Complete") ?? "Complete") };
      }
    })).concat(reviewStep(definition));
  }

  function seedValues(definition, savedValues){
    const values = { ...object(savedValues) };
    array(definition.steps).flatMap((entry) => array(entry.fields)).forEach((entry) => {
      if (values[entry.id] !== undefined || entry.defaultValue === undefined) return;
      values[entry.id] = Array.isArray(entry.defaultValue) ? [...entry.defaultValue] : entry.defaultValue;
    });
    return values;
  }

  async function applyDefinition(definition, values){
    if (typeof definition.capabilityValues === 'function') {
      const updates = object(definition.capabilityValues(values));
      if (Object.keys(updates).length && window.Portal?.capabilities?.update) await window.Portal.capabilities.update(updates);
    }
    if (typeof definition.apply === 'function') await definition.apply(values, appContext());
  }
  function navigateHandoff(definition){
    if (!definition.handoff || !window.Portal?.navigation?.navigate) return;
    const patch = { ...definition.handoff, workflow:'', workflow_step:'' };
    window.Portal.navigation.navigate(patch, { source:`${definition.key}-setup-complete`, ownedKeys:Object.keys(patch) });
  }

  async function open(key, context = {}){
    const definition = definitions.get(clean(key));
    if (!definition || definition.mode === 'none') return null;
    if (!window.FirstMateSetupWizard?.open) throw new Error('The setup workflow library is unavailable.');
    const navigation = window.Portal?.navigation;
    if (navigation?.value?.('tab') !== 'company_settings') {
      navigation?.navigate?.(
        { tab:'company_settings', sub:'app_flags', settingsView:'manage_apps', settingsEntity:'' },
        { source:`${definition.key}-setup-parent`, ownedKeys:['tab','sub','settingsView','settingsEntity'] }
      );
    }
    await load();
    ensureCss();
    const record = object(records.get(definition.key));
    const state = {
      values:seedValues(definition, record.values),
      visitedSteps:[...new Set(array(record.visited_steps))],
      activeStep:clean(context.stepId || navigation?.value?.('workflow_step') || record.active_step || definition.steps[0]?.id)
    };
    if (typeof definition.prepare === 'function') await definition.prepare(state.values, appContext());
    const declaredSteps = array(definition.steps);
    const requestedIndex = declaredSteps.findIndex((entry) => entry.id === state.activeStep);
    const firstIncomplete = declaredSteps.findIndex((entry) => validateStep(entry, state.values).length > 0);
    if (firstIncomplete >= 0 && (requestedIndex < 0 || requestedIndex > firstIncomplete)) state.activeStep = declaredSteps[firstIncomplete].id;
    if (!state.visitedSteps.includes(state.activeStep)) state.visitedSteps.push(state.activeStep);
    await saveRecord(definition.key, state, record.status === 'complete' ? 'complete' : 'in_progress');
    const wizard = window.FirstMateSetupWizard.open({
      id:`app-setup-${definition.key.replace(/[^a-z0-9]+/gi,'-')}`,
      workflowKey:`app_setup:${definition.key}`,
      title:((v0) => globalThis.PlatformLanguage?.text("app-setup-workflows","m_2e0634d2e23124",`Set up ${v0}`,{v0}) ?? `Set up ${v0}`)(definition.label),
      subtitle:definition.summary,
      icon:definition.icon,
      steps:generatedSteps(definition),
      initialStepId:state.activeStep,
      state,
      statusNote:record.status === 'complete' ? 'Setup completed previously. Changes autosave as a draft.' : 'Changes autosave for this branch.',
      railNote:`${definition.mode === 'required' ? `<strong>${(globalThis.PlatformLanguage?.htmlText("app-setup-workflows","m_abb8ef16fd28ae","Required setup") ?? "Required setup")}</strong><br>` : `<strong>${(globalThis.PlatformLanguage?.htmlText("app-setup-workflows","m_d172e68b960224","Optional setup") ?? "Optional setup")}</strong><br>`}${esc(definition.summary)}`,
      autosave:{ debounceMs:600, save:(nextState) => saveRecord(definition.key, nextState, record.status === 'complete' ? 'complete' : 'in_progress') },
      onStepChange:(toId, fromId, ctx) => {
        ctx.state.activeStep = toId;
        if (!ctx.state.visitedSteps.includes(toId)) ctx.state.visitedSteps.push(toId);
        ctx.touch();
      },
      stepNavigable:(stepId, ctx) => {
        const allSteps = array(definition.steps);
        const targetIndex = stepId === 'review' ? allSteps.length : allSteps.findIndex((entry) => entry.id === stepId);
        if (targetIndex <= 0) return true;
        return allSteps.slice(0, targetIndex).every((entry) => validateStep(entry, ctx.state.values).length === 0);
      },
      onSubmit:async (ctx) => {
        ctx.setStatus('Applying setup…');
        try {
          await applyDefinition(definition, ctx.state.values);
          ctx.state.activeStep = 'review';
          await saveRecord(definition.key, ctx.state, 'complete');
          window.PlatformUI?.showToast?.(((v0) => globalThis.PlatformLanguage?.text("app-setup-workflows","m_66e1b355340bdd",`${v0} setup complete.`,{v0}) ?? `${v0} setup complete.`)(definition.label));
          await ctx.close({ reason:'complete', skipSave:true });
          navigateHandoff(definition);
        } catch (error) {
          ctx.setIssues([clean(error?.message) || 'Setup could not be applied.']);
          ctx.setStatus('Setup was not completed. Your draft is saved.');
        }
      },
      submitLabel:definition.mode === 'required' ? 'Finish Setup' : 'Save Setup'
    });
    return wizard;
  }

  async function applyPayroll(values, context){
    if (!window.PayrollAPI?.schedules?.list || !window.PayrollAPI?.schedules?.create) throw new Error('Payroll services are not available yet.');
    const result = await window.PayrollAPI.schedules.list(context.orgId, { includeArchived:false });
    const schedules = array(result?.schedules || result?.documents);
    if (schedules.some((entry) => clean(entry.status || 'active') !== 'archived')) return;
    const frequency = clean(values.frequency) || 'weekly';
    const recurrence = { frequency };
    if (['weekly','biweekly'].includes(frequency)) recurrence.weekday = Number(values.weekday ?? 5);
    if (frequency === 'biweekly') recurrence.anchor_date = clean(values.anchor_date);
    if (frequency === 'semi_monthly') recurrence.days = [...new Set(clean(values.semi_monthly_days).split(',').map((entry) => Number(entry.trim())).filter((entry) => Number.isInteger(entry) && entry >= 1 && entry <= 31))];
    if (frequency === 'monthly') recurrence.day = Number(values.monthly_day || 1);
    await window.PayrollAPI.schedules.create(context.orgId, {
      name:clean(values.schedule_name), status:'active', currency:'USD', timezone:clean(values.timezone), recurrence,
      delay:{ periods:Number(values.delay_periods || 0), days:0 }, timing_basis:clean(values.timing_basis) || 'worked',
      clawback_cap_percent:Number(values.clawback_cap_percent ?? 100), metadata:{ created_from:'app_setup_workflow' }
    });
  }
  async function feedbackRequest(path, options = {}){
    const base = `${location.origin}/v1/feedback`;
    if (window.PlatformAPI?.request) return window.PlatformAPI.request(`${base}${path}`, options);
    const response = await fetch(`${base}${path}`, { credentials:'include', headers:{ Accept:'application/json', 'Content-Type':'application/json' }, ...options, body:options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.message || 'Feedback settings could not be saved.');
    return data;
  }
  function feedbackSetupLink(){
    return `${['127.0.0.1','localhost'].includes(location.hostname.toLowerCase()) ? 'http://127.0.0.1:8011' : 'https://app.1m8.ai'}/l/feedback-preview`;
  }
  function feedbackSample(value){
    return clean(value).replace(/\{\{\s*customer_first_name\s*\}\}/g, 'Sarah').replace(/\{\{\s*customer_name\s*\}\}/g, 'Sarah Mitchell').replace(/\{\{\s*company_name\s*\}\}/g, 'Your Company').replace(/\{\{\s*project_title\s*\}\}/g, 'the roof replacement').replace(/\{\{\s*link\s*\}\}/g, feedbackSetupLink());
  }
  function renderFeedbackDeliveryStep(container, ctx, definition){
    const values = ctx.state.values;
    const selected = clean(values.feedback_trigger) || 'workflow';
    const channels = array(values.feedback_channels);
    // TODO(feedback-scope-timing): populate this list from the active scope
    // sets and their automation triggers once that context is exposed here.
    const timings = [
      option('project_completed','When work is completed','A project work plan reaches completion.','fa-flag-checkered'),
      option('final_payment','After final payment','A settled final payment is recorded.','fa-circle-dollar-to-slot'),
      option('crew_completed','After crew closeout','The crew completes its closeout checklist.','fa-clipboard-check'),
      option('manual','Manually only','No automatic event-based delivery.','fa-hand-pointer')
    ];
    const channelDefs = [option('sms','Text message','Send a short link to their mobile phone.','fa-message'),option('email','Email','Send a branded request to their inbox.','fa-envelope'),option('portal','Customer portal','Show a card in their project portal.','fa-window-maximize')];
    const choices = (items, attr, current) => items.map((item) => `<button type="button" class="fm-feedback-choice ${current.includes(item.value) ? 'on' : ''}" ${attr}="${esc(item.value)}"><i class="fas ${esc(item.icon)}"></i><span><b>${esc(item.label)}</b><span>${esc(item.description)}</span></span></button>`).join('');
    container.innerHTML = `<div class="fm-app-setup-head"><h2>${String(esc(definition.title))}</h2><p>${String(esc(definition.description))}</p></div><div class="fm-feedback-setup">
      <section class="fm-feedback-card"><div class="fm-feedback-card-head"><strong><i class="fas fa-clock"></i>${(globalThis.PlatformLanguage?.htmlText("app-setup-workflows","m_4dcdaed478d0bf"," When should this be sent?") ?? " When should this be sent?")}</strong><span data-feedback-setup-insight></span></div><p>${(globalThis.PlatformLanguage?.htmlText("app-setup-workflows","m_11cfdabed0d427","These are provisional global events. Each project still receives one idempotent request.") ?? "These are provisional global events. Each project still receives one idempotent request.")}</p><div class="fm-feedback-grid">${String(choices(timings,'data-feedback-setup-trigger',[selected]))}</div><div class="fm-feedback-scope-note"><i class="fas fa-diagram-project"></i><span><strong>${(globalThis.PlatformLanguage?.htmlText("app-setup-workflows","m_479768d58a038e","Scope-aware timing is still being connected.") ?? "Scope-aware timing is still being connected.")}</strong>${(globalThis.PlatformLanguage?.htmlText("app-setup-workflows","m_2cd95b8b3ef3a0"," Workflows and scope sets can already call the feedback action with complete delivery parameters; those triggers belong in the workflow and do not need a button here.") ?? " Workflows and scope sets can already call the feedback action with complete delivery parameters; those triggers belong in the workflow and do not need a button here.")}</span></div></section>
      <section class="fm-feedback-card"><div class="fm-feedback-card-head"><strong><i class="fas fa-share-nodes"></i>${(globalThis.PlatformLanguage?.htmlText("app-setup-workflows","m_9a5412305bd598"," How do you want to send the message?") ?? " How do you want to send the message?")}</strong></div><p>${(globalThis.PlatformLanguage?.htmlText("app-setup-workflows","m_fbe82375e44216","Choose any combination. Every channel can still be previewed on the next step.") ?? "Choose any combination. Every channel can still be previewed on the next step.")}</p><div class="fm-feedback-grid">${String(choices(channelDefs,'data-feedback-setup-channel',channels))}</div></section>
    </div>`;
    if (window.FirstMateInsights?.mount) window.FirstMateInsights.mount(container.querySelector('[data-feedback-setup-insight]'), { id:'feedback_setup_delivery_timing_recommendation', title:(globalThis.PlatformLanguage?.text("app-setup-workflows","m_87973863921b2d","Send every customer a feedback request") ?? "Send every customer a feedback request"), body:'We recommend automatically sending the feedback request to all customers, even if the job did not go that well, because this gives the customer an opportunity to vent and leave their feedback in private.', developerContext:'Explain why consistently requesting private feedback can help identify problems, recover relationships, and improve service. Do not imply private feedback prevents public reviews.', preferredSide:'left' });
    container.querySelectorAll('[data-feedback-setup-trigger]').forEach((button) => button.addEventListener('click', () => { values.feedback_trigger = button.dataset.feedbackSetupTrigger; ctx.touch(); ctx.refresh(); }));
    container.querySelectorAll('[data-feedback-setup-channel]').forEach((button) => button.addEventListener('click', () => { const key = button.dataset.feedbackSetupChannel; values.feedback_channels = channels.includes(key) ? channels.filter((item) => item !== key) : [...channels,key]; ctx.touch(); ctx.refresh(); }));
  }
  function renderFeedbackMessagesStep(container, ctx, definition){
    const values = ctx.state.values;
    const active = ['sms','email','portal'].includes(values._feedback_message_tab) ? values._feedback_message_tab : 'sms';
    const enabled = array(values.feedback_channels).includes(active);
    const editor = active === 'email'
      ? `<div class="fm-feedback-input"><label>${(globalThis.PlatformLanguage?.htmlText("app-setup-workflows","m_eb218e4bd1f2dd","Email subject") ?? "Email subject")}</label><input data-feedback-message="email_subject" value="${String(esc(values.email_subject))}"></div><div class="fm-feedback-input"><label>${(globalThis.PlatformLanguage?.htmlText("app-setup-workflows","m_63ea7578d93f41","Email body") ?? "Email body")}</label><textarea rows="8" data-feedback-message="email_body">${String(esc(values.email_body))}</textarea></div>`
      : active === 'portal'
        ? `<div class="fm-feedback-input"><label>${(globalThis.PlatformLanguage?.htmlText("app-setup-workflows","m_f2b1764fc05842","Headline") ?? "Headline")}</label><input data-feedback-message="portal_title" value="${String(esc(values.portal_title))}"></div><div class="fm-feedback-input"><label>${(globalThis.PlatformLanguage?.htmlText("app-setup-workflows","m_a16cfd85cfd122","Message") ?? "Message")}</label><textarea rows="4" data-feedback-message="portal_body">${String(esc(values.portal_body))}</textarea></div><div class="fm-feedback-input"><label>${(globalThis.PlatformLanguage?.htmlText("app-setup-workflows","m_607eea667fd938","Button") ?? "Button")}</label><input data-feedback-message="portal_cta" value="${String(esc(values.portal_cta))}"></div>`
        : `<div class="fm-feedback-input"><label>${(globalThis.PlatformLanguage?.htmlText("app-setup-workflows","m_def279b4381c15","Text message") ?? "Text message")}</label><textarea rows="8" data-feedback-message="sms_text">${String(esc(values.sms_text))}</textarea></div>`;
    const preview = active === 'email'
      ? `<div class="fm-feedback-email"><b>${esc(feedbackSample(values.email_subject))}</b><span>${esc(feedbackSample(values.email_body))}</span></div>`
      : active === 'portal'
        ? `<div class="fm-feedback-portal"><span class="stars">★★★★★</span><h4>${esc(feedbackSample(values.portal_title))}</h4><p>${esc(feedbackSample(values.portal_body))}</p><button type="button">${esc(values.portal_cta)}</button></div>`
        : `<div class="fm-feedback-bubble">${esc(feedbackSample(values.sms_text))}</div>`;
    container.innerHTML = `<div class="fm-app-setup-head"><h2>${esc(definition.title)}</h2><p>${esc(definition.description)}</p></div><div class="fm-feedback-message-layout"><section class="fm-feedback-card fm-feedback-editor ${enabled ? '' : 'off'}"><div class="fm-feedback-tabs">${[['sms','Text'],['email','Email'],['portal','Portal']].map(([key,label]) => `<button type="button" data-feedback-message-tab="${key}" class="${active === key ? 'on' : ''}">${label}</button>`).join('')}</div><div class="fm-feedback-card-head"><strong>${active === 'sms' ? 'Text message' : active === 'email' ? 'Email message' : 'Customer portal message'}</strong><span class="fm-feedback-state">${enabled ? 'On' : 'Off'}</span></div>${editor}</section><aside class="fm-feedback-preview"><div class="fm-feedback-notch"></div><div class="fm-feedback-screen">${preview}</div></aside></div>`;
    container.querySelectorAll('[data-feedback-message-tab]').forEach((button) => button.addEventListener('click', () => { values._feedback_message_tab = button.dataset.feedbackMessageTab; ctx.refresh(); }));
    container.querySelectorAll('[data-feedback-message]').forEach((input) => input.addEventListener('input', () => { values[input.dataset.feedbackMessage] = input.value; ctx.touch(); renderFeedbackMessagesStep(container, ctx, definition); const next = container.querySelector(`[data-feedback-message="${CSS.escape(input.dataset.feedbackMessage)}"]`); next?.focus(); try { next?.setSelectionRange(input.selectionStart, input.selectionStart); } catch (error) {} }));
  }
  async function prepareFeedback(values, context){
    const path = `/organizations/${encodeURIComponent(context.orgId)}/branches/${encodeURIComponent(context.branchId)}/settings`;
    const current = await feedbackRequest(path);
    const settings = object(current?.settings);
    const delivery = object(settings.delivery), channels = object(settings.channels), messages = object(settings.messages), survey = object(settings.survey), review = object(settings.review);
    values.feedback_revision = Number(current?.revision || 0);
    values.feedback_trigger = clean(delivery.trigger) || values.feedback_trigger;
    values.feedback_channels = ['sms','email','portal'].filter((key) => channels[key] === true);
    for (const key of ['sms_text','email_subject','email_body','portal_title','portal_body','portal_cta']) if (clean(messages[key])) values[key] = messages[key];
    values.survey_question = clean(survey.question) || values.survey_question;
    values.comment_prompt = clean(survey.comment_prompt) || values.comment_prompt;
    values.low_comment_prompt = clean(survey.low_comment_prompt) || values.low_comment_prompt;
    values.review_mode = clean(review.mode) || values.review_mode;
    values.review_threshold = Number(review.threshold || values.review_threshold);
    const destination = array(review.destinations)[0];
    if (destination) { values.review_label = clean(destination.label); values.review_url = clean(destination.url); }
  }
  async function applyFeedback(values, context){
    const path = `/organizations/${encodeURIComponent(context.orgId)}/branches/${encodeURIComponent(context.branchId)}/settings`;
    const current = await feedbackRequest(path);
    const settings = object(current?.settings);
    const channels = array(values.feedback_channels);
    const destinations = clean(values.review_url) ? [{ id:'setup_review', label:clean(values.review_label) || 'Review us', url:clean(values.review_url), icon:'fas fa-star' }] : array(object(settings.review).destinations);
    await feedbackRequest(path, { method:'PUT', body:{
      ...settings, enabled:true,
      delivery:{ ...object(settings.delivery), trigger:clean(values.feedback_trigger) || 'workflow' },
      channels:{ ...object(settings.channels), sms:channels.includes('sms'), email:channels.includes('email'), portal:channels.includes('portal') },
      messages:{ ...object(settings.messages), sms_text:clean(values.sms_text), email_subject:clean(values.email_subject), email_body:clean(values.email_body), portal_title:clean(values.portal_title), portal_body:clean(values.portal_body), portal_cta:clean(values.portal_cta) },
      survey:{ ...object(settings.survey), scale:5, question:clean(values.survey_question), comment_prompt:clean(values.comment_prompt), low_comment_prompt:clean(values.low_comment_prompt) },
      review:{ ...object(settings.review), mode:clean(values.review_mode) || 'threshold', threshold:Number(values.review_threshold || 4), destinations },
      expected_revision:Number(current?.revision || 0) || undefined
    } });
  }
  async function prepareCalls(values){
    try {
      const response = await window.CallsAPI?.status?.();
      const provider = object(response?.provider);
      values.provider_name = clean(provider.provider) || 'call';
      values.provider_ready = provider.configured === true;
    } catch (error) {
      values.provider_name = 'call';
      values.provider_ready = false;
    }
  }
  async function chatRequest(path, options = {}){
    const platformBase = (clean(window.__APP?.platformApiBase) || `${location.origin}/v1/platform`).replace(/\/platform\/?$/i, '/chat').replace(/\/+$/, '');
    const csrfMatch = document.cookie.match(/(?:^|;\s*)fm_platform_session_csrf=([^;]+)/);
    const response = await fetch(`${platformBase}${path}`, { credentials:'include', cache:'no-store', ...options, headers:{ Accept:'application/json', ...(options.body ? {'Content-Type':'application/json'} : {}), ...(String(options.method || 'GET').toUpperCase() !== 'GET' && csrfMatch ? {'X-Platform-CSRF':decodeURIComponent(csrfMatch[1])} : {}), ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.message || 'Live chat settings could not be saved.');
    return data;
  }
  async function applyLiveChat(values, context){
    const path = `/organizations/${encodeURIComponent(context.orgId)}/branch/${encodeURIComponent(context.branchId)}/chat/settings`;
    const current = await chatRequest(path);
    const settings = object(current?.settings);
    await chatRequest(path, { method:'PUT', body:JSON.stringify({ data:{
      ...settings,
      enabled:values.chat_availability !== 'offline',
      widget:{ ...object(settings.widget), title:clean(values.chat_label) },
      availability:{ ...object(settings.availability), mode:clean(values.chat_availability) },
      notifications:{ ...object(settings.notifications), route:{ ...object(object(settings.notifications).route), mode:clean(values.chat_route), owner_email:clean(values.chat_owner) } }
    } }) });
  }

  async function messagingSetupStatus(orgId){
    const platformBase = clean(window.PlatformAPI?.baseUrl?.());
    const base = platformBase
      ? platformBase.replace(/\/v1\/platform\/?$/i, '/v1/messaging').replace(/\/+$/, '')
      : `${location.origin}/v1/messaging`;
    const response = await fetch(`${base}/organizations/${encodeURIComponent(orgId)}/sms/setup`, { credentials:'include', cache:'no-store', headers:{ Accept:'application/json' } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) return 'not_started';
    const profile = array(data.profiles)[0];
    if (!profile?.id) return 'not_started';
    const refs = object(profile.provider_refs);
    const autoresponse = object(profile.autoresponse_state);
    const campaignReady = clean(profile.campaign_status).toLowerCase() === 'mno_provisioned'
      && clean(autoresponse.status).toLowerCase() === 'configured'
      && !!autoresponse.desired_hash
      && autoresponse.desired_hash === autoresponse.applied_hash
      && autoresponse.messaging_profile_id === refs.telnyx_messaging_profile_id;
    const mockReady = (profile?.brand?.mock === true || profile?.campaign?.mock === true) && !!(refs.telnyx_campaign_id || refs.tcr_campaign_id);
    return clean(profile.status).toLowerCase() === 'active' && campaignReady || mockReady ? 'complete' : 'in_progress';
  }
  async function moneySetupStatus(orgId){
    if (!window.PaymentsAPI?.merchantConfig?.get) return 'not_started';
    const result = await window.PaymentsAPI.merchantConfig.get(orgId);
    const config = object(result?.merchant_config || result?.config || result);
    const forward = object(config.forward);
    const boarding = clean(forward.boarding_status).toUpperCase();
    if (boarding === 'APPROVED' || (!!clean(forward.account_id) && !boarding)) return 'complete';
    return clean(forward.application_id) || boarding ? 'in_progress' : 'not_started';
  }
  async function refreshExternalStatuses(){
    const context = appContext();
    if (!context.orgId) return;
    const [messaging, money] = await Promise.all([
      window.Portal?.capabilities?.value?.('apps.messaging', false) === true ? messagingSetupStatus(context.orgId).catch(() => 'not_started') : 'not_started',
      window.Portal?.capabilities?.value?.('platform.money', false) === true ? moneySetupStatus(context.orgId).catch(() => 'not_started') : 'not_started'
    ]);
    externalStatuses.set('apps.messaging', messaging);
    externalStatuses.set('platform.money', money);
    window.dispatchEvent(new CustomEvent('fm:app-setup:updated', { detail:{ external:true } }));
  }

  function register(){
    const setup = window.Portal?.appSetup;
    if (!setup?.declare) return;
    inventory.forEach((definition) => setup.declare(definition.key, {
      mode:definition.mode,
      summary:definition.summary,
      external:definition.external === true,
      getStatus:() => status(definition.key)
    }));
    inventory.filter((definition) => definition.mode !== 'none' && !definition.external).forEach((definition) => {
      setup.register(definition.key, (context) => open(definition.key, context));
    });

    // Finished external workflows: adapters only. Their implementation,
    // styling, fields, and state remain owned by their existing modules.
    setup.declare('apps.messaging', { mode:'required', external:true, summary:'Complete SMS / 10DLC registration before sending business messages.', getStatus:() => status('apps.messaging') });
    setup.register('apps.messaging', async () => {
      if (window.Portal?.capabilities?.value?.('platform.sms_settings', false) !== true) await window.Portal.capabilities.update({ 'platform.sms_settings':true });
      window.Portal.navigation?.navigate?.({ tab:'company_settings', sub:'sms', workflow:'10dlc', workflow_step:'business' }, { source:'messaging-app-setup', ownedKeys:['tab','sub','workflow','workflow_step'] });
    });
    setup.declare('platform.money', { mode:'required', external:true, summary:'Finish the existing payment registration workflow before collecting payments.', getStatus:() => status('platform.money') });

    window.Portal?.navigation?.registerHandler?.('declarative-app-setup-workflows', {
      priority:490,
      immediate:true,
      apply:(route) => {
        const workflowKey = clean(route?.workflow);
        if (!workflowKey.startsWith('app_setup:')) return;
        const key = workflowKey.slice('app_setup:'.length);
        const definition = definitions.get(key);
        if (!definition || definition.mode === 'none' || definition.external) return;
        const wizardId = `app-setup-${definition.key.replace(/[^a-z0-9]+/gi,'-')}`;
        if (document.querySelector(`[data-fm-wizard="${CSS.escape(wizardId)}"]`) || routeOpenPromises.has(key)) return;
        const pending = open(key, { source:'route', stepId:clean(route?.workflow_step) })
          .catch((error) => console.warn(`Could not restore app setup workflow: ${key}`, error))
          .finally(() => routeOpenPromises.delete(key));
        routeOpenPromises.set(key, pending);
      }
    });
  }

  window.FirstMateAppSetupWorkflows = {
    definitions,
    inventory:() => inventory.map((definition) => ({ key:definition.key, label:definition.label, mode:definition.mode, summary:definition.summary, external:definition.external === true, steps:array(definition.steps).map((entry) => entry.id) })),
    open,
    load,
    status,
    record:(key) => object(records.get(clean(key))),
    refresh:async () => { await load(); await refreshExternalStatuses(); return inventory.map((definition) => ({ key:definition.key, status:status(definition.key) })); }
  };
  register();
  window.addEventListener('fm:capabilities:updated', () => { refreshExternalStatuses().catch(() => null); });
  window.addEventListener('fm:platform-session:updated', () => { load().catch(() => null); });
  load().catch(() => null);
})();
