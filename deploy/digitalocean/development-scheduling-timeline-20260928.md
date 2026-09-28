# Scheduling Timeline and equipment picker — September 28, 2026

Source release: `f22867ae788658f5984c678953dd9fb3bcfddbd9` on
`codex/consolidated-firstmeasure-20260923`.

Scheduling calls its Gantt view Timeline. The event equipment picker shows
unit icons, names and types. Down or retired equipment has red, struck-through
names and requires an explicit Assign anyway confirmation; Cancel makes no
assignment. Assigned down units retain the warning styling.

This frontend release replaces six assets over each host’s verified live
baseline. It preserves unrelated concurrent Equipment, date/time picker and
other releases. No database, configuration, worker or production change.

Validation: focused Chromium behavior regression and JavaScript syntax pass.
The existing scheduling contract suite failures reproduce against the prior
scheduling source. The full localization build hits the existing
`pt-BR.errors.dm_fixed_membership` translation-key mismatch; the terminology
namespace and its content-addressed manifest entry were updated separately.

Release evidence and guarded per-host manifests are in ignored
`output/scheduling-timeline-deploy/`. Staging stopped safely when a concurrent
Equipment rollout changed a live baseline; inventory was refreshed before
continuing. Activation and hosted verification are recorded in that directory.

Rollback: inspect intervening releases, restore the previous per-host symlink
from the receipt, restart the development web or legacy service and PHP-FPM,
and verify readiness and development outbound isolation one host at a time.
There are no migrations to reverse. The historical development autoscale image
limitation remains; this frontend release does not change pool topology.

Final verification: both development web nodes and compatibility activated
`f22867a`, passed local readiness with outbound isolation enforced, and matched
all six asset hashes. Both web nodes were observed healthy through the public
load balancer before continuing. The focused browser test passed using the
actual scheduling JavaScript fetched from dev.1m8.ai.

A subsequent concurrent Equipment rollout advanced both web nodes to
`cccaeec9f330c74c19c96676aebc475fe6cdd130`. All six scheduling hashes were
verified unchanged on those descendants. Public readiness recovered after
transient rollout errors; eight final readiness requests and all four public
library asset hashes passed. Compatibility remains on `f22867a`. Do not roll
back those newer Equipment changes when rolling back scheduling.

The per-role predecessors were `3cbeecf4b377677f954388f48b667171cad48cd4`
on both web nodes and `9d1c6877257d5a32c0e64a2d77ff0a78f87fa3ed` on
compatibility. Production was not modified.
