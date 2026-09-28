# Equipment input borders — September 28, 2026

Equipment detail inputs, selects and textareas now keep their normal gray border
and white background at rest. Hover is no longer required to reveal a field.
Focus retains the primary-color outline. The unit color input also has a permanent
border. The deliberately plain icon selection grid is preserved.

JavaScript syntax and the existing three Equipment browser/contract checks pass.
Deploy only public/libraries/apps/equipment/app.js from the canonical commit over
each verified live development web baseline, preserving all unrelated assets.
Verify per-node readiness, development isolation and asset hashes, plus public
health/hash and the browser flow against the served script. Evidence is in
ignored output/equipment-borders-20260928/. No backend, database, topology or
production changes. Roll back through the existing symlink/service workflow to
the per-node receipt baseline after checking for intervening releases.

Completed rollout: `cccaeec9f330c74c19c96676aebc475fe6cdd130` is active on
both development web nodes (`do-598520065`, `do-603124965`). Both passed local
readiness, development isolation and asset hash verification. Six public health
checks, public asset hash and the existing browser flow against the served
script passed with synthetic API fixtures.

The initial staging guard stopped when a concurrent scheduling rollout advanced
the baseline. After that rollout settled, both Equipment source files were
verified unchanged and the delta was restaged over
`f22867ae788658f5984c678953dd9fb3bcfddbd9`, preserving its changes. That is the
previous release on both nodes. Production was unchanged.
