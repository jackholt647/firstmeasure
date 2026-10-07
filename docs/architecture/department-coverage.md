# Department and organization-division coverage

The tenant remains the organization. Divisions form a data-driven tree above departments; existing branches may be mapped to nodes. Projects stay cross-department. Resource groups stay flat and their active local members inherit affiliations. An organization connection is its own assignable subject, not a resource-group subclass.

| Surface | Department behavior |
| --- | --- |
| Organization settings | Division hierarchy, branch mapping, department memberships, group/role defaults, terminology, archive, default channels and app policies. |
| People and roles | Reusable role or explicit capability assignments scoped to a department or division. Explicit denials remain effective. No special manager identity. |
| App navigation and project tabs | Department/group app defaults compose with existing personal choices; explicit restricted policies enforce access on the server. Includes Feedback and Connections app gates. |
| Feed | Department relevance applies to media, document and event sources and notes; source permissions are rechecked. |
| Project boards | Department relevance derives from active workflow stages/work, including manual stage selection. Projects have no exclusive department owner. |
| Workflows, stages and tasks | Workflows can span departments. Stages and nodes inherit or override responsibility; empty explicit assignment means shared. Canonical To-Dos and field tasks use the same model. |
| Documents and templates | Department relevance for lists/default choices, with a separate optional restricted audience. Current instance authority wins over stale embedded project previews. |
| Checklists | Department audience, defaults and filtering in the project and crew paths. |
| Scheduling | Shared effective group/user membership, department requirements, scoped availability and booking; moving appointments checks old and destination authority. |
| Call center | Calls capture department attribution when created. History, live calls, scripts, lists and follow-ups support department relevance; stored-record permission checks protect reads, changes and retained media. Division grants can cover mapped branches. |
| Equipment | Optional owning department, independently of custody; units, service/work orders, history and publications check resource authority. Transfers require both scopes. |
| Canvassing | Optional department classification and filtering, with resource-aware scoped permissions. |
| Channels and people pickers | Optional default department channels track current membership. Pickers search departments or add their current members; department mentions only notify people with conversation access. |
| Notifications | Department audiences resolve membership on occurrence and recheck before delivery/display. |
| Training | Department assignments and scoped management/progress access; removal revokes audience access. |
| Stats | Owner/actor department and mapped division dimensions. Membership is evaluated at query time; overlapping memberships can contribute to multiple groups. Cache identity includes organization structure. |
| Published data, actions and assistant discovery | Typed domain adapters retain their resource checks, including frozen replay. Discovery can expose scoped operations without treating discovery as authorization to execute. |

Ordinary users with one relevant department see their default view without a department selector. Empty catalogs and single-department organizations retain the simple interface. A selector appears only when multiple departments are configured and the viewer has multiple relevant options. Display labels come from the organization's terminology.

Membership and relevance are not grants. A department-scoped role provides only its named capabilities on matching resources. App hiding can be a personalizable default or a server-enforced restriction. Shared/unclassified resources still require the existing domain permissions; a scoped department grant alone does not grant access to unclassified organization-wide records.

Existing generic organization-wide Work configuration/activity projections and materialized Stats operations retain their global permission requirements. They do not accept a scoped entrance without a resource filter. This prevents broader datasets from becoming readable through a department-only role. No new live-listen/barge telephony operation is introduced by this change; existing capabilities receive scope enforcement where their domain supports it.

Validation covers membership inheritance, invalid/cyclic hierarchies, scoped role persistence, explicit-deny precedence, branch and tenant isolation, appointment transfers, equipment ownership transfers, call count/pagination, recording replay revocation, document restrictions, notifications after membership changes, publication discovery and UI single-option/mobile behavior. See the department, organization-structure, Work department, appointment, equipment, publication and browser tests under `public/v1/tests`.
