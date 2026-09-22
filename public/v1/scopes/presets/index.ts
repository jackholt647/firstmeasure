import type { ScopeTemplateDefinition } from "../schemas.js";

const ASSIGNMENTS_GROUP = {
  path: "assignments",
  label: "Assignments",
  description: "People and teams responsible for this project.",
  order: 10,
  collapsed_by_default: true,
  location: "project_left" as const,
  icon: "fa-user-group"
};

function salesAssignmentConfiguration() {
  return {
    custom_fields: {
      groups: [ASSIGNMENTS_GROUP],
      fields: [
        {
          path: "assignments.estimator",
          label: "Estimator",
          description: "Salesperson responsible for estimating and selling the project.",
          type: "organization_user" as const,
          cardinality: "one" as const,
          group_path: "assignments",
          order: 10,
          assignment_policy: {
            allow_unassigned: true,
            rules: [{ subject_types: ["organization_user"], role_ids: ["sales_appointments"] }]
          },
          default_from: {
            source: "event_assignment" as const,
            event_type_id: "sales_appointment",
            selection: "first_qualifying" as const,
            write_mode: "if_empty" as const,
            fallback_source: "proposal_creator" as const
          },
          ui: { project_tag: true, icon: "fa-user-tie" }
        },
        {
          path: "assignments.inside_salesperson",
          label: "Inside salesperson",
          description: "Person who scheduled or qualified the sales appointment.",
          type: "organization_user" as const,
          cardinality: "one" as const,
          group_path: "assignments",
          order: 20,
          assignment_policy: {
            allow_unassigned: true,
            rules: [{ subject_types: ["organization_user"], role_ids: ["inside_sales"] }]
          },
          default_from: {
            source: "event_scheduler" as const,
            event_type_id: "sales_appointment",
            selection: "first_qualifying" as const,
            write_mode: "if_empty" as const
          }
        }
      ]
    },
    communications: {
      email_forwarding: {
        enabled: true,
        priority: 10,
        target: { kind: "custom_field" as const, custom_field_path: "assignments.estimator" }
      }
    }
  };
}

function productionAssignmentConfiguration(includeSalesAssignments = false) {
  const salesAssignments = salesAssignmentConfiguration().custom_fields.fields;
  return {
    custom_fields: {
      groups: [ASSIGNMENTS_GROUP],
      fields: [
        ...(includeSalesAssignments ? salesAssignments : []),
        {
          path: "assignments.project_manager",
          label: "Project manager",
          description: "Person responsible for this project's production workflow.",
          type: "organization_user" as const,
          cardinality: "one" as const,
          group_path: "assignments",
          order: 30,
          assignment_policy: {
            allow_unassigned: true,
            rules: [{ subject_types: ["organization_user"] }]
          },
          ui: { project_tag: true, icon: "fa-user-gear" }
        },
        {
          path: "assignments.production_team",
          label: "Production team",
          description: "Crew, subcontractor, or person assigned to the first production event.",
          type: "assignable_subject" as const,
          cardinality: "one" as const,
          group_path: "assignments",
          order: 40,
          assignment_policy: {
            allow_unassigned: true,
            rules: [
              { subject_types: ["organization_user"] },
              { subject_types: ["resource_group"], group_kind_ids: ["crew"] },
              { subject_types: ["organization_connection"] }
            ]
          },
          default_from: {
            source: "event_assignment" as const,
            event_type_id: "project_work",
            selection: "first_qualifying" as const,
            write_mode: "if_empty" as const
          }
        }
      ]
    },
    communications: {
      email_forwarding: {
        enabled: true,
        priority: 20,
        target: { kind: "custom_field" as const, custom_field_path: "assignments.project_manager" }
      }
    }
  };
}

function callListRemoveBindings(prefix: string) {
  const removeBinding = (id: string) => ({ id, automation: "crm.callLists.remove.v1", input: {} });
  return {
    onCompleted: [removeBinding(`remove_completed_${prefix}`)],
    onSkipped: [removeBinding(`remove_skipped_${prefix}`)],
    onCanceled: [removeBinding(`remove_canceled_${prefix}`)]
  };
}

// The default sales pipeline. This is an ordinary scope template with
// `kind: "pipeline"` — the sales board derives from it exactly like production
// boards derive from their scope templates, and the transition into production
// scopes is expressed as an automation binding on the signature node instead of
// anywhere in engine code.
const SALES_PIPELINE_STAGES = [
  {
    id: "new_lead_stage",
    title: "New Lead",
    description: "New opportunities that need an initial response.",
    terminology_key: "work.stage",
    completion_mode: "all_children",
    metadata: { color: "#d49a22" },
    children: [{
      id: "contact_lead",
      title: "Contact lead",
      terminology_key: "work.task",
      actionable: true,
      show_in_todo_list: true,
      assigned_role_ids: ["sales_appointments"],
      external_triggers: [
        { event: "project.event_scheduled", transition: "completed", explainer: "Booking a sales appointment automatically checks off the 'Contact lead' step.", conditions: { "payload.event_type_default_id": "sales_appointment" } },
        { event: "proposal.sent", transition: "completed" },
        { event: "proposal.signed", transition: "completed" }
      ],
      automation_bindings: {
        // The intake-level org rule queues new leads (before any board);
        // finishing or skipping this step clears the shared queue entry.
        ...callListRemoveBindings("new_lead_call")
      },
      metadata: {
        kind: "sales_contact",
        call_list_key: "new_leads",
        call_list_kind: "lead",
        inline_disposition: {
          id: "sales_contact_disposition",
          options: [
            { id: "answered", label: "Answered", color: "#12b76a" },
            { id: "voicemail", label: "Left voicemail", color: "#f79009" },
            { id: "no_answer", label: "No voicemail", color: "#f04438" }
          ],
          answered_outcomes: ["appointment_booked", "follow_up", "lost"],
          follow_up_quick_options: ["two_hours", "tomorrow", "two_days", "next_week", "next_month", "custom"]
        }
      }
    }]
  },
  {
    id: "appointment_stage",
    title: "Appointment",
    description: "A sales appointment is scheduled or underway.",
    terminology_key: "work.stage",
    completion_mode: "all_children",
    depends_on: ["new_lead_stage"],
    metadata: { color: "#6b5ca5" },
    children: [
      {
        id: "complete_sales_appointment",
        title: "Complete appointment",
        terminology_key: "work.task",
        actionable: true,
        show_in_todo_list: true,
        assigned_role_ids: ["sales_appointments"],
        external_triggers: [
          { event: "proposal.sent", transition: "completed" },
          { event: "proposal.signed", transition: "completed" }
        ],
        metadata: { kind: "complete_sales_appointment" }
      },
      {
        id: "sales_appointment_completed",
        title: "Sales appointment finished",
        terminology_key: "work.task",
        actionable: false,
        show_in_todo_list: false,
        external_triggers: [
          { event: "project.event.completed", transition: "completed", conditions: { "payload.event_type_default_id": "sales_appointment" } },
          { event: "proposal.sent", transition: "skipped" },
          { event: "proposal.signed", transition: "skipped" }
        ],
        automation_bindings: {
          onCompleted: [{
            id: "notify_appointment_completed",
            automation: "notification.create.v1",
            explainer: "After a sales appointment wraps up, we ask the salesperson how it went.",
            input: {
              id: "notification_appointment_completed_{{project.id}}_{{event.payload.event_id}}",
              title: "Appointment completed",
              body: "How did the appointment go for {{project.address}}?",
              source: "scope.sales_pipeline.appointment_completed",
              kind: "passive",
              channel: "passive",
              passive: true,
              manual_dismissible: true,
              push: false,
              target_role_ids: ["sales_appointments"],
              frontend_action: { kind: "open_project", project_id: "{{project.id}}" },
              context: { project_id: "{{project.id}}" }
            }
          }]
        }
      }
    ]
  },
  {
    id: "proposal_stage",
    title: "Proposal",
    description: "Send the proposal after the appointment.",
    terminology_key: "work.stage",
    completion_mode: "all_children",
    depends_on: ["appointment_stage"],
    metadata: { color: "#2f855a" },
    children: [{
      id: "send_proposal",
      title: "Send proposal",
      terminology_key: "work.task",
      actionable: true,
      show_in_todo_list: true,
      external_triggers: [
        { event: "proposal.sent", transition: "completed" },
        { event: "proposal.signed", transition: "completed" }
      ],
      metadata: { kind: "send_proposal" }
    }]
  },
  {
    id: "closing_stage",
    title: "Pending Deposit",
    description: "The proposal has been sent and needs a signature and deposit.",
    terminology_key: "work.stage",
    completion_mode: "all_children",
    depends_on: ["proposal_stage"],
    metadata: { color: "#d97706" },
    children: [
      {
        id: "sign_sales_proposal",
        title: "Get signature",
        terminology_key: "work.task",
        actionable: true,
        show_in_todo_list: true,
        external_triggers: [{ event: "proposal.signed", transition: "completed" }],
        automation_bindings: {
          onCompleted: [{
            id: "activate_signed_scopes",
            automation: "scopes.activateFromProposal.v1",
            explainer: "When the customer signs, the project moves onto the production board for the work they bought and the sales pipeline wraps up.",
            input: {}
          }]
        }
      },
      {
        id: "collect_sales_deposit",
        title: "Collect deposit",
        terminology_key: "work.task",
        actionable: true,
        show_in_todo_list: true,
        depends_on: ["sign_sales_proposal"],
        external_triggers: [{ event: "payment.received", transition: "completed", explainer: "Receiving the deposit completes the sales pipeline.", conditions: { "payload.payment_kind": "deposit" } }]
      }
    ]
  }
];

