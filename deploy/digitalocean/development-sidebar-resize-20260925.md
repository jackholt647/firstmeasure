# Development sidebar and dock resize cues — September 25, 2026

The default-on **Drag to Resize Left Column** setting lets a user drag the
portal sidebar's full right edge to choose a 220–420 px width. Dragging a
compact sidebar locks it open; the arrow retains its click action. The border
remains thin until hover, then thickens with a short animation. Docked windows
show the same cue on their left resize edge. The saved width uses the existing
personal `sidebar_width` preference.

Source commit `efb0e64c14af236438ba558490e08f60ac9e9706` is pushed on
`codex/sidebar-resize-dev-20260925`. The final immutable development web
release is `961ed92f4bb828d7672f2bb52d9381dcd681a5d2` on both serving nodes
(`do-598520065` and `do-603124965`). It overlays only the six source files and
two matching compiled capability modules onto the concurrent `bc987eaa1dcc17218213981e33787766ddc25e74`
web baseline. Other source, runtime, configuration, organization data and
production were unchanged. The historical development autoscale image was not
updated; a future replacement node needs the current release.

The source flag `platform.resizable_left_column` has `default: true`. Its
Company Settings control also defaults on. The compiled capability definition
on both nodes contains the same default. A saved organization override can turn
the gesture off without changing the arrow click behavior.

The local TypeScript check and all 11 capability tests passed. JavaScript and
PHP syntax checks passed for the staged web files. Each activated node passed
local development readiness with outbound safety enforced, and all eight
deployed file hashes matched the release manifest. Public verification returned
the final release in 32 readiness samples (24 from the primary web node, eight
from the pool node); the portal core, window manager and Company Settings asset
hashes matched the published files. The release manifest and rollout evidence
are in ignored `output/sidebar-resize-dev-20260925/`.

Two concurrent development releases advanced the live baseline during staging.
An intermediate sidebar candidate was activated on the pool node and was later
superseded by the concurrent release. The final release reconciles the sidebar
files on both nodes over `bc987ea`. Rolling back only one node to that baseline
would produce mismatched sidebar behavior because its web and pool copies
differed. Any rollback should preserve later concurrent work and align both
web nodes on one verified release.

After this rollout, concurrent development release
`58113d59587a5a86ca3aab8177be62c9c6b86a42` reached both web nodes. A
read-only audit found the same sidebar, window-manager and capability source
and compiled hashes on both nodes, including the default-on flag. Its updated
Company Settings script still contains the resize setting and width-preference
listener. Both nodes passed local readiness. Public sampling of that successor
reached only `do-598520065` in 80 requests; the load balancer's backend routing
was not changed by this task. The primary's public portal continues to serve
the resize behavior.
