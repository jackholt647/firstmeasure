# Shared widget refresh — October 6, 2026

Source commits: `3be596452c21f342e5150a1f3aa2f1c8aaf094c0` and `2f89368773cadbdf0bb8e9b80a1aa89040e2cfdf`.

Visible widget mounts across the page have stable presentation instance ids. Every assistant text and delegated voice request includes a bounded snapshot of displayed instances (id/version, target, config, panel id); closed/unmounted/hidden instances are absent. This is untrusted UI metadata, never authorization or instructions. `platform_visible_widgets` filters it through fresh domain/widget authorization. `platform_refresh_widget` rechecks the selected reference and queues a targeted presentation refresh. Unknown, closed and denied references cannot be refreshed through the tool. The shared agent instructions tell agents to inspect displayed instances after changing data and refresh the matching instance. `platform_show_widget` defaults to refreshing a matching visible id/version/target/config (omitted config preserves current settings); `new_instance:true` permits an explicitly requested additional instance. Repeated presentation/refresh calls in the same turn are deduplicated.

Each runtime mount exposes `handle.refresh()`. A renderer can return `refresh({loadData,context,reference})` to own its update. The runtime supplies freshly authorized data loading where requested. Without a custom hook, refresh saves serializable view state and performs a full mount reload. Composite widgets refresh their children. The custom element routes refresh through the mounted handle. Inline conversation rerenders preserve existing widget nodes and dispose truly removed mounts after the synchronous move completes; the side board keeps its existing signature-based mount preservation. Refresh commands target only currently displayed instances and are applied once per message/instance, without creating a new dashboard panel.

The shared keyed reconciliation helper reuses unchanged rows, animates inserted/moved rows and briefly highlights changed values. It respects reduced-motion preferences. Task filters, search and editing remain in the existing widget. Errors clear denied task/form preview content instead of retaining it.

| Widget | Refresh behavior |
| --- | --- |
| `todos.list` | Custom authorized reload, animated task insertion/movement/change; retains filters/search/editor. |
| `scope.measurements` | Custom data refresh, animated value cards. |
| `scope.lists` | Custom data refresh, animated list cards and change highlight. |
| `scope.overview` | Composite delegates refresh to its measurement/list children. |
| `forms.preview` | Custom draft/revision refresh through the existing preview controller; preserves device/container. |
| `forms.submissions` | Custom insights refresh with animated metric and submission changes. |
| `payroll.upcoming`, `payroll.timesheets`, `payroll.contractors`, `payroll.exports`, `payroll.history`, `payroll.settings` | Custom delegation to the existing payroll view refresh. |
| `payroll.ledger`, `payroll.commissions`, `payroll.earnings`, `payroll.my_earnings`, `payroll.project_payees`, `payroll.batch` | Custom existing publication refresh; retains search and mounted container. |
| `reports.roof`, `reports.photo` | Full reload fallback; renderer destruction still disposes the previous model/media, with available serialized state retained. |

Host-supplied scope fragment renderers without a refresh hook use the same fallback. Document registry adapters and future registered renderers inherit it without an additional agent tool.

Validation: `npm run test:publication` passed (61 passed, one PostgreSQL-only fixture skipped); tests cover visible inventory, tenant/permission restrictions, refresh/presentation reuse and explicit duplicates. `npm run check` passed after concurrent payroll work completed. Chrome refresh regressions cover one instance after mutation, unchanged row identity, animation, inline search/instance retention, closed inventory, custom hooks, serialized full reload fallback, global mount inventory, preview delegation/denial, submissions insertion and payroll delegation/search retention. Existing to-do editing/completion/denial, assistant layout/chrome, mount isolation/configuration and late-read browser tests also passed. An older standalone Scope fixture did not reach its expected material controls in the concurrently modified materials workspace; the focused widget isolation/configuration and late-read fixtures were used for this change.

The deployment overlays only owned widget/runtime/client/agent files onto each actual live baseline. The worker receives only the shared `agents/platform_tools.ts` source and compiled JavaScript. The older compatibility API receives bounded UI-context parsing and forwarding needed by this feature, retaining its other route behavior; its older widget presentation implementation is also preserved. No production activation is authorized.

Development activation completed with release identity `2f89368773cadbdf0bb8e9b80a1aa89040e2cfdf` on primary web, compatibility, web pool and worker. All four passed owned-file hashes, readiness and development session/outbound isolation verification. All six public frontend assets matched their exact payload hashes. The refresh browser regression also passed using actual JavaScript fetched from `dev.1m8.ai`; the payroll adapter test uses the integrated local catalog because exposing the new payroll domain itself belongs to its separate rollout. TypeScript checks passed in every staged Linux release. Previous role baselines were primary/pool/compatibility `4e8ecc79764eecac4c84ca69d8e6dc28a70cb4f1` and worker `f89d0a8a3919b94232d3f9cacfdb1f6a97ebe63a`; all unrelated files were retained.

Existing dashboard duplicates are historical presentation records and are not silently deleted. Closing an unwanted duplicate with its X leaves the remaining visible instance available for subsequent agent refresh; creating a second instance remains explicit.