function salesPipelineTemplate(): ScopeTemplateDefinition {
  return {
    schema_version: 1,
    id: "sales_pipeline",
    kind: "pipeline",
    name: "Sales",
    description: "Lead contact through signature and deposit.",
    details: "The default sales pipeline: contact the lead, run the appointment, send the proposal, and collect the signature and deposit. Signing a proposal activates the production scopes it contains.",
    color: "#1769aa",
    icon: "fa-filter-circle-dollar",
    status: "active",
    proposal: { kind: "sales_pipeline", selectable: false },
    fields: [],
    ...salesAssignmentConfiguration(),
    work_plan: {
      title: "Sales",
      terminology: { phase: "Phase", stage: "Stage", task: "To-do", board: "Board" },
      metadata: {
        board_color: "#1769aa",
        canceled_column: { id: "lost", title: "Lost", color: "#f04438" }
      },
      root_nodes: [{
        id: "sales_phase",
        title: "Sales",
        terminology_key: "work.phase",
        completion_mode: "all_children",
        metadata: { color: "#1769aa", board_id: "sales_pipeline" },
        children: SALES_PIPELINE_STAGES
      }]
    },
    metadata: { preset: true, preset_revision: 4 }
  };
}

function roofingSalesAppointmentTemplate(): ScopeTemplateDefinition {
  return {
    schema_version: 1,
    id: "roofing_sales_appointment",
    kind: "pipeline",
    name: "Standard Roofing Sales",
    description: "A complete roofing sales appointment from en-route notice through proposal, approval, payment, notes and follow-up.",
    details: "The sales pipeline owns the appointment workflow. It issues a workflow-only Good / Better / Best roofing proposal and lets the salesperson complete it on device or send it to the customer portal.",
    color: "#b42318",
    icon: "fa-house-chimney",
    status: "active",
    proposal: { kind: "roofing_sales_pipeline", selectable: false },
    fields: [],
    ...salesAssignmentConfiguration(),
    work_plan: {
      title: "Standard Roofing Sales",
      terminology: { phase: "Phase", stage: "Stage", task: "To-do", board: "Board" },
      metadata: { board_color: "#b42318" },
      root_nodes: [{
        id: "roofing_sales_phase",
        title: "Roofing Sales",
        terminology_key: "work.phase",
        completion_mode: "all_children",
        metadata: { color: "#b42318", board_id: "roofing_sales_appointment" },
        children: [{
          id: "roofing_appointment_stage",
          title: "Appointment",
          terminology_key: "work.stage",
          completion_mode: "all_children",
          children: [{
            id: "roofing_customer_proposal",
            title: "Price and present roofing options",
            terminology_key: "work.task",
            actionable: true,
            show_in_todo_list: true,
            assigned_role_ids: ["sales_appointments"],
            external_triggers: [{ event: "document.signed", transition: "completed", conditions: { "payload.template_id": "tpl_roofing_good_better_best_workflow" } }],
            automation_bindings: {
              onReady: [{
                id: "issue_roofing_workflow_proposal",
                automation: "documents.issue.v1",
                explainer: "Prepare the workflow-only roofing proposal when the sales appointment becomes ready.",
                input: {
                  template_id: "tpl_roofing_good_better_best_workflow",
                  workflow_id: "wfl_roofing_customer_workflow",
                  deliver: "none",
                  title: "Roofing Options & Approval",
                  params: {
                    deposit_cents: 350000,
                    option_good_price: 14500,
                    option_better_price: 17800,
                    option_best_price: 21400
                  }
                }
              }]
            },
            metadata: { kind: "roofing_sales_visit", frontend_action: { kind: "open_project", tab: "signatures" } }
          }]
        }]
      }]
    },
    metadata: {
      preset: true,
      preset_revision: 2,
      field_launch: {
        enabled: true,
        title: "Roofing Proposal (Good / Better / Best)",
        description: "Prepare the three-option roofing proposal, present it, and collect the customer's signature and deposit.",
        category: "Roofing",
        icon: "fa-house-chimney",
        keywords: ["roof", "roofing", "proposal", "estimate", "good better best"],
        frequent: true
      },
      visit_workflow: {
        enabled: true,
        id: "standard_roofing_sales_visit",
        title: "Roofing Sales Appointment",
        event_types: ["sales_appointment"],
        steps: [
          {
            id: "en_route",
            title: "On my way",
            navigation_title: "En route",
            kind: "notification",
            description: "Review the arrival estimate and customer text before starting the trip.",
            action: {
              label: "Send SMS & start trip",
              transition: "en_route",
              notify: { channel: "sms", message: "Hi {{customer.name}}, {{technician.name}} is on the way and expects to arrive in {{arrival.eta}}. We are headed to {{project.address}}." }
            }
          },
          { id: "arrived", title: "Arrive", navigation_title: "Arrived", kind: "status", description: "Confirm that you have arrived and are ready to begin.", action: { label: "I've arrived", transition: "arrived" } },
          { id: "appointment", title: "Run the roofing appointment", navigation_title: "Appointment", kind: "status", description: "Inspect the property, understand the customer's goals, and discuss the roofing system options.", action: { label: "Appointment complete", transition: "appointment_completed" } },
          { id: "price", title: "Build the roofing price", navigation_title: "Price", kind: "workflow_prepare", description: "Open the workflow-only roofing proposal, configure the Good / Better / Best options, and prepare it for the customer.", scope_template_id: "roofing_sales_appointment", target_tab: "crew_signatures" },
          {
            id: "delivery",
            title: "Choose how the customer will approve",
            navigation_title: "Present",
            kind: "outcome",
            description: "Continue together on this device or make the prepared workflow available in the customer portal.",
            actions: [
              { id: "on_device", label: "Complete on this device", transition: "on_device", icon: "fa-mobile-screen", tone: "success" },
              { id: "customer_portal", label: "Send to customer portal", transition: "customer_portal", icon: "fa-paper-plane", tone: "warning", effect: { kind: "send_workflow_to_portal", scope_template_id: "roofing_sales_appointment" } }
            ]
          },
          { id: "approval", title: "Customer approval & deposit", navigation_title: "Approve", kind: "workflow", description: "Hand the device to the customer to choose an option, sign, and make the deposit.", scope_template_id: "roofing_sales_appointment", target_tab: "crew_signatures", when: { step_id: "delivery", action_ids: ["on_device"] } },
          {
            id: "notes",
            title: "Appointment notes & follow-up",
            navigation_title: "Notes",
            kind: "notes_followup",
            description: "Record what happened and decide whether a follow-up should be assigned.",
            actions: [
              { id: "follow_up", label: "Save notes & set follow-up", transition: "notes_saved", icon: "fa-calendar-plus", tone: "warning" },
              { id: "no_follow_up", label: "Save notes without follow-up", transition: "notes_saved", icon: "fa-floppy-disk", tone: "neutral" }
            ]
          },
          { id: "summary", title: "Sales visit summary", navigation_title: "Summary", kind: "summary", description: "Signature and payment status update automatically. When both are complete, the project is sold.", scope_template_id: "roofing_sales_appointment", target_tab: "crew_signatures" },
          { id: "finish", title: "Complete the visit", navigation_title: "Done", kind: "complete", description: "Close the appointment after the proposal is signed, paid, and summarized.", scope_template_id: "roofing_sales_appointment", requires: "workflow_complete", action: { label: "Complete visit", transition: "completed" } }
        ]
      }
    }
  };
}

