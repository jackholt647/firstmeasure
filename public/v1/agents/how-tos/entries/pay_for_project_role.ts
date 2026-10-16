import type { HowToEntry } from "../types.js";

// Steps 1 and 2 are exercised end to end in tests/agent-how-to-index.test.ts.
// Step 3 is the pay rule pattern of docs/architecture/pay-rules.md ("Who is paid
// for a role on a project"); the sample rules in payroll/sample-pay-rules.ts use it.
export const payForProjectRole: HowToEntry = {
  id: "pay_for_project_role",
  title: "Pay someone for a role they played on a project",
  use_when: "The user wants a person or other assignee paid for a role on each project, such as whoever booked the appointment, took the call or sold the job.",
  keywords: ["commission", "bonus", "spiff", "booked by", "setter", "payee", "pay rule", "pay plan"],
  steps: [
    {
      title: "Add a project field for the role",
      detail: "Add the field to the scope template's custom_fields.fields, for example {path:\"booked_by\", label:\"Booked by\", type:\"organization_user\"}. Use organization_user when exactly one accountable person holds the role. Use assignable_subject when any assignee may hold it: a user, a group of users or an outside company. Read the whole template, add the field and save the whole template. A value is stored as {subject_type, subject_id}, where subject_type is organization_user, resource_group or organization_connection.",
      refs: { field_types: ["organization_user", "assignable_subject"], tools: ["scope.read_scope_template", "scope.save_scope_template"], data: ["custom-fields-project.contract"] }
    },
    {
      title: "Have the platform fill the field, not a person",
      detail: "Pick by where the role is decided. (a) An appointment: no automation. Put default_from on the field: {source:\"event_scheduler\", event_type_id:\"sales_appointment\", write_mode:\"if_empty\"} for whoever booked it, or source \"event_assignment\" for whoever it is assigned to. (b) A call, or finishing a work item: on the work item the event completes, add an onCompleted binding running project.patch.v1 with input {values:{custom_field_values:{booked_by:{subject_type:\"organization_user\", subject_id:\"{{event.context.actor_user_id}}\"}}}} and conditions {match:\"all\", rules:[{field:\"context.actor_user_id\", operator:\"is_present\"}]}. To let a finished call complete that work item, give it external_triggers [{event:\"call.completed\", transition:\"completed\"}]. Check with dry_run_automations before saving.",
      refs: { automations: ["project.patch.v1"], events: ["call.completed", "work.node.completed"], tools: ["scope.save_scope_template", "scope.dry_run_automations", "scope.get_automation_catalog"] }
    },
    {
      title: "Write the pay rule against that field",
      detail: "Save a record pay rule with payroll.payRule.save, after payroll.payRule.preview. Its primary input is {primary:true, source:{provider:\"payroll\", export:\"project_records\", args:{facts:true}}, where:{rules:[{field:\"assignee_keys.booked_by\", operator:\"contains\", value:\"$payee.key\"}, {field:\"canceled_at\", operator:\"is_missing\"}]}}. Set grain \"record\", kind \"commission\", project \"id\" and earned_at the date it is earned, such as \"sold_at\". Put the amount or rate in parameters (type cents or basis_points) and have code return {amount_cents, description}. The sample rules inside_sales_booking and estimator_commission_sold follow this pattern: copy one and change the field. Then add the rule to a pay plan with payroll.payPlan.save and put the payee on that plan with payroll.paySetup.save. You write the rule; never work out anyone's pay yourself.",
      refs: { actions: ["payroll.payRule.preview", "payroll.payRule.save", "payroll.payPlan.save", "payroll.paySetup.save"], data: ["payroll.project_records", "payroll.pay_rules"] }
    }
  ],
  notes: [
    "Write field values under custom_field_values in project.patch.v1. A value written under custom_fields is discarded, and a field path at the top level of values is not a custom field.",
    "project.patch.v1 only checks that an assignee value is an object. It does not check that the user exists or may hold the role, so take the id from {{event.context.actor_user_id}} and never type one in.",
    "call.completed is a project-level event. A binding keyed call.completed on a scope or work item never runs, and project.event_scheduled does not say who booked. communication.call.ended and communication.call.wrap_up_saved are call-log entries that automations cannot see.",
    "Say \"assignee\" in anything shown to the user. What a group is called comes from the terminology system."
  ]
};
