# Development: midpoint selection and candidate rotation

Release `eef4fdc683d8c3b068a0688133e278044386cd4b` changes only exterior_ai.php and exterior_ai.js at runtime, preserving the full `f0ec2e4ede04eb195c18c379d91ffde9a58a83b9` development baseline. Production is unchanged.

Luna low reasoning still receives the front reference and eight textured candidates. It can select one view or two adjacent views, including the wraparound pair 8/1. The application uses the exact angular midpoint at the existing radius and recalculates grade plus six feet there; no fraction or extra image is requested. Both server and client validate adjacency. Saved runs include the response and selected camera pose. The versioned request prevents stale clients from misinterpreting a midpoint response.

Each captured view now has an accessible Rotate button beside its title. It reuses the saved position and center with textured rendering, restores orbit controls, and keeps image clicks as downloads. Previous saved runs remain inspectable. Controls disable while a capture or move is running.

Validation: all three focused tests pass, including independent frustum checks, single and wraparound midpoint positioning, saved history, manual rotation, stale project responses and missing textures. PHP lint and JavaScript syntax checks pass. Guarded staging verified 24,499 unchanged public files on web/compatibility and 24,513 on worker. Rollout evidence is in ignored output/exterior-ai-midpoint-20260923. The prior complete baseline remains available for rollback using the existing guarded workflow and PHP-FPM refresh.