function sameDayServiceSalesTemplate(): ScopeTemplateDefinition {
  return {
    schema_version: 1,
    id: "same_day_service_sales",
    kind: "pipeline",
    name: "Same-Day Service Sales",
    description: "On-site assessment, materials/labor quote, payment and customer authorization.",
    details: "A mobile sales visit that creates an editable service quote. The customer's in-person signature activates the predetermined Same-Day Service Production scope through the standard document.signed event.",
    color: "#7c3aed",
    icon: "fa-bolt",
    status: "active",
    proposal: { kind: "same_day_service_sales", selectable: false },
    fields: [],
    checklists: [{
      id: "same_day_assessment",
      title: "On-site assessment",
      description: "Information required before preparing the same-day quote.",
      kind: "todo",
      audience: "crew",
      crew_editable: false,
      assignment_policy: { schema_version: 1, mode: "any", allow_unassigned: true, rules: [] },
      icon: "fa-clipboard-check",
      sort_order: 10,
      items: [
        { title: "Confirm the requested service and affected equipment", item_type: "todo" },
        { title: "Document existing conditions and take required photos", item_type: "todo" },
        { title: "Confirm materials, labor, and estimated hours", item_type: "todo" },
        { title: "Review the recommended work with the customer", item_type: "todo" }
      ]
    }],
    ...salesAssignmentConfiguration(),
    work_plan: {
      title: "Same-Day Service Sales",
      terminology: { phase: "Phase", stage: "Stage", task: "To-do", board: "Board" },
      metadata: { board_color: "#7c3aed" },
      root_nodes: [{
        id: "same_day_sales_phase",
        title: "Same-Day Service Sales",
        terminology_key: "work.phase",
        completion_mode: "all_children",
        metadata: { color: "#7c3aed", board_id: "same_day_service_sales" },
        children: [{
          id: "on_site_visit_stage",
          title: "On-Site Visit",
          terminology_key: "work.stage",
          completion_mode: "all_children",
          metadata: { color: "#7c3aed" },
          children: [{
            id: "authorize_same_day_service",
            title: "Assess, quote, collect payment & authorize",
            terminology_key: "work.task",
            actionable: true,
            show_in_todo_list: true,
            assigned_role_ids: ["sales_appointments"],
            external_triggers: [{
              event: "document.signed",
              transition: "completed",
              conditions: { "payload.template_id": "tpl_same_day_service_authorization" },
              explainer: "The customer's on-site authorization completes the sales visit."
            }],
            automation_bindings: {
              onReady: [{
                id: "issue_same_day_service_authorization",
                automation: "documents.issue.v1",
                explainer: "Create the technician's mobile assessment and quote workflow as soon as the visit is ready.",
                input: {
                  template_id: "tpl_same_day_service_authorization",
                  workflow_id: "wfl_same_day_service_field",
                  deliver: "none",
                  title: "Same-Day Service Authorization",
                  params: {
                    service_category: "Same-day equipment install",
                    diagnosis: "",
                    scope_items: [
                      { id: "same_day_materials", type: "scope_item", name: "Installation materials", display_name: "Installation materials", description: "Equipment, fittings and installation supplies", unit: "job", quantity: "1", unit_price: 450, base_price: 450, price_driving: true, included: false, selection: { mode: "always", selected: true }, children: [] },
                      { id: "same_day_labor", type: "scope_item", name: "Installation labor", display_name: "Installation labor", description: "Estimated technician hours", unit: "hour", quantity: "3", unit_price: 165, base_price: 165, price_driving: true, included: false, selection: { mode: "always", selected: true }, children: [] }
                    ]
                  }
                }
              }],
              onCompleted: [{
                id: "activate_same_day_service_production",
                automation: "scopes.activateTemplate.v1",
                explainer: "The signed authorization places the project into the predetermined same-day production workflow.",
                input: { template_id: "same_day_service_production", instance_key: "signed_same_day_authorization" }
              }]
            },
            metadata: { kind: "same_day_service_visit", frontend_action: { kind: "open_project", tab: "signatures" } }
          }]
        }]
      }]
    },
    metadata: {
      preset: true,
      preset_revision: 3,
      field_launch: {
        enabled: true,
        title: "Same-Day Service Install",
        description: "Assess the work, build an on-site materials and labor quote, collect payment, and obtain authorization.",
        category: "Service installs",
        icon: "fa-bolt",
        keywords: ["same day", "service", "install", "furnace", "water heater"],
        frequent: true
      },
      visit_workflow: {
        enabled: true,
        id: "same_day_sales_visit",
        title: "Same-Day Service Visit",
        event_types: ["sales_appointment"],
        steps: [
          {
            id: "en_route",
            title: "On my way",
            navigation_title: "En route",
            kind: "status",
            description: "Let the customer know you are headed to the appointment.",
            action: {
              label: "I'm on my way",
              transition: "en_route",
              notify: {
                channel: "sms",
                message: "Hi {{customer.name}}, {{technician.name}} is on the way to your appointment at {{project.address}}."
              }
            }
          },
          {
            id: "arrived",
            title: "Arrive",
            navigation_title: "Arrived",
            kind: "status",
            description: "Confirm that you have arrived and are ready to begin the visit.",
            action: { label: "I've arrived", transition: "arrived" }
          },
          {
            id: "assessment",
            title: "Complete the assessment",
            navigation_title: "Assess",
            kind: "checklist",
            description: "Work through the assigned on-site checklist before preparing the quote."
          },
          {
            id: "authorization",
            title: "Quote and authorization",
            navigation_title: "Authorize",
            kind: "workflow",
            description: "Build the quote, collect the required payment, and obtain the customer's signature.",
            scope_template_id: "same_day_service_sales",
            target_tab: "crew_signatures"
          },
          {
            id: "finish",
            title: "Finish the visit",
            navigation_title: "Done",
            kind: "complete",
            description: "Confirm that the appointment workflow is complete.",
            action: { label: "Complete visit", transition: "completed" }
          }
        ]
      }
    }
  };
}

function sameDayServiceProductionTemplate(): ScopeTemplateDefinition {
  return {
    schema_version: 1,
    id: "same_day_service_production",
    kind: "production",
    name: "Same-Day Service Production",
    description: "Start authorized service immediately and close it out on the same visit.",
    details: "Activated automatically by the signed same-day service authorization; preserves the event-driven sales-to-production handoff.",
    color: "#0f766e",
    icon: "fa-person-digging",
    status: "active",
    proposal: { kind: "same_day_service_production", piece_types: ["same_day_service_install"] },
    fields: [],
    checklists: [{
      id: "same_day_install",
      title: "Same-day installation",
      description: "Installation, startup, and customer handoff requirements.",
      kind: "todo",
      audience: "crew",
      crew_editable: true,
      assignment_policy: { schema_version: 1, mode: "any", allow_unassigned: true, rules: [] },
      icon: "fa-list-check",
      sort_order: 10,
      items: [
        { title: "Protect the work area and verify safe shutoff", item_type: "todo" },
        { title: "Install the authorized equipment and materials", item_type: "todo" },
        { title: "Complete startup and operational testing", item_type: "todo" },
        { title: "Clean the work area and complete customer walkthrough", item_type: "todo" }
      ]
    }],
    ...productionAssignmentConfiguration(true),
    work_plan: {
      title: "Same-Day Service Production",
      terminology: { phase: "Phase", stage: "Stage", task: "To-do", board: "Board" },
      metadata: { board_color: "#0f766e" },
      root_nodes: [{
        id: "same_day_production_phase",
        title: "Same-Day Service",
        terminology_key: "work.phase",
        completion_mode: "all_children",
        metadata: { color: "#0f766e", board_id: "same_day_service_production" },
        children: [
          { id: "perform_install_stage", title: "Install", terminology_key: "work.stage", completion_mode: "all_children", children: [
            { id: "perform_same_day_install", title: "Perform authorized installation", terminology_key: "work.task", actionable: true, show_in_todo_list: true, assigned_role_ids: ["sales_appointments"], metadata: { kind: "project_work" } }
          ] },
          { id: "closeout_stage", title: "Closeout", terminology_key: "work.stage", completion_mode: "all_children", depends_on: ["perform_install_stage"], children: [
            { id: "complete_same_day_visit", title: "Complete visit and customer handoff", terminology_key: "work.task", actionable: true, show_in_todo_list: true, assigned_role_ids: ["sales_appointments"], external_triggers: [{ event: "project.event.completed", transition: "completed", conditions: { "payload.event_type_default_id": "sales_appointment" } }] }
          ] }
        ]
      }]
    },
    metadata: {
      preset: true,
      preset_revision: 3,
      visit_workflow: {
        enabled: true,
        id: "same_day_production_visit",
        title: "Same-Day Installation",
        event_types: ["project_work"],
        steps: [
          { id: "en_route", title: "On my way", navigation_title: "En route", kind: "status", description: "Notify the customer before leaving for the job.", action: { label: "I'm on my way", transition: "en_route", notify: { channel: "sms", message: "Hi {{customer.name}}, {{technician.name}} is on the way to begin your installation at {{project.address}}." } } },
          { id: "arrived", title: "Arrive", navigation_title: "Arrived", kind: "status", description: "Confirm arrival and begin the installation visit.", action: { label: "I've arrived", transition: "arrived" } },
          { id: "install", title: "Complete the installation", navigation_title: "Install", kind: "checklist", description: "Complete every assigned installation and quality-control item." },
          { id: "payment", title: "Collect payment", navigation_title: "Payment", kind: "payment", description: "Review the balance and collect any amount due.", target_tab: "crew_payments" },
          { id: "signoff", title: "Customer sign-off", navigation_title: "Sign", kind: "workflow", description: "Complete any customer-facing completion document or signature.", target_tab: "crew_signatures" },
          { id: "finish", title: "Finish the visit", navigation_title: "Done", kind: "complete", description: "Close the visit after all required work is finished.", action: { label: "Complete visit", transition: "completed" } }
        ]
      }
    }
  };
}

function welcomeCallNode() {
  const removeBinding = (id: string) => ({ id, automation: "crm.callLists.remove.v1", input: {} });
  return {
    id: "welcome_call",
    title: "Welcome call",
    terminology_key: "work.task",
    actionable: true,
    automation_bindings: {
      onReady: [{
        id: "queue_welcome_call",
        automation: "crm.callLists.add.v1",
        explainer: "Newly signed customers are added to the Welcome Call queue so the office kicks off the relationship.",
        input: {
          list: {
            key: "new_customers",
            title: "New Customers",
            description: "Signed customers whose welcome call is ready.",
            kind: "signature",
            icon: "fa-handshake",
            tone: "customer",
            sort_order: 30,
            assigned_user_ids: [],
            assigned_role_ids: [],
            metadata: { purpose: "welcome_call", managed_by: "scope_automation" }
          },
          title: "Welcome call"
        }
      }],
      onCompleted: [removeBinding("remove_completed_welcome_call")],
      onSkipped: [removeBinding("remove_skipped_welcome_call")],
      onCanceled: [removeBinding("remove_canceled_welcome_call")]
    },
    metadata: { call_list_key: "new_customers", call_list_kind: "signature" }
  };
}

