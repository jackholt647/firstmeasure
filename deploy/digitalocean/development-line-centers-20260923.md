# Development: line centers and midpoint snapping

The line-center implementation is commit `2ecb59f6df3fe3958a4b51874ad974b4f0f2e2ac`.
Deploy its six runtime scripts over the complete development baseline
`eef4fdc683d8c3b068a0688133e278044386cd4b`, preserving the concurrent AI midpoint
selection release. Production is outside this rollout.

## Behavior and validation

Line centers appear beside Face centers in the display toolbar and default on.
The setting controls both virtual midpoint markers and midpoint snapping in wall,
base and drawing-plane point placement. It persists across reload and From Roof,
independently of face-center visibility. Markers do not add permanent vertices;
curve tessellation segments do not receive midpoint markers. Derived marker
geometry shares the render cache and the existing per-frame wall snapshot.

The expanded suite ran 1,097 tests: 1,095 passed. Only the two previously documented
curved-eave extrusion failures remain. New handler checks verify default-on/off/on
behavior, exact midpoint placement, drawing-plane and 2D base snapping, persistence,
and no permanent geometry from marker rendering. The per-frame composition test
also passes. Evidence: `output/line-centers-full-tests.log`.

## Deployment preparation

The first staging attempt used the older `f0ec2e4` baseline. Its web-stage guard
rejected the changed active runtime; no role was activated. Those staged worker
and compatibility directories are abandoned. Stage a new immutable release from
the complete `eef4fdc` baseline using the existing guarded delta workflow.
