# Scope-defined materials and delivery scheduling

## Product model

Material lists are an optional output of a project scope. The Materials tab can initialize an editable planning projection while a proposal is being prepared; once signed, the immutable proposal snapshot becomes the authoritative source. A scope template may define zero or more material-list recipes. Each recipe controls:

- how selected proposal items are assigned to a list;
- the list title and identifying color;
- whether the list needs a scheduling item;
- the event defaults used for that scheduling item; and
- the order sources available for the list.

This keeps roofing behavior in the roofing scope preset rather than in the Materials application. The roof-replacement preset currently defines `Dry-In` and `Shingle`; a trade that does not deliver materials can omit `materials` entirely.

## Scope contract

```json
{
  "materials": {
    "enabled": true,
    "assignment": "first_match",
    "order_sources": [
      { "id": "manual", "name": "Manual Order", "kind": "manual", "status": "active" },
      { "id": "supplier", "name": "Supplier API", "kind": "integration", "status": "coming_soon" }
    ],
    "lists": [
      {
        "id": "example",
        "title": "Example materials",
        "color": "#f97316",
        "selector": {
          "match": "any",
          "pricebook_item_ids": ["catalog_item_id"],
          "item_type_ids": ["item_type_id"],
          "categories": ["category"],
          "tags": ["material_tag"]
        },
        "schedule": {
          "enabled": true,
          "event_type_default_id": "material_delivery_example",
          "title": "Example Delivery",
          "kind": "material_delivery",
          "icon": "fa-truck-ramp-box",
          "color": "#7c3aed",
          "source_node_template_id": "schedule_example_delivery",
          "lock_on_order": true
        },
        "order_source_ids": ["manual", "supplier"]
      }
    ]
  }
}
```

`assignment` is either `first_match` or `all_matches`. Roofing uses `first_match` with explicit price-book links and exclusions so a scope item belongs to one delivery list. A selector can also be marked `default: true` to receive an item only when no explicit selector matched it. Exclusion fields mirror the inclusion fields, including tags. Selected scope branches only are materialized.

## Lifecycle

1. A project scope may initialize provisional planning lists so estimators can review materials before signature.
2. Signing freezes the proposal snapshot as the source of truth; each signed scope piece starts its work plan and reconciles the recipes on its versioned scope template.
3. Selected pricebook-backed scope items are resolved against the organization catalog, assigned to recipes, and captured as full material line-item snapshots together with the scope measurements.
4. Each list with `schedule.enabled` receives one deterministic, initially unscheduled project event.
5. Users schedule the work item and material deliveries independently. Scheduling does not place an order.
6. Placing an order creates an immutable material version, marks the list ordered, and locks its linked event when `lock_on_order` is enabled.
7. A locked event requires explicit confirmation before it can be unlocked or moved. It can be locked again from its calendar tile.

Initialization is idempotent. Its source key includes the project, scope piece, and list definition, so a provisional list and its signed successor reuse the same identity and delivery event. Reconciliation replaces only an untouched generated planning projection. Normal Materials-tab refreshes should not regenerate existing lists. The explicit regenerate action passes `force_regenerate: true`, asks for confirmation, replaces generated planning lists from the current scope, and still protects ordered lists. Manual amendments, placed orders, and their immutable versions are otherwise preserved; a changed signed snapshot creates a new generated version instead of silently rewriting history.

## State boundaries

Scheduling, ordering, and fulfillment are separate states:

- Schedule: `unscheduled` or `scheduled`, with a calendar range and lock state.
- Order: planning versus ordered, with source, vendor, price snapshots, and `ordered_at`.
- Fulfillment: unscheduled, scheduled, delivering, partially delivered, delivered, delayed, or canceled.

A calendar date never implies that an order was placed. A material delivery event is not auto-completed merely because its end time passed.

## Event presentation contract

A material event is canonically identified by `schedule_item_kind: "material_delivery"` and `material_list_id`. Its configurable `kind` may carry a scope-specific workflow label without changing calendar category or lifecycle behavior. The event carries:

- a material-delivery `color` hint and truck `icon` for category metadata;
- `material_color` / `accent_color` / `sub_color` for the list identity, which is the only dominant color shown on the calendar;
- `order_status` and `ordered` for solid-versus-dotted treatment; and
- `locked`, `locked_reason`, and `lock_toggle_visible` for calendar behavior.

These fields are presentation hints. The material list and project event remain linked domain records, and schedule writes synchronize the list's schedule projection.

## API surface

- `POST /v1/materials/organizations/:orgId/projects/:projectId/material-lists/initialize-from-scope`
- `POST /v1/materials/organizations/:orgId/material-lists/:listId/schedule-event`
- `POST /v1/materials/organizations/:orgId/material-lists/:listId/orders`
- `POST /v1/platform/organizations/:orgId/projects/:projectId/events`

The project-event endpoint rejects range changes to locked events with `409 project_event_locked`. A deliberate retry with `unlock_confirmed: true` unlocks and applies the edit. Event-only lock/title updates do not emit `project.event_scheduled`; only a real transition onto the schedule or a range change does.

## UX contract

- Materials exposes compact, collapsible list and scope-measurement groups. Line items show the list identity as a small color marker with the list name available on hover rather than repeating the list title in every row.
- List visibility is independent, so one, several, or all lists can be compared.
- Every line item displays its list color and name.
- `Schedule` keeps the project modal open, switches to its Schedule tab, and focuses the linked waiting item; `Order` opens the ordering workflow.
- A new manual list starts with an unused palette color, falling back to the company primary color, and can optionally create its scheduling event.
- The order modal presents Manual Order plus scope-defined integrations. Unavailable integrations remain visible as `Coming Soon` without behaving like active controls.
- Unordered deliveries use the same dotted treatment in Materials and Scheduling. Ordered deliveries use a solid treatment and are locked by default.
- The list color drives the calendar border, tint, placement confirmation, and list marker. The truck icon communicates the material-delivery category without adding a competing category or company-primary color.

## Extension rules

- Do not add trade names, supplier names, or list counts to generic Materials or Scheduling code.
- Add industry defaults to a scope template or organization-authored scope configuration.
- Supplier integrations implement an order source; they do not change list generation or calendar semantics.
- Future re-generation must preserve ordered versions. Scope amendments should produce an explicit version/amendment rather than silently rewriting an order snapshot.