const FULL_PRODUCTION_STAGES = [
  {
    id: "contract_stage",
    title: "Contract",
    terminology_key: "work.stage",
    completion_mode: "all_children",
    children: [
      {
        id: "sign_proposal",
        title: "Sign proposal",
        terminology_key: "work.task",
        actionable: true,
        external_triggers: [{ event: "proposal.signed", transition: "completed" }]
      },
      {
        id: "deposit_paid",
        title: "Collect deposit",
        terminology_key: "work.task",
        actionable: false,
        show_in_todo_list: false,
        depends_on: ["sign_proposal"],
        external_triggers: [{ event: "payment.received", transition: "completed", conditions: { "payload.payment_kind": "deposit" } }],
        automation_bindings: {
          onCompleted: [{
            id: "reconcile_scope_resources_after_deposit",
            automation: "scopes.reconcileProjectResources.v1",
            input: {}
          }]
        }
      }
    ]
  },
  {
    id: "onboarding_stage",
    title: "Onboarding",
    terminology_key: "work.stage",
    completion_mode: "all_children",
    depends_on: ["contract_stage"],
    children: [
      welcomeCallNode(),
      { id: "schedule_with_customer", title: "Schedule project with customer", terminology_key: "work.task", actionable: true, depends_on: ["welcome_call"] }
    ]
  },
  {
    id: "scheduling_stage",
    title: "Scheduling",
    terminology_key: "work.stage",
    completion_mode: "all_children",
    depends_on: ["onboarding_stage"],
    children: [
      {
        id: "schedule_material_deliveries",
        title: "Schedule material deliveries",
        terminology_key: "work.group",
        completion_mode: "all_children",
        children: [
          {
            id: "schedule_dry_in_delivery",
            title: "Schedule dry-in delivery",
            terminology_key: "work.task",
            actionable: true,
            external_triggers: [{ event: "project.event_scheduled", transition: "completed", conditions: { "payload.event_type_default_id": "material_delivery_dry_in" } }]
          },
          {
            id: "schedule_shingle_delivery",
            title: "Schedule shingle delivery",
            terminology_key: "work.task",
            actionable: true,
            external_triggers: [{ event: "project.event_scheduled", transition: "completed", conditions: { "payload.event_type_default_id": "material_delivery_shingles" } }]
          }
        ]
      },
      {
        id: "schedule_crew_arrival",
        title: "Schedule crew arrival",
        terminology_key: "work.task",
        actionable: true,
        external_triggers: [{ event: "project.event_scheduled", transition: "completed", conditions: { "payload.event_kind": "project_work" } }]
      },
      { id: "schedule_disposal_equipment", title: "Schedule disposal equipment", terminology_key: "work.task", actionable: true }
    ]
  },
  {
    id: "production_stage",
    title: "Production",
    terminology_key: "work.stage",
    completion_mode: "all_children",
    depends_on: ["scheduling_stage"],
    children: [
      {
        id: "start_project",
        title: "Start project",
        terminology_key: "work.task",
        actionable: true,
        external_triggers: [{ event: "project.event.started", transition: "completed", conditions: { "payload.event_kind": "project_work" } }]
      },
      {
        id: "progress_payment",
        title: "Collect progress payment",
        terminology_key: "work.task",
        actionable: true,
        depends_on: ["start_project"],
        external_triggers: [{ event: "payment.received", transition: "completed", conditions: { "payload.payment_kind": "progress" } }]
      },
      {
        id: "finish_project",
        title: "Finish project",
        terminology_key: "work.task",
        actionable: true,
        depends_on: ["progress_payment"],
        external_triggers: [{ event: "project.event.completed", transition: "completed", conditions: { "payload.event_kind": "project_work" } }]
      }
    ]
  },
  {
    id: "closeout_stage",
    title: "Closeout",
    terminology_key: "work.stage",
    completion_mode: "all_children",
    depends_on: ["production_stage"],
    children: [
      {
        id: "final_payment",
        title: "Collect final payment",
        terminology_key: "work.task",
        actionable: true,
        external_triggers: [{ event: "payment.received", transition: "completed", conditions: { "payload.payment_kind": "final" } }]
      },
      { id: "thank_you_call", title: "Thank you call", terminology_key: "work.task", actionable: true, depends_on: ["final_payment"] }
    ]
  }
];

const ROOF_REPLACEMENT_STAGES = [
  {
    id: "signed_pending_payment_stage",
    title: "Pending Deposit",
    terminology_key: "work.stage",
    completion_mode: "all_children",
    children: [
      {
        id: "deposit_paid",
        title: "Collect deposit",
        terminology_key: "work.task",
        actionable: false,
        show_in_todo_list: false,
        automation_bindings: {
          onCompleted: [{
            id: "reconcile_scope_resources_after_deposit",
            automation: "scopes.reconcileProjectResources.v1",
            input: {}
          }, {
            id: "celebrate_roof_proposal_paid",
            automation: "notification.create.v1",
            explainer: "When the deposit is paid, the whole team gets a celebration announcement.",
            input: {
              id: "celebration_proposal_paid_{{project.id}}_{{payment.id}}",
              title: "Proposal paid",
              body: "{{project.customer_name}} paid {{payment.formatted_amount}}.",
              source: "scope.roof_replacement.proposal_paid_celebration",
              kind: "celebration",
              channel: "celebration",
              passive: true,
              manual_dismissible: false,
              celebration: {
                size: "large",
                reason: "proposal_paid",
                text: "{{project.customer_name}} paid {{payment.formatted_amount}}."
              },
              context: {
                proposal_id: "{{proposal.id}}",
                payment_id: "{{payment.id}}",
                amount_cents: "{{payment.amount_cents}}",
                celebration: {
                  size: "large",
                  reason: "proposal_paid",
                  text: "{{project.customer_name}} paid {{payment.formatted_amount}}."
                }
              }
            }
          }]
        },
        external_triggers: [{ event: "payment.received", transition: "completed", conditions: { "payload.payment_kind": "deposit" } }]
      }
    ]
  },
  {
    id: "newly_sold_stage",
    title: "Newly Sold",
    terminology_key: "work.stage",
    completion_mode: "all_children",
    depends_on: ["signed_pending_payment_stage"],
    children: [
      welcomeCallNode(),
      { id: "schedule_with_customer", title: "Schedule project with customer", terminology_key: "work.task", actionable: true }
    ]
  },
  {
    ...FULL_PRODUCTION_STAGES[2],
    id: "scheduled_stage",
    title: "Scheduled",
    depends_on: ["signed_pending_payment_stage"],
    children: [
      { id: "finalize_material_lists", title: "Finalize material lists", terminology_key: "work.task", actionable: true },
      { id: "order_materials", title: "Order materials", terminology_key: "work.task", actionable: true },
      ...(FULL_PRODUCTION_STAGES[2]?.children || []).filter((node) => node.id !== "schedule_disposal_equipment"),
      {
        id: "share_project_schedule_with_customer",
        title: "Share project schedule with customer",
        description: "Review the scheduled material deliveries and project work, then share the project schedule with the customer.",
        terminology_key: "work.task",
        actionable: true,
        show_in_todo_list: true,
        depends_on: ["schedule_material_deliveries", "schedule_crew_arrival"],
        metadata: {
          kind: "share_project_schedule_with_customer",
          frontend_action: { kind: "open_project_scheduling", tab: "schedule" }
        }
      }
    ]
  },
  {
    ...FULL_PRODUCTION_STAGES[3],
    id: "pre_production_stage",
    title: "Pre-Production",
    depends_on: ["newly_sold_stage", "scheduled_stage"],
    children: [
      ...(FULL_PRODUCTION_STAGES[3]?.children || []),
      // Hidden trigger nodes: they complete automatically when material
      // deliveries land and fan out role-assigned field to-dos.
      {
        id: "first_delivery_followups",
        title: "Materials delivered",
        terminology_key: "work.task",
        actionable: false,
        show_in_todo_list: false,
        external_triggers: [{ event: "material.delivery.completed", transition: "completed" }],
        automation_bindings: {
          onCompleted: [
            {
              id: "todo_confirm_delivery",
              automation: "work.createTodo.v1",
              explainer: "When materials are delivered, the crew gets a to-do to confirm the delivery arrived complete and undamaged.",
              input: {
                title: "Confirm materials were fully delivered",
                message: "Walk the delivery and confirm everything on the material list arrived undamaged.",
                assigned_role_ids: ["crew_member", "crew_foreman", "supervisor"],
                priority: 1,
                metadata: { kind: "confirm_material_delivery", frontend_action: { kind: "open_project", project_id: "{{project.id}}", tab: "crew_materials" } }
              }
            },
            {
              id: "todo_safety_checklist",
              automation: "work.createTodo.v1",
              input: {
                title: "Complete the safety checklist",
                message: "Work through the site safety checklist before production starts.",
                assigned_role_ids: ["crew_member", "crew_foreman"],
                metadata: { kind: "complete_safety_checklist", frontend_action: { kind: "open_project", project_id: "{{project.id}}", tab: "crew_checklists" } }
              }
            },
            {
              id: "todo_work_checklist",
              automation: "work.createTodo.v1",
              input: {
                title: "Complete the work and check off the work checklist",
                message: "Finish the scoped work and mark each item on the work checklist.",
                assigned_role_ids: ["crew_member", "crew_foreman"],
                metadata: { kind: "complete_work_checklist", frontend_action: { kind: "open_project", project_id: "{{project.id}}", tab: "crew_checklists" } }
              }
            },
            {
              id: "todo_collect_final_payment",
              automation: "work.createTodo.v1",
              input: {
                title: "Collect the final payment",
                message: "Complete the final walkthrough checklist and collect the remaining balance.",
                assigned_role_ids: ["office", "supervisor"],
                priority: 1,
                metadata: { kind: "collect_final_payment", frontend_action: { kind: "open_project", project_id: "{{project.id}}", tab: "crew_payments" } }
              }
            }
          ]
        }
      },
      {
        id: "second_delivery_followups",
        title: "Shingle delivery verified",
        terminology_key: "work.task",
        actionable: false,
        show_in_todo_list: false,
        external_triggers: [{ event: "material.delivery.completed", transition: "completed", conditions: { "payload.delivery_kind": "shingle" } }],
        automation_bindings: {
          onCompleted: [{
            id: "todo_verify_second_delivery",
            automation: "work.createTodo.v1",
            input: {
              title: "Verify the shingle delivery was fully received",
              message: "Check the shingle delivery against the material list before installation.",
              assigned_role_ids: ["crew_member", "crew_foreman", "supervisor"],
              metadata: { kind: "verify_second_delivery", frontend_action: { kind: "open_project", project_id: "{{project.id}}", tab: "crew_materials" } }
            }
          }]
        }
      }
    ]
  },
  {
    ...FULL_PRODUCTION_STAGES[4],
    id: "production_completed_stage",
    title: "Production Completed",
    depends_on: ["pre_production_stage"]
  }
];

