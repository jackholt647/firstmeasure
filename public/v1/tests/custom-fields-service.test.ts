import assert from "node:assert/strict";
import test from "node:test";

import {
  applyProjectCustomFieldDefaults,
  assignmentPayeesFromCustomField,
  customFieldValueAtPath,
  mergeProjectCustomFieldsForSave,
  reconcileProjectCustomFieldSchema
} from "../custom_fields/service.js";
import { scopeTemplateDefinitionSchema } from "../scopes/schemas.js";

const source = {
  kind: "scope",
  scope_template_id: "sales_pipeline",
  scope_template_version: 2,
  work_plan_id: "plan_1"
};

test("scope custom fields are typed, hierarchical, additive, and durable", () => {
  const first = reconcileProjectCustomFieldSchema({ id:"project_1" }, {
    groups:[{ path:"assignments", label:"Assignments", collapsed_by_default:true }],
    fields:[{
      path:"assignments.estimator",
      label:"Estimator",
      type:"assignable_subject",
      assignment_policy:{ rules:[{ subject_types:["organization_user"], role_ids:["sales_appointments"] }] }
    }]
  }, source);
  const second = reconcileProjectCustomFieldSchema(first, {
    fields:[{ path:"assignments.project_manager", label:"Project manager", type:"organization_user" }]
  }, { ...source, scope_template_id:"production", work_plan_id:"plan_2" });

  const schema = second.custom_field_schema as Record<string, unknown>;
  assert.deepEqual((schema.fields as Array<Record<string, unknown>>).map((field) => field.path), [
    "assignments.estimator",
    "assignments.project_manager"
  ]);
  assert.equal((schema.groups as Array<Record<string, unknown>>)[0]?.collapsed_by_default, true);
  assert.throws(() => reconcileProjectCustomFieldSchema(second, {
    fields:[{ path:"assignments.estimator", label:"Estimator", type:"text" }]
  }, source), /already defined/);
});

test("event defaults fill only empty assignment fields and preserve manual siblings", () => {
  const project = reconcileProjectCustomFieldSchema({
    id:"project_1",
    events:[
      {
        id:"later",
        event_type_default_id:"sales_appointment",
        start_at:"2026-08-02T10:00:00.000Z",
        assigned_user_ids:["user_later"]
      },
      {
        id:"first",
        event_type_default_id:"sales_appointment",
        start_at:"2026-08-01T10:00:00.000Z",
        assigned_users:[{ id:"user_first", name:"First Estimator" }],
        scheduled_by_user_id:"user_scheduler"
      }
    ],
    custom_field_values:{ assignments:{ secretary:{ subject_type:"organization_user", subject_id:"user_secretary" } } }
  }, {
    fields:[
      {
        path:"assignments.estimator",
        label:"Estimator",
        type:"organization_user",
        default_from:{ source:"event_assignment", event_type_id:"sales_appointment", write_mode:"if_empty" }
      },
      {
        path:"assignments.inside_salesperson",
        label:"Inside salesperson",
        type:"organization_user",
        default_from:{ source:"event_scheduler", event_type_id:"sales_appointment", write_mode:"if_empty" }
      }
    ]
  }, source);
  const defaulted = applyProjectCustomFieldDefaults(project);
  assert.deepEqual(customFieldValueAtPath(defaulted.custom_field_values, "assignments.estimator"), {
    subject_type:"organization_user",
    subject_id:"user_first"
  });
  assert.deepEqual(customFieldValueAtPath(defaulted.custom_field_values, "assignments.inside_salesperson"), {
    subject_type:"organization_user",
    subject_id:"user_scheduler"
  });
  assert.equal((customFieldValueAtPath(defaulted.custom_field_values, "assignments.secretary") as Record<string, unknown>).subject_id, "user_secretary");

  const manuallyChanged = mergeProjectCustomFieldsForSave(defaulted, {
    custom_field_values:{ assignments:{ estimator:{ subject_type:"organization_user", subject_id:"user_manual" } } }
  });
  assert.equal((customFieldValueAtPath(manuallyChanged.custom_field_values, "assignments.estimator") as Record<string, unknown>).subject_id, "user_manual");
  assert.equal((customFieldValueAtPath(manuallyChanged.custom_field_values, "assignments.secretary") as Record<string, unknown>).subject_id, "user_secretary");

  const directToProduction = applyProjectCustomFieldDefaults(reconcileProjectCustomFieldSchema({
    id:"project_direct",
    __custom_field_default_context:{
      proposal_creator:{ subject_type:"organization_user", subject_id:"user_creator" }
    }
  }, {
    fields:[{
      path:"assignments.estimator",
      label:"Estimator",
      type:"organization_user",
      default_from:{
        source:"event_assignment",
        event_type_id:"sales_appointment",
        fallback_source:"proposal_creator",
        write_mode:"if_empty"
      }
    }]
  }, source));
  assert.equal(
    (customFieldValueAtPath(directToProduction.custom_field_values, "assignments.estimator") as Record<string, unknown>).subject_id,
    "user_creator"
  );
});

test("payroll can resolve payees from assignment custom fields", () => {
  const payees = assignmentPayeesFromCustomField({
    custom_field_values:{
      assignments:{
        estimator:{ subject_type:"organization_user", subject_id:"user_1", name:"Ada" }
      }
    }
  }, "assignments.estimator");
  assert.deepEqual(payees, [{ type:"organization_user", id:"user_1", name:"Ada", worker_type:"employee" }]);
});

test("scope schema accepts assignment fields, defaulting, forwarding, and payroll references", () => {
  const parsed = scopeTemplateDefinitionSchema.parse({
    id:"sales_pipeline",
    name:"Sales pipeline",
    custom_fields:{
      groups:[{ path:"assignments", label:"Assignments" }],
      fields:[{
        path:"assignments.estimator",
        label:"Estimator",
        type:"assignable_subject",
        default_from:{ source:"event_assignment", event_type_id:"sales_appointment" },
        ui:{ project_tag:true }
      }]
    },
    communications:{
      email_forwarding:{
        target:{ kind:"custom_field", custom_field_path:"assignments.estimator" }
      }
    },
    commissions:{
      roles:[{
        key:"estimator",
        label:"Estimator",
        assignment_source:"project_custom_field",
        custom_field_path:"assignments.estimator"
      }],
      rules:[]
    },
    work_plan:{ root_nodes:[{ id:"sales", title:"Sales" }] }
  });
  assert.equal(parsed.custom_fields?.fields?.[0]?.path, "assignments.estimator");
});
