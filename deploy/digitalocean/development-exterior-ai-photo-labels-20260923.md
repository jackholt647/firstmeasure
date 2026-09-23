# Development AI photo labels — September 23, 2026

Release `85820504dc5f700758257f17cb53f664511a83dc`, baseline `6fce7d7f2cadb8454c154afb86e11fe5796ad160`.

The AI Stickers Photo dropdown prefixes filenames with Front, Back, Left side, Right side or the corresponding corner direction. It resolves report elevation photo assignments using the same initialization as Rotation, preferring manual assignments over automatic metadata. Unknown directions show Unassigned. The saved rotation reference is labeled Front · rotation photo. Photo identifiers and request inputs remain unchanged.

The existing browser pipeline test passed. A targeted check verified manual assignment precedence, left/back metadata and the unassigned fallback. The one-script runtime delta preserves all other public files. Deployment evidence is in ignored `output/exterior-ai-photo-labels-20260923/`. Production is unchanged.
