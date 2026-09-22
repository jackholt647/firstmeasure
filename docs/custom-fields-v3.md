# Custom fields v3

Custom fields are the canonical extension system for project-specific data.
Definitions may come from the branch-wide `custom_fields` module or be
contributed by any scope template active on a project.

## Scope declarations

```json
{
  "custom_fields": {
    "groups": [
      {
        "path": "assignments",
        "label": "Assignments",
        "collapsed_by_default": true,
        "location": "project_left"
      }
    ],
    "fields": [
      {
        "path": "assignments.estimator",
        "label": "Estimator",
        "type": "assignable_subject",
        "cardinality": "one",
        "assignment_policy": {
          "rules": [
            {
              "subject_types": ["organization_user"],
              "role_ids": ["sales_appointments"]
            }
          ]
        },
        "default_from": {
          "source": "event_assignment",
          "event_type_id": "sales_appointment",
          "selection": "first_qualifying",
          "write_mode": "if_empty"
        },
        "ui": {
          "project_tag": true
        }
      }
    ]
  }
}
```

Scope activation materializes these definitions into
`project.custom_field_schema`. Definitions are additive by path and remain on
the project after the contributing scope completes. Repeated declarations
must use the same type and cardinality; incompatible declarations fail scope
initialization instead of silently replacing one another.

Values live in both `project.custom_field_values` and the compatibility mirror
`project.custom_fields`. Dotted paths represent nested objects rather than
literal keys:

```json
{
  "assignments": {
    "estimator": {
      "subject_type": "organization_user",
      "subject_id": "user_123"
    }
  }
}
```

Reference field types are `organization_user`, `resource_group`,
`organization_connection`, and their union `assignable_subject`. Their
`assignment_policy` uses the same workforce assignability rules as scheduling.

## Defaults

`event_assignment` defaults select the assignee from the chronologically first
non-cancelled event of the configured type. `event_scheduler` selects the user
who scheduled that event. They write only when the field is empty. Manual
values and populated sibling fields are preserved. The source event and write
mode are recorded in `project.custom_field_value_meta`. A field may declare
`fallback_source: "proposal_creator"` when a direct-to-production workflow
still needs a responsible salesperson before an appointment exists.

## Payroll

A scope commission role can read the same assignment:

```json
{
  "key": "estimator",
  "label": "Estimator",
  "assignment_source": "project_custom_field",
  "custom_field_path": "assignments.estimator"
}
```

Payroll ledger entries continue to snapshot resolved payees when created.

## Email forwarding

A scope can make a project assignment its forwarding target:

```json
{
  "communications": {
    "email_forwarding": {
      "enabled": true,
      "priority": 10,
      "target": {
        "kind": "custom_field",
        "custom_field_path": "assignments.estimator"
      }
    }
  }
}
```

Targets may also use `kind: "organization_user"` with `user_id`, or
`kind: "email"` with a literal `email`. Resource-group references resolve to
the group's primary member. If the project target is unavailable, inbound
mail uses the Communications setting `email_forwarding.fallback_email`.
Unmatched messages include a routing note explaining that they could not be
paired to a project.