const ROOFING_MATERIALS = {
  enabled: true,
  assignment: "first_match" as const,
  order_sources: [
    { id: "manual", name: "Manual Order", kind: "manual" as const, status: "active" as const },
    { id: "srs_distribution", name: "SRS Distribution", kind: "integration" as const, status: "coming_soon" as const, provider: "srs_distribution" },
    { id: "convoy_supply", name: "Convoy Supply", kind: "integration" as const, status: "coming_soon" as const, provider: "convoy_supply" }
  ],
  lists: [
    {
      id: "dry_in",
      title: "Dry-In",
      color: "#dc2626",
      selector: {
        match: "any" as const,
        pricebook_item_ids: [
          "underlayment", "ice_water", "gaf_weatherwatch", "owens_weatherlock",
          "drip_edge", "valley_metal", "pipe_boot", "step_flashing",
          "headwall_flashing", "sidewall_flashing"
        ],
        exclude_pricebook_item_ids: [
          "laminated_shingles", "three_tab_shingles", "gaf_hd", "owens_duration",
          "malarkey_vista", "starter", "ridge_cap", "ridge_vent"
        ],
        exclude_item_type_ids: ["field_shingles"],
        exclude_tags: ["shingle", "shingles"],
        tags: ["dry_in", "dry-in"]
      },
      schedule: {
        enabled: true,
        event_type_default_id: "material_delivery_dry_in",
        title: "Dry-In",
        kind: "material_delivery",
        icon: "fa-truck-ramp-box",
        color: "#7c3aed",
        source_node_template_id: "schedule_dry_in_delivery",
        lock_on_order: true,
        group_id: "roof_installation",
        group_title: "Roof Installation",
        rule: {
          version: 1,
          bundle: { key: "roof_replacement", role: "dependent", item_key: "dry_in", anchor_item_key: "roofing_labor" },
          relative_start: { anchor: "start", offset: { value: -1, unit: "business_day" } },
          default_duration: { value: 1, unit: "day" },
          all_day: true
        }
      },
      order_source_ids: ["manual", "srs_distribution", "convoy_supply"],
      metadata: {
        pricebook_links: [
          "underlayment", "ice_water", "gaf_weatherwatch", "owens_weatherlock",
          "drip_edge", "valley_metal", "pipe_boot", "step_flashing",
          "headwall_flashing", "sidewall_flashing"
        ]
      }
    },
    {
      id: "shingle",
      title: "Shingle",
      color: "#f97316",
      selector: {
        match: "any" as const,
        pricebook_item_ids: [
          "laminated_shingles", "three_tab_shingles", "gaf_hd", "owens_duration",
          "malarkey_vista", "starter", "ridge_cap", "ridge_vent"
        ],
        item_type_ids: ["field_shingles"],
        exclude_pricebook_item_ids: [
          "underlayment", "ice_water", "gaf_weatherwatch", "owens_weatherlock",
          "drip_edge", "valley_metal", "pipe_boot", "step_flashing",
          "headwall_flashing", "sidewall_flashing"
        ],
        exclude_tags: ["dry_in", "dry-in"],
        tags: ["shingle", "shingles"]
      },
      schedule: {
        enabled: true,
        event_type_default_id: "material_delivery_shingles",
        title: "Shingle",
        kind: "material_delivery",
        icon: "fa-truck-ramp-box",
        color: "#7c3aed",
        source_node_template_id: "schedule_shingle_delivery",
        lock_on_order: true,
        group_id: "roof_installation",
        group_title: "Roof Installation",
        rule: {
          version: 1,
          bundle: { key: "roof_replacement", role: "dependent", item_key: "shingle", anchor_item_key: "roofing_labor" },
          relative_start: {
            anchor: "start",
            offset: {
              unit: "day",
              expression: {
                operator: "floor",
                value: {
                  operator: "divide",
                  left: { operator: "subtract", left: { ref: "anchor.duration.days" }, right: 1 },
                  right: 2
                }
              },
              adjust: { calendar: "business_day", direction: "previous" }
            }
          },
          default_duration: { value: 1, unit: "day" },
          all_day: true
        }
      },
      order_source_ids: ["manual", "srs_distribution", "convoy_supply"],
      metadata: {
        pricebook_links: [
          "laminated_shingles", "three_tab_shingles", "gaf_hd", "owens_duration",
          "malarkey_vista", "starter", "ridge_cap", "ridge_vent"
        ]
      }
    }
  ],
  metadata: { industry: "roofing", generated_from: "signed_scope" }
};

const ROOFING_SCOPE_RESOURCES = {
  enabled: true,
  terminology: {
    tab: { singular: "Scope", plural: "Scope" },
    material: { singular: "Material", plural: "Materials", list: "Material list" },
    labor: { singular: "Labor", plural: "Labor", list: "Labor work order" },
    equipment: { singular: "Equipment", plural: "Equipment", list: "Equipment list" }
  },
  types: {
    material: { icon: "fa-boxes-stacked", capabilities: ["items", "ordering", "scheduling"] },
    labor: { icon: "fa-helmet-safety", capabilities: ["items", "crew_assignment", "compensation", "scheduling"] },
    equipment: { icon: "fa-truck-ramp-box", capabilities: ["items", "scheduling_optional"] }
  },
  lists: [
    ...ROOFING_MATERIALS.lists.map((list) => ({ ...list, resource_type: "material" as const })),
    {
      id: "roofing_labor",
      resource_type: "labor" as const,
      title: "Roofing Labor",
      color: "#2563eb",
      items: [
        { id: "shingle_installation", name: "Shingle installation", unit: "sq", quantity: 0, projected_unit_price: 85, metadata: { estimate_mode: "piece_rate", compensation_kind: "piece_rate", quantity_measurements: ["shingleSquares", "slopeSquares", "roofSquares"], omit_when_zero: true } },
        { id: "roof_tear_off", name: "Roof tear-off", unit: "sq", quantity: 0, projected_unit_price: 40, metadata: { estimate_mode: "piece_rate", compensation_kind: "piece_rate", quantity_measurement: "roofSquares", omit_when_zero: true } },
        { id: "flat_roof_installation", name: "Flat roof installation", unit: "sq", quantity: 0, projected_unit_price: 110, metadata: { estimate_mode: "piece_rate", compensation_kind: "piece_rate", quantity_measurement: "flatRoofSquares", omit_when_zero: true } },
        { id: "steep_slope_9_12", name: "Steep-slope premium (9/12-12/12)", unit: "sq", quantity: 0, projected_unit_price: 25, metadata: { estimate_mode: "piece_rate", compensation_kind: "piece_rate", quantity_measurement: "pitch9to12Squares", omit_when_zero: true } },
        { id: "steep_slope_13_plus", name: "Extreme-slope premium (13/12+)", unit: "sq", quantity: 0, projected_unit_price: 50, metadata: { estimate_mode: "piece_rate", compensation_kind: "piece_rate", quantity_measurement: "pitch13PlusSquares", omit_when_zero: true } },
        { id: "ridge_installation", name: "Ridge installation", unit: "lf", quantity: 0, projected_unit_price: 2.5, metadata: { estimate_mode: "piece_rate", compensation_kind: "piece_rate", quantity_measurement: "ridgesLf", omit_when_zero: true } },
        { id: "hip_installation", name: "Hip installation", unit: "lf", quantity: 0, projected_unit_price: 2.5, metadata: { estimate_mode: "piece_rate", compensation_kind: "piece_rate", quantity_measurement: "hipsLf", omit_when_zero: true } },
        { id: "valley_installation", name: "Valley installation", unit: "lf", quantity: 0, projected_unit_price: 3.5, metadata: { estimate_mode: "piece_rate", compensation_kind: "piece_rate", quantity_measurement: "valleyLf", omit_when_zero: true } }
      ],
      controls: { crew_assignment: true, compensation: true },
      compensation: {
        allowed_modes: ["hourly", "piece_rate", "hybrid", "none"],
        mode: "piece_rate",
        default_mode: "piece_rate",
        allow_override: true,
        estimated_hours: 0,
        salary_expense_mode: "ignore"
      },
      schedule: {
        enabled: true,
        event_type_default_id: "project_work",
        title: "Roofing Labor",
        kind: "project_work",
        icon: "fa-helmet-safety",
        color: "#2563eb",
        source_node_template_id: "schedule_crew_arrival",
        group_id: "roof_installation",
        group_title: "Roof Installation",
        depends_on: [{ list_id: "dry_in", type: "finish_to_start" as const }],
        rule: {
          version: 1,
          bundle: { key: "roof_replacement", role: "primary", item_key: "roofing_labor" },
          reschedule: { cascade: "prompt", include_roles: ["dependent"] },
          default_duration: {
            unit: "day",
            minimum: 1,
            expression: {
              operator: "ceil",
              value: { operator: "divide", left: { ref: "project.measurements.roofSquares" }, right: 20 }
            }
          },
          all_day: true
        }
      }
    },
    {
      id: "roofing_equipment",
      resource_type: "equipment" as const,
      title: "Roofing Equipment",
      color: "#0f766e",
      items: [
        { id: "disposal_trailer", name: "Disposal trailer", unit: "ea", quantity: 1 },
        { id: "portable_toilet", name: "Portable toilet", unit: "ea", quantity: 1 },
        { id: "project_truck", name: "Truck", unit: "ea", quantity: 1 }
      ],
      // Generation still consults the org's equipment.scheduling capability:
      // orgs without it keep the suppressed legacy behavior.
      controls: { scheduling: true },
      schedule: { enabled: true, kind: "equipment", icon: "fa-truck-pickup", color: "#0f766e", title: "Roofing Equipment" }
    }
  ],
  order_sources: ROOFING_MATERIALS.order_sources,
  extension_points: [
    { id: "resource_list.controls", target: "list" },
    { id: "resource_item.controls", target: "item" },
    { id: "resource_list.actions", target: "actions" }
  ],
  metadata: { industry: "roofing", generated_from: "signed_scope", schema: "scope_resources.v1" }
};

