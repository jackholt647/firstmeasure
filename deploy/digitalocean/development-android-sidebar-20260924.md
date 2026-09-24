# Development Android sidebar inset — September 24, 2026

The Android host pads its WebView above the system navigation bar. The portal
sidebar also added `env(safe-area-inset-bottom)` beneath its bottom launchers,
leaving a second gap below Settings and User in the installed app. Commit
`79245350dc39a3c3f78bb0ba6bb7d2074decf286` uses zero additional sidebar
safe-area padding when the native Android bridge is active. Browser and iOS
safe-area behavior remains as before.

`php -l public/portal/index.php`, `node --check
public/portal/scripts/core.js`, `git diff --check`, and the five phone-features
tests passed. The existing Money settings layout contract failure is unrelated.
The fix was diagnosed from the native inset handler and portal styles; an
interactive measurement on the user's phone was unavailable.

During staging, the development web release advanced to `9098b7d`. Its runtime
still contained the prior portal files even though the source commit included
the sidebar fix. Immutable release `bdefd3f806f88257689f628737c299281eed1346`
was staged from that exact runtime with only the two corrected portal files
overlaid, then activated one web node at a time. Both `do-598520065` and
`do-603124965` report this release as ready with development data and enforced
outbound isolation; PHP-FPM and web services are active. The served files match
the source SHA-256 values:

- `public/portal/index.php`: `4fc0844b3ee0317cd984525341f716794512c3df6552acc59fcf780b35d503df`
- `public/portal/scripts/core.js`: `b07f08a8b80125b0a671d63058cc876bccaac52599922eaaa8bcc3d6e67530da`

Eight public readiness requests reached both web nodes and reported the new
release. Worker and compatibility roles were unchanged because this is a portal
presentation fix. Production and the historical development autoscale image
were not changed; a future replacement node still needs a release/template
refresh to preserve the fix.
