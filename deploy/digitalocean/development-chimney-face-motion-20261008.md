# Upper chimney face motion — October 8, 2026

Upper generated chimney sides retained `drivesFootprint` after the chimney model
changed to separate above-roof faces from the lower shaft. E therefore resized
the entire shaft; M could additionally propagate movement through neighboring
planes. Offsetting an upper face now captures the existing chimney footprint,
clears its footprint-driver flag, and uses a local extrusion with connecting
returns for both E and M. Ordinary whole-shaft editing retains its existing
behavior. Undo restores the original edit state; committed geometry reloads
without moving the foundation or lower walls.

Validation: 50 chimney/sweep tests passed. The face-editor suite passed 421 of
422 tests; the previously recorded generated chimney-support selection failure
remains unchanged. The new regression covers both commands, inward/outward
short offsets and offsets crossing the house boundary, connecting returns,
cancel, commit and reload. An additional 32 previews and commits used saved
project geometry and preserved the lower walls, footprint and base within
one micrometer. The reproduction harness excluded collapsed generated wall
fragments from the pickable scene; it did not modify customer data.

Development rollout: pending verification. Only wall_face_draft.js is deployed
from the verified immutable commit, preserving each role's unrelated runtime
files. Production is outside this rollout.