const ROOF_REPLACEMENT_COMMISSIONS = {
  enabled: true,
  roles: [
    {
      key: "estimator",
      label: "Estimator",
      assignment_source: "project_custom_field" as const,
      custom_field_path: "assignments.estimator",
      metadata: { stable_role: true, description: "The person assigned to the sales appointment." }
    },
    {
      key: "inside_salesperson",
      label: "Inside Salesperson",
      assignment_source: "project_custom_field" as const,
      custom_field_path: "assignments.inside_salesperson",
      metadata: { stable_role: true, description: "The person who scheduled the sales appointment." }
    }
  ],
  rules: [
    {
      id: "roof_estimator_standard",
      title: "Estimator — 10% of project revenue",
      enabled: true,
      payee_role: "estimator",
      entry_state: "projected" as const,
      allocation: "split_evenly" as const,
      trigger: { hook: "onStarted" as const },
      installments: [
        { id: "deposit", title: "First half when deposit is paid", share_bps: 5_000, recognition: { node_id: "deposit_paid", hook: "onCompleted" as const } },
        { id: "completion", title: "Second half when job is completed", share_bps: 5_000, recognition: { node_id: "finish_project", hook: "onCompleted" as const } }
      ],
      calculation: { mode: "preset" as const, preset: "percentage" as const, basis: "proposal_total" as const, rate_bps: 1_000 },
      metadata: { commission_total_rate_bps: 1_000, summary: "10% of total project revenue, paid in two equal installments." }
    },
    {
      id: "roof_inside_sales_standard",
      title: "Inside Salesperson — $100 booking commission",
      enabled: true,
      payee_role: "inside_salesperson",
      entry_state: "projected" as const,
      allocation: "each" as const,
      trigger: { hook: "onStarted" as const },
      installments: [
        { id: "deposit", title: "Paid when deposit is paid", share_bps: 10_000, recognition: { node_id: "deposit_paid", hook: "onCompleted" as const } }
      ],
      calculation: { mode: "preset" as const, preset: "fixed" as const, fixed_amount_cents: 10_000 },
      metadata: { summary: "$100 when the customer deposit is paid." }
    }
  ],
  metadata: { preset: "standard_roof_replacement_commissions_v1" }
};

// Default field checklists instantiated for every project created from this
// scope. Safety and work go to the crew; the completion quality review goes to
// the supervisor role and is rated green/yellow/red instead of checked off.
function scopeChecklists(templateId: string) {
  const roofing = templateId === "roof_replacement";
  const safetyItems = roofing
    ? [
      { title: "Ladders set, footed, and tied off" },
      { title: "Harnesses and fall protection in use on the roof" },
      { title: "Ground drop zones flagged and clear" },
      { title: "Power lines identified and kept clear" },
      { title: "Landscaping, AC units, and driveway protected" }
    ]
    : [
      { title: "Work area walked and hazards identified" },
      { title: "Ladders and equipment inspected" },
      { title: "Required protective equipment in use" },
      { title: "Customer property protected" }
    ];
  const workItems = roofing
    ? [
      { title: "Materials received and staged" },
      { title: "Existing conditions photographed" },
      { title: "Tear-off complete and decking inspected" },
      { title: "Underlayment, flashing, and vents installed" },
      { title: "Shingles installed per manufacturer spec" },
      { title: "Job site cleaned and magnet-swept" },
      { title: "Completion photos uploaded" }
    ]
    : [
      { title: "Materials received and staged" },
      { title: "Existing conditions photographed" },
      { title: "Scope of work completed" },
      { title: "Job site cleaned up" },
      { title: "Completion photos uploaded" }
    ];
  const completionItems = roofing
    ? [
      { title: "Overall workmanship", item_type: "rating" as const },
      { title: "Flashing and penetration detail", item_type: "rating" as const },
      { title: "Ridge, valley, and edge lines", item_type: "rating" as const },
      { title: "Site cleanup and nail sweep", item_type: "rating" as const },
      { title: "Customer walkthrough completed", item_type: "rating" as const }
    ]
    : [
      { title: "Overall workmanship", item_type: "rating" as const },
      { title: "Detail and finish quality", item_type: "rating" as const },
      { title: "Site cleanup and protection", item_type: "rating" as const },
      { title: "Customer walkthrough completed", item_type: "rating" as const }
    ];
  return [
    {
      id: "safety",
      title: "Safety checklist",
      description: "Site safety items the crew confirms before and during work.",
      kind: "todo" as const,
      audience: "crew" as const,
      crew_editable: false,
      assignment_policy: {
        schema_version: 1,
        mode: "any" as const,
        allow_unassigned: true,
        rules: [
          { id: "production_crews", subject_types: ["resource_group"], group_kind_ids: ["crew"] },
          { id: "field_people", subject_types: ["organization_user"], role_ids: ["crew_member", "crew_foreman"] }
        ]
      },
      icon: "fa-helmet-safety",
      sort_order: 10,
      items: safetyItems
    },
    {
      id: "work",
      title: "Work checklist",
      description: "Production items the crew completes during the job.",
      kind: "todo" as const,
      audience: "crew" as const,
      crew_editable: true,
      assignment_policy: {
        schema_version: 1,
        mode: "any" as const,
        allow_unassigned: true,
        rules: [
          { id: "production_crews", subject_types: ["resource_group"], group_kind_ids: ["crew"] },
          { id: "field_people", subject_types: ["organization_user"], role_ids: ["crew_member", "crew_foreman"] }
        ]
      },
      icon: "fa-list-check",
      sort_order: 20,
      items: workItems
    },
    {
      id: "completion",
      title: "Completion checklist",
      description: "Supervisor quality review after the crew finishes.",
      kind: "quality" as const,
      audience: "supervisor" as const,
      crew_editable: false,
      assignment_policy: {
        schema_version: 1,
        mode: "any" as const,
        allow_unassigned: true,
        rules: [
          { id: "supervisors", subject_types: ["organization_user"], role_ids: ["supervisor"] }
        ]
      },
      icon: "fa-clipboard-check",
      sort_order: 30,
      items: completionItems
    }
  ];
}

// Maps proposal scope-piece types onto the template that owns them. This is
// preset data, not engine code: a new industry ships templates whose
// `proposal.piece_types` cover its own piece vocabulary.
const PRESET_PIECE_TYPES: Record<string, string[]> = {
  roof_replacement: ["roof_replacement", "full_roof", "partial_roof"],
  repairs: ["repairs", "roof_repair"],
  maintenance: ["maintenance"],
  gutters: ["gutters", "gutter_replacement"],
  siding_replacement: ["siding_replacement"],
  manual: ["manual"]
};

