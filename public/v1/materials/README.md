# Materials API

Material lists are project records that can be created manually or generated from a signed, versioned scope definition. Generated lists retain their scope piece, measurements, color, selector, allowed order sources, and stable definition order. Their line items snapshot the selected proposal price-book items so later catalog edits do not alter an accepted scope.

## Scope initialization

`POST /v1/materials/organizations/:orgId/projects/:projectId/material-lists/initialize-from-scope`

Pass a signed `snapshot_id` (and optionally `scope_piece_id`), or an explicit `scope`/`scope_piece` plus `materials` definition. The response contains `material_lists`, `schedule_events`, `count`, and `created_count`. Repeating the same initialization reuses stable list and event ids. Normal UI refreshes should load existing lists first and only initialize when none exist; pass `force_regenerate: true` only for the explicit “Regenerate from scope” action.

Material delivery membership belongs to the scope definition. Scope list selectors should link directly to price-book item ids, item-type ids, categories, or tags, with exclusion selectors available to keep lists mutually exclusive. The price book supplies catalog records; the signed scope supplies the selected items, quantities, measurements, and delivery grouping.

`POST /v1/materials/organizations/:orgId/material-lists/:listId/schedule-event`

Ensures a single linked material-delivery project event and returns both `event` and the current `material_list`. Manually created lists can use this endpoint even when their originating scope did not require delivery scheduling.

## Ordering and scheduling

Ordering and scheduling are separate operations. Creating an order snapshots pricing, records the selected order source, links the order to the list's schedule event, and locks that event when `lock_on_order` is enabled. Integration sources marked `coming_soon` cannot place an order.

Locked event range changes through the platform project-event API return `project_event_locked`. Resubmit with `unlock_confirmed: true` to unlock and apply the move, then save `locked: true` to relock. Lock-only and title-only saves do not emit another `project.event_scheduled` workflow event.

Calendar time does not imply material fulfillment: wall-clock event lifecycle processing skips `kind: material_delivery`. Delivery records update `fulfillment_status` while leaving scheduling status independent.
