# Development Equipment Simple policy

Equipment is fixed to the revised Simple feature set on development. The
Equipment app and Company Settings no longer offer tier, feature, or behavior
controls. The generic capability editor also hides Equipment feature toggles;
the Equipment app itself can still be enabled or disabled.

The effective feature set is scheduling, maintenance tracking, and operator
qualification checks. Requirements, meters, costing, and custody are off.
Conflicting bookings and missing operator qualifications block assignments.
Maintenance and downtime events do not require an operator. Single-unit
auto-fulfill remains enabled. Work order completion no longer accepts a new
maintenance cost. Existing stored values are preserved for a future rollout,
while the capability resolver applies the fixed policy to existing and new
organizations.

Source commit `6725168169b61d748c3aa2057b1bef8fac995833` was staged over
verified live baselines and activated on both development web nodes, the
compatibility API, and the worker. The worker queue was idle before its switch.
All four roles passed local readiness or worker health. A concurrent assistant
release then advanced both web nodes and compatibility to descendant commit
`84ce2d2073a28a370d3e9e42980f4124079dc9c9`; the Equipment asset and
compiled capability hashes were checked on those live nodes after that move.
The worker remained on `6725168` at the final check. Production was unchanged.

The public Equipment script SHA-256 matched the staged manifest. The synthetic
Ironwood Fleet Lab organization reported scheduling, maintenance, and operators
on; requirements, meters, costing, and custody off; and Simple settings with
both conflict and operator enforcement set to block.

Local verification: `npm run check`, `npm run build`, the Equipment API suite
(11 pass, 2 parked advanced-feature cases), and the two new Equipment settings
UI contracts passed. The older unit UI contract file has six pre-existing
assertions against untranslated text and still fails. Release manifests and
guarded staging scripts are under ignored `output/equipment-simple-20260928/`.

For rollback, first inspect the current release on each role because concurrent
development releases may have advanced it. The Equipment release's immediate
predecessor was `51cb6e0` on web and compatibility and `330470f` on the worker.
Switch only to a verified role baseline using the existing symlink and service
restart workflow. Data is not rolled back.