function replacementTemplate(input: Pick<ScopeTemplateDefinition, "id" | "name" | "description" | "details" | "color" | "icon">): ScopeTemplateDefinition {
  return {
    schema_version: 1,
    ...input,
    kind: "production",
    status: "active",
    proposal: { kind: input.id, supports_structures: true, piece_types: PRESET_PIECE_TYPES[input.id] || [input.id] },
    fields: [
      { id: "section_name", type: "text", label: "Section Name", required: true },
      { id: "structures", type: "structures", label: "Structures" }
    ],
    ...productionAssignmentConfiguration(input.id === "roof_replacement"),
    ...(input.id === "roof_replacement" ? { materials: ROOFING_MATERIALS, resources: ROOFING_SCOPE_RESOURCES, commissions: ROOF_REPLACEMENT_COMMISSIONS } : {}),
    checklists: scopeChecklists(input.id),
    work_plan: {
      title: input.name,
      terminology: { phase: "Phase", stage: "Stage", task: "To-do", board: "Board" },
      automation_bindings: input.id === "roof_replacement" ? {
        "proposal.payment.received": [{
          id: "notify_roof_proposal_payment_received",
          automation: "notification.create.v1",
          input: {
            id: "notification_proposal_payment_{{project.id}}_{{payment.id}}",
            title: "{{project.customer_name}} proposal payment received",
            body: "{{payment.label}}: {{payment.formatted_amount}} - {{project.address}}",
            source: "scope.roof_replacement.proposal_paid",
            kind: "passive",
            channel: "passive",
            passive: true,
            manual_dismissible: true,
            frontend_action: {
              kind: "open_project",
              project_id: "{{project.id}}"
            },
            context: {
              proposal_id: "{{proposal.id}}",
              snapshot_id: "{{proposal.snapshot_id}}",
              payment_id: "{{payment.id}}",
              payment_kind: "{{event.payload.payment_kind}}",
              amount_cents: "{{payment.amount_cents}}",
              scope_piece_id: "{{scope.id}}"
            }
          }
        }]
      } : {},
      metadata: input.id === "roof_replacement" ? {
        board_color: input.color,
        canceled_column: { id: "cancelled", title: "Cancelled", color: "#667085" },
        legacy_stage_aliases: {
          contract_stage: "signed_pending_payment_stage",
          onboarding_stage: "newly_sold_stage",
          scheduling_stage: "scheduled_stage",
          production_stage: "pre_production_stage",
          closeout_stage: "production_completed_stage"
        }
      } : { board_color: input.color },
      root_nodes: [{
        id: `${input.id}_phase`,
        title: input.name,
        terminology_key: "work.phase",
        completion_mode: "all_children",
        automation_bindings: input.id === "roof_replacement" ? {
          onStarted: [{
            id: "notify_roof_proposal_signed",
            automation: "notification.create.v1",
            input: {
              title: "{{project.customer_name}} proposal signed",
              body: "{{project.address}}",
              source: "scope.roof_replacement.proposal_signed",
              kind: "passive",
              channel: "passive",
              passive: true,
              manual_dismissible: true,
              frontend_action: {
                kind: "open_project",
                project_id: "{{project.id}}"
              },
              context: {
                proposal_id: "{{proposal.id}}",
                snapshot_id: "{{proposal.snapshot_id}}",
                scope_piece_id: "{{scope.id}}"
              }
            }
          }]
        } : {},
        children: input.id === "roof_replacement" ? ROOF_REPLACEMENT_STAGES : FULL_PRODUCTION_STAGES
      }]
    },
    metadata: { preset: true, preset_revision: input.id === "roof_replacement" ? 33 : 12 }
  };
}

function serviceTemplate(input: Pick<ScopeTemplateDefinition, "id" | "name" | "description" | "details" | "color" | "icon">): ScopeTemplateDefinition {
  return {
    schema_version: 1,
    ...input,
    kind: "production",
    status: "active",
    proposal: { kind: input.id, piece_types: PRESET_PIECE_TYPES[input.id] || [input.id], ...(input.id === "manual" ? { fallback: true } : {}) },
    fields: [{ id: "section_name", type: "text", label: "Section Name", required: true }],
    ...productionAssignmentConfiguration(),
    checklists: scopeChecklists(input.id),
    work_plan: {
      title: input.name,
      terminology: { phase: "Phase", stage: "Stage", task: "To-do", board: "Board" },
      root_nodes: [{
        id: `${input.id}_phase`,
        title: input.name,
        terminology_key: "work.phase",
        completion_mode: "all_children",
        children: [
          {
            id: "service_contract_stage",
            title: "Contract",
            terminology_key: "work.stage",
            completion_mode: "all_children",
            children: [{
              id: "sign_proposal",
              title: "Sign proposal",
              terminology_key: "work.task",
              actionable: true,
              external_triggers: [{ event: "proposal.signed", transition: "completed" }]
            }]
          },
          {
            id: "service_scheduling_stage",
            title: "Scheduling",
            terminology_key: "work.stage",
            completion_mode: "all_children",
            depends_on: ["service_contract_stage"],
            children: [
              welcomeCallNode(),
              {
                id: "schedule_service",
                title: "Schedule service",
                terminology_key: "work.task",
                actionable: true,
                depends_on: ["welcome_call"],
                external_triggers: [{ event: "project.event_scheduled", transition: "completed", conditions: { "payload.event_kind": "project_work" } }]
              }
            ]
          },
          {
            id: "service_work_stage",
            title: "Service",
            terminology_key: "work.stage",
            completion_mode: "all_children",
            depends_on: ["service_scheduling_stage"],
            children: [
              {
                id: "service_arrival",
                title: "Service professional arrives",
                terminology_key: "work.task",
                actionable: true,
                external_triggers: [{ event: "project.event.started", transition: "completed", conditions: { "payload.event_kind": "project_work" } }]
              },
              {
                id: "service_paid",
                title: "Project paid and closed out",
                terminology_key: "work.task",
                actionable: true,
                depends_on: ["service_arrival"],
                external_triggers: [{ event: "payment.received", transition: "completed" }]
              },
              { id: "thank_you_call", title: "Thank you call", terminology_key: "work.task", actionable: true, depends_on: ["service_paid"] }
            ]
          }
        ]
      }]
    },
    metadata: { preset: true, preset_revision: 12 }
  };
}

// ---------------------------------------------------------------------------
// Kitchen Remodel — interior remodel with allowances and phase-gated customer
// material selections. The base estimate is a DOCUMENT (sign + deposit); the
// later selections are a WORKFLOW-only document whose signed upgrade delta
// appends to the payment schedule. Both are ordinary documents.issue.v1
// bindings — the pairing lives in template data, not engine code.
// ---------------------------------------------------------------------------

const KITCHEN_BASE_SCOPE_ITEMS = [
  {
    id: "kit_base",
    name: "Kitchen Remodel — Base Scope",
    quantity: 1,
    unit: "job",
    unit_price: 0,
    children: [
      { id: "kit_demo", name: "Demolition & disposal", quantity: 1, unit: "job", unit_price: 3200 },
      { id: "kit_cabinet_install", name: "Cabinet installation labor", quantity: 1, unit: "job", unit_price: 4800 },
      { id: "kit_plumbing", name: "Plumbing rough-in & fixture set", quantity: 1, unit: "job", unit_price: 3600 },
      { id: "kit_electrical", name: "Electrical: lighting, outlets & code updates", quantity: 1, unit: "job", unit_price: 2900 },
      { id: "kit_drywall", name: "Drywall repair & paint", quantity: 1, unit: "job", unit_price: 2100 }
    ]
  },
  {
    id: "kit_allowances",
    name: "Allowances (your selections come later)",
    quantity: 1,
    unit: "job",
    unit_price: 0,
    children: [
      { id: "alw_flooring", name: "Flooring allowance", description: "Standard selection fully covered; upgrades are billed as a selections adjustment.", quantity: 1, unit: "job", unit_price: 3500 },
      { id: "alw_counters", name: "Countertop allowance", quantity: 1, unit: "job", unit_price: 2800 },
      { id: "alw_backsplash", name: "Backsplash tile allowance", quantity: 1, unit: "job", unit_price: 900 },
      { id: "alw_hardware", name: "Cabinet & fixture hardware allowance", quantity: 1, unit: "job", unit_price: 600 }
    ]
  }
];

const KITCHEN_SELECTION_SCOPE_ITEMS = [
  {
    id: "sel_flooring",
    name: "Flooring",
    quantity: 1,
    unit: "job",
    unit_price: 0,
    selection_groups: [{ id: "grp_flooring", title: "Flooring — allowance $3,500", behavior: "single" }],
    children: [
      { id: "floor_oak", name: "Engineered oak — allowance standard", description: "Fully covered by your flooring allowance.", quantity: 1, unit: "job", unit_price: 0, selection: { mode: "choice", group_id: "grp_flooring", selectable_by: ["customer"], selected: true } },
      { id: "floor_lvp", name: "Luxury vinyl plank — allowance standard", description: "Also fully covered by your allowance.", quantity: 1, unit: "job", unit_price: 0, selection: { mode: "choice", group_id: "grp_flooring", selectable_by: ["customer"], selected: false } },
      { id: "floor_walnut", name: "Site-finished walnut (+$2,400)", description: "Upgrade over the flooring allowance.", quantity: 1, unit: "job", unit_price: 2400, selection: { mode: "choice", group_id: "grp_flooring", selectable_by: ["customer"], selected: false } },
      { id: "floor_tile_heated", name: "Porcelain tile with heated floor (+$4,850)", description: "Upgrade over the flooring allowance.", quantity: 1, unit: "job", unit_price: 4850, selection: { mode: "choice", group_id: "grp_flooring", selectable_by: ["customer"], selected: false } }
    ]
  },
  {
    id: "sel_counters",
    name: "Countertops",
    quantity: 1,
    unit: "job",
    unit_price: 0,
    selection_groups: [{ id: "grp_counters", title: "Countertops — allowance $2,800", behavior: "single" }],
    children: [
      { id: "counter_granite", name: "Granite (level 1) — allowance standard", description: "Fully covered by your countertop allowance.", quantity: 1, unit: "job", unit_price: 0, selection: { mode: "choice", group_id: "grp_counters", selectable_by: ["customer"], selected: true } },
      { id: "counter_quartz", name: "Quartz (+$1,650)", description: "Upgrade over the countertop allowance.", quantity: 1, unit: "job", unit_price: 1650, selection: { mode: "choice", group_id: "grp_counters", selectable_by: ["customer"], selected: false } },
      { id: "counter_marble", name: "Honed marble (+$3,900)", description: "Upgrade over the countertop allowance.", quantity: 1, unit: "job", unit_price: 3900, selection: { mode: "choice", group_id: "grp_counters", selectable_by: ["customer"], selected: false } }
    ]
  },
  {
    id: "sel_extras",
    name: "Optional add-ons",
    quantity: 1,
    unit: "job",
    unit_price: 0,
    children: [
      { id: "extra_pot_filler", name: "Pot filler rough-in (+$780)", quantity: 1, unit: "job", unit_price: 780, selection: { mode: "optional", selectable_by: ["customer"], selected: false } },
      { id: "extra_under_cabinet", name: "Under-cabinet lighting (+$540)", quantity: 1, unit: "job", unit_price: 540, selection: { mode: "optional", selectable_by: ["customer"], selected: false } }
    ]
  }
];

function kitchenRemodelTemplate(): ScopeTemplateDefinition {
  return {
    schema_version: 1,
    id: "kitchen_remodel",
    kind: "production",
    name: "Kitchen Remodel",
    description: "Interior kitchen remodel: allowance-based estimate, customer material selections from the portal, phase-gated finishes.",
    details: "The base estimate carries allowance line items and is signed as a document with a deposit. Material selections are issued later as a portal workflow; signed upgrades append to the payment schedule and unblock finish work.",
    color: "#9333ea",
    icon: "fa-kitchen-set",
    status: "active",
    proposal: { kind: "kitchen_remodel", selectable: false },
    fields: [{ id: "section_name", type: "text", label: "Section Name", required: false }],
    work_plan: {
      title: "Kitchen Remodel",
      terminology: { phase: "Phase", stage: "Stage", task: "To-do", board: "Board" },
      metadata: { board_color: "#9333ea" },
      root_nodes: [{
        id: "kitchen_phase",
        title: "Kitchen Remodel",
        terminology_key: "work.phase",
        completion_mode: "all_children",
        children: [
          {
            id: "kitchen_contract_stage",
            title: "Contract & Allowances",
            terminology_key: "work.stage",
            completion_mode: "all_children",
            children: [{
              id: "kitchen_send_estimate",
              title: "Base estimate signed & deposit paid",
              terminology_key: "work.task",
              actionable: true,
              automation_bindings: {
                onReady: [{
                  id: "issue_kitchen_estimate",
                  automation: "documents.issue.v1",
                  explainer: "Issue the allowance-based base estimate to the customer portal.",
                  input: {
                    template_id: "tpl_kitchen_estimate",
                    deliver: "portal",
                    title: "Kitchen Remodel Estimate",
                    params: {
                      scope_items: KITCHEN_BASE_SCOPE_ITEMS,
                      tax_percent: 0,
                      // Allowance math must be exact — no seeded card-fee /
                      // early-signing adjustments on remodel contracts.
                      pricing_adjustments: [],
                      deposit_cents: 732000,
                      payment_schedule: [
                        { id: "row_deposit", label: "Deposit", kind: "percent", percent_bps: 3000, payment_kind: "deposit", due_rule: "on_signature" },
                        { id: "row_rough_in", label: "Rough-in draw", kind: "percent", percent_bps: 4000, payment_kind: "progress", due_rule: "on_invoice" },
                        { id: "row_final", label: "Final payment", kind: "percent", percent_bps: 3000, payment_kind: "final", due_rule: "project_completion" }
                      ]
                    }
                  }
                }]
              },
              external_triggers: [{
                event: "document.signed",
                transition: "completed",
                conditions: { "payload.template_id": "tpl_kitchen_estimate" },
                explainer: "Completes when the customer signs the base estimate"
              }],
              metadata: { frontend_action: { kind: "open_project", tab: "signatures" } }
            }]
          },
          {
            id: "kitchen_construction_stage",
            title: "Demo & Rough-In",
            terminology_key: "work.stage",
            completion_mode: "all_children",
            depends_on: ["kitchen_contract_stage"],
            children: [
              { id: "kitchen_demo", title: "Demolition & disposal", terminology_key: "work.task", actionable: true },
              { id: "kitchen_rough_in", title: "Plumbing & electrical rough-in", terminology_key: "work.task", actionable: true, depends_on: ["kitchen_demo"] },
              { id: "kitchen_drywall", title: "Drywall & paint", terminology_key: "work.task", actionable: true, depends_on: ["kitchen_rough_in"] }
            ]
          },
          {
            id: "kitchen_selections_stage",
            title: "Material Selections",
            terminology_key: "work.stage",
            completion_mode: "all_children",
            depends_on: ["kitchen_contract_stage"],
            children: [{
              id: "kitchen_collect_selections",
              title: "Customer finish selections approved",
              terminology_key: "work.task",
              actionable: true,
              automation_bindings: {
                onReady: [{
                  id: "issue_kitchen_selections",
                  automation: "documents.issue.v1",
                  explainer: "Issue the allowance selections workflow to the customer portal.",
                  input: {
                    template_id: "tpl_kitchen_selections",
                    workflow_id: "wfl_kitchen_selections",
                    deliver: "portal",
                    title: "Kitchen Finish Selections",
                    params: {
                      reason: "Allowance selections for finish materials",
                      scope_items: KITCHEN_SELECTION_SCOPE_ITEMS,
                      tax_percent: 0,
                      pricing_adjustments: [],
                      payment_schedule: [
                        { id: "row_selection_delta", label: "Selection upgrades", kind: "percent", percent_bps: 10000, payment_kind: "change_order", due_rule: "on_invoice" }
                      ]
                    }
                  }
                }],
                onCompleted: [{
                  id: "notify_kitchen_selections_signed",
                  automation: "notification.create.v1",
                  input: {
                    title: "Kitchen selections approved",
                    body: "The customer signed their finish selections — finish work is unblocked. {{project.address}}",
                    source: "scope.kitchen_remodel.selections_signed",
                    kind: "passive",
                    channel: "passive",
                    passive: true,
                    manual_dismissible: true,
                    frontend_action: { kind: "open_project", project_id: "{{project.id}}", tab: "signatures" }
                  }
                }]
              },
              external_triggers: [{
                event: "document.signed",
                transition: "completed",
                conditions: { "payload.template_id": "tpl_kitchen_selections" },
                explainer: "Completes when the customer signs their selections"
              }],
              metadata: { frontend_action: { kind: "open_project", tab: "signatures" } }
            }]
          },
          {
            id: "kitchen_finishes_stage",
            title: "Finishes",
            terminology_key: "work.stage",
            completion_mode: "all_children",
            depends_on: ["kitchen_selections_stage", "kitchen_construction_stage"],
            children: [
              { id: "kitchen_install_finishes", title: "Install flooring, counters & selected finishes", terminology_key: "work.task", actionable: true },
              { id: "kitchen_final_walkthrough", title: "Final walkthrough & punch items", terminology_key: "work.task", actionable: true, depends_on: ["kitchen_install_finishes"] }
            ]
          }
        ]
      }]
    },
    metadata: {
      preset: true,
      preset_revision: 1,
      field_launch: {
        enabled: true,
        title: "Kitchen Remodel",
        description: "Allowance-based estimate, customer material selections from the portal, and phase-gated finish work.",
        category: "Remodeling",
        icon: "fa-kitchen-set",
        keywords: ["kitchen", "remodel", "interior", "allowance", "selections", "cabinets", "countertops"],
        frequent: false
      }
    }
  };
}

export const DEFAULT_SCOPE_TEMPLATES: ScopeTemplateDefinition[] = [
  kitchenRemodelTemplate(),
  salesPipelineTemplate(),
  roofingSalesAppointmentTemplate(),
  sameDayServiceSalesTemplate(),
  sameDayServiceProductionTemplate(),
  replacementTemplate({
    id: "roof_replacement",
    name: "Roof Replacement",
    description: "Full or partial roof replacement by structure.",
    details: "Includes tear-off and replacement work, material deliveries, crew scheduling, payments, and closeout.",
    color: "#dc2626",
    icon: "fa-house"
  }),
  serviceTemplate({
    id: "repairs",
    name: "Repairs",
    description: "Repair work with a streamlined service workflow.",
    details: "Designed for diagnosis, scheduling, repair completion, payment, and follow-up.",
    color: "#eab308",
    icon: "fa-screwdriver-wrench"
  }),
  serviceTemplate({
    id: "maintenance",
    name: "Maintenance",
    description: "Inspections, cleaning, sealing, and recurring upkeep.",
    details: "A lightweight service workflow for maintenance work.",
    color: "#0f766e",
    icon: "fa-clipboard-check"
  }),
  replacementTemplate({
    id: "gutters",
    name: "Gutters",
    description: "Gutter replacement and installation.",
    details: "Includes materials, installation scheduling, production, and closeout.",
    color: "#2563eb",
    icon: "fa-water"
  }),
  replacementTemplate({
    id: "siding_replacement",
    name: "Siding Replacement",
    description: "Exterior siding replacement by structure or wall area.",
    details: "Includes materials, crew scheduling, installation, and closeout.",
    color: "#16a34a",
    icon: "fa-building"
  }),
  serviceTemplate({
    id: "manual",
    name: "Manual",
    description: "A flexible scope for unusual work.",
    details: "Starts with a minimal workflow that can be adjusted for the project.",
    color: "var(--primary,#d93025)",
    icon: "fa-pen-ruler"
  })
];
