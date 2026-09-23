# FirstMeasure: local development and production deployment

September 23 generated boundary follow-up: [Near-straight roof-contact edges](deploy/digitalocean/development-wall-boundary-noise-20260923.md) records `0dbd848b4684350e1735b62ba116df65cbd152cd` on all development roles. The captured-house front edge no longer exposes roof-triangle clipping stations; roof-contact meshes and deliberate points are retained. 1,024 relevant checks and live browser/HTTP verification passed. Preserve this runtime baseline.

September 23 wall drawing: [Continuous generated edges and drawing beyond outlines](deploy/digitalocean/development-wall-drawing-20260923.md) records `5960ca6257dfadabee2816d68ce7484f130fedce` on all three development roles, based on the consolidated `ac96d0c` runtime. Public assets and readiness are verified. Generated straight runs no longer expose source subdivision points; point and curve drawing can extend beyond face outlines while retaining deliberate anchors. Preserve this runtime baseline.

> **Directory move pending (September 23):** The physical canonical checkout is
> still `C:/Users/jackh/Code/2026/FirstMeasure`. Windows blocked the move because
> multiple Codex helpers hold this directory open. `FirstMate Platform` paths
> below describe the intended destination; it does not exist yet. No alias or
> duplicate was created. See [rename status and completion](docs/canonical-rename-status.md).


September 22 Resoffit leftovers: [Consumed sketch masks and retained stations](deploy/digitalocean/development-resoffit-ghosts-20260922.md) records `03c76e5d5c4cb02f50940503691e7a640c353720` on development. Resoffit keeps source masks synchronized with moved sketch nodes, repairs stale masks on reload, and keeps retained stations on the replacement faces. All 911 tests pass. Preserve this baseline.

September 22 selection performance: [Cached geometry and turret contact picking](deploy/digitalocean/development-selection-performance-20260922.md) records `59fc259934108ff238d7664d5843a25e1e02058e` on all three development roles. Selection reuses unchanged geometry, avoids duplicate same-layer redraws and saves, and picks the displayed merged roof-contact lines. All 908 tests pass. Preserve this baseline.

September 22 zero-depth Resoffit: [Collapsed chimney returns](deploy/digitalocean/development-resoffit-zero-20260922.md) records `1730b0ea934dfca700e1f246738868f57e10e2e3` on all three development roles. Micrometre-width chimney returns collapse correctly at zero depth instead of triggering a false wall reversal. All 902 tests and a live two-edge zero-depth edit pass. Preserve this baseline.

September 22 finite tower junctions: [Roof-plane-constrained soffits](deploy/digitalocean/development-soffit-plane-junction-20260922.md) records `9aa47ca76f3411dc2f6b5c69e9078177f970310a` on all three development roles. From Roof reconciles the tower side contacts, limits adjoining setbacks at measured roof ends, and removes unsupported flashing wings. All 894 tests and live editor verification pass. Preserve this baseline.

September 22 turret Resoffit follow-up: [Adjoining depths and roof-sheet continuity](deploy/digitalocean/development-resoffit-turrets-20260922.md) records `20b08ab6a68df26ef5521244fd4bcbb2f27ce3a3` on all three development roles. Turret edits reconcile adjacent planes, remove consumed short returns, retain lower roof contacts and render continuous roof-contact highlights. All 887 tests, 75 saved-house depth cases and live editor checks pass. Preserve this baseline.

September 22 additive line selection: [Shift miss and rectangle preservation](deploy/digitalocean/development-shift-selection-20260922.md) records `6e0163edef2db805c2d618dc2312cec870df03b7` on all three development roles. Shift line misses no longer fall through to faces or other layers, and additive rectangles preserve existing lines. All 862 editor and geometry tests pass. Preserve this baseline.

September 22 exact roof-edge snapping: [Contact tolerance for sequential extrusion](deploy/digitalocean/development-chimney-snap-20260922.md) records `da6f7094b847ad14f1ed69969d3bbb46b40be627` on all three development roles. A 2 mm outer-edge contact tolerance removes the sliver after snapping a side to its roof edge and then extruding the front. All 856 tests and four fresh saved-house snap sequences pass. Preserve this baseline.

September 22 chimney editing: [Selection and sequential roof-bound extrusion](deploy/digitalocean/development-chimney-edit-20260922.md) records `0a8957121da0933d2e98f552c67c62ac834763b2` on all three development roles. Selection retains chimney exposure; side-then-front extrusion follows lower roof contacts across both chimneys. All 852 Node checks and fresh saved-model checks pass. Saved project metadata is unchanged. Preserve this baseline.

September 22 Resoffit: [Selected soffit depth editing](deploy/digitalocean/development-resoffit-20260922.md) records `a13f0d95c67f602682420bec95ba3fc38f530c2b` on all three development roles. Shared corners retain neighboring planes, roof-contact lines are red-orange, Shift-empty selection is preserved, and repeated edits retain exact edge selections. Final 839 Node checks and live turret UI checks pass. Saved project metadata is unchanged. Preserve this baseline.

September 22 shallow soffit follow-up: [Minimum clearance for lower roof layers](deploy/digitalocean/development-layer-clearance-20260922.md) records `453277465a814dd3bb1079fdd105ae4ca3cb4abb` on all three development roles. The saved house is rebuilt at 1.5 feet while affected walls retain the deeper clearance required by lower roofs. All 825 selected tests and four saved-model checks pass. Preserve this baseline.

September 22 chimney shell follow-up: [Roof clipping, wall alignment and chimney exposure](deploy/digitalocean/development-chimney-shell-20260922.md) records `4a773213df4bd219c8a053825a8dbfb1a1bbf8a0` on all three development roles. The house was rebuilt and saved with roof-bounded wall tops, no overlapping chimney-junction panels, and continuous chimney sides above the lower caps. All 814 selected tests and the three new regressions against the saved dev state pass. Preserve this baseline.

September 22 chimney soffit follow-up: [Attached contacts and layered setbacks](deploy/digitalocean/development-chimney-soffits-20260922.md) records `c6953cd9c9034697fab031d15cc6544c9ebefa68` on all three development roles. Both chimney junctions were rebuilt and saved; 811 tests pass, including physical-contact and soffit-depth regressions missing from the earlier gap checks. Preserve this baseline.

September 22 layered roof generation: [Chimney, turret and foundation fixes](deploy/digitalocean/development-roof-layers-20260922.md) records `11b13e0e444c7af901381bcf4e6e67e8017f80d8` on all three development roles. The saved house was rebuilt and verified with zero ground gaps; 807 tests pass. Development NGINX temporary-directory ownership was also repaired so saves and large imagery downloads work. Preserve this baseline.

September 22 mobile apps: [Development mobile hosts and private downloads](deploy/digitalocean/development-mobile-apps-20260922.md) records `af30bfaac0af4d5605a5c00524ebc75c25be1aa5` on all development roles (App download defaults off; Test Company is opted in), preserving the concurrent `18a81ab` wall/plane editor release. Android and iPhone simulator CI passed; physical iPhone distribution awaits Apple signing. Production is unchanged.

September 21 PHP release compatibility: [Prevent mixed portal releases](deploy/digitalocean/development-php-release-compatibility-20260921.md) records the development correction for stale PHP pages mixed with new JavaScript. PHP-serving NGINX hosts must use resolved release filenames; refresh PHP-FPM on both web and compatibility activation and rollback. Organization data and flags were unchanged.

September 21 co-branding default: [Standard FirstMeasure sidebar branding](deploy/digitalocean/development-cobrand-default-20260921.md) records `9ee0e68ba5c8671468d121629ac97be00e7336c6` on development. Co-branding is default-on without expanded apps; saved organization opt-outs remain respected. Production is unchanged.

September 21 complete local development sync: [Platform, localization and exterior release](deploy/digitalocean/development-complete-local-20260921.md) records `2325b63c541aec4eb785a8998f2d11a752755d47` on all three development roles. Preserve this complete baseline. Production is unchanged; rollout capabilities remain default-off.

September 18 textured ground imagery: [Flat image ground](deploy/digitalocean/development-image-ground-20260918.md) records `3240bc71374eb13dc65852c81a12f26e033fd8c6`. Enabled imagery remains visible as a lightweight flat ground plane beneath the textured model.

September 18 garage trim: [Garage sticker trim shortcut](deploy/digitalocean/development-garage-trim-20260918.md) records `cf2f2d99bd18aeafc104360ed5c8fb654b714fd2`. T adds garage trim instead of entering geometry Flip; top and side trim preserve recess depth.

September 18 opaque imagery performance: [Exclude reference imagery from visibility raycasts](deploy/digitalocean/development-image-occlusion-20260918.md) records `c21d3dc6426c1f54360d897b44d8501a40be5b41`. Dense DSM and tile meshes no longer enter per-point and per-label occlusion checks.

September 18 copied sticker alignment: [Explicit sticker face copies](deploy/digitalocean/development-copy-snap-20260918.md) records `4b82d3564e580233785462df2012a33443286c75`. Copy excludes coincident unselected wall patches so pasted windows retain cross-wall alignment and trim.

September 18 shared sticker placement: [Copy groups, snapping and trim](deploy/digitalocean/development-sticker-shared-20260918.md) records `47d4779dce649c5f9224b7efbfa700adc1bdd2c2`. New and copied stickers share placement and trim paths; groups keep their dimensions and spacing.

September 18 roof trim controls: [Eaves, Rakes and opt-in defaults](deploy/digitalocean/development-roof-trim-options-20260918.md) records `9d5ae2be91dbea3c50798ea42ea6292977ae1470`. Unset trim is zero; explicit saved heights remain.

September 18 trim contact: [Stop at existing trim](deploy/digitalocean/development-trim-stop-20260918.md) records `f4af452c4556d5b0fa288fe5fc0688047a9c85a3`. New strips stop across their full width at saved wall trim and generated window/door trim.

September 18 multi-point cuts: [Batch H/V](deploy/digitalocean/development-multi-axis-20260918.md) records `6500d2fb9d1cddf30a7173c046d14e1adde7b487`. Selected points preview and commit cuts together with one undo step.

September 18 sticker ownership: [Move and delete cleanup](deploy/digitalocean/development-sticker-lifecycle-20260918.md) records `f605ec2e2185bf07172ee35825aa8d96ec07cf70`. Sticker anchors follow their face; Delete removes sticker wires while preserving deliberate wall cuts.

September 18 vertical cut commit: [Split wall validation](deploy/digitalocean/development-axis-commit-20260918.md) records `565faf923e73c909e438a3e3b2348c646f91f228`. Cuts retain both valid wall pieces and cannot trap controls after a rejected commit.

September 18 trim units: [Typed widths in inches](deploy/digitalocean/development-trim-inches-20260918.md) records `957a20c52f04bfdece4df9e3e770da223601dfc5`. The T trim tool reads inches and displays in.

September 18 opening cuts: [V through trim](deploy/digitalocean/development-cut-trim-20260918.md) records `8d5ae5d37e2e53c72c9528b69632b3f7661d0912`. Window-corner cuts use the adjoining wall and ignore trim.

September 18 sticker trim: [Opening snapping and placed trim cycling](deploy/digitalocean/development-sticker-trim-20260918.md) records `598146a875939f3710ed33deb59a88d119708e1b`. Snapping ignores trim; T cycles placed window and door trim without moving them.

September 18 downward extrusion: [Preserved sketch connections](deploy/digitalocean/development-edge-down-20260918.md) records `68bc6c78fc269710d2263355b718c49109f8dfbe`. E keeps unselected sketch and loose edges fixed and connects each original endpoint to its clone.

September 18 edge motion: [Measured moves and step extrusion](deploy/digitalocean/development-edge-motion-20260918.md) records `8cc783db5112c7b2f9d085b9ebad5d46e9f254ec`. Multi-wall edge chains accept typed distances; E preserves front edges with new connections.

September 18 soffit default: [24-inch default](deploy/digitalocean/development-soffit-default-20260918.md) records `03616a26140b9013e34f28ca2046e79d69d013ae`. New Auto generation uses 2 ft; saved choices are preserved.

September 18 corner cleanup: [Generated corner welding](deploy/digitalocean/development-corner-weld-20260918.md) records `06b984f518dc4b17bed771a400289648a8f35dfb`. Floor and roof joins are reconciled separately using original roof-corner references, retaining real steps and independent wall/base editing.

September 18 wall/base editing: [Independent wall edges](deploy/digitalocean/development-wall-base-detach-20260918.md) records `313e9de52398a367c3f9b159cae0963131bc22b1`. Wall-bottom Delete and Move leave the base in place, including multi-edge moves. Previous fixes are retained.

September 18 offset cleanup: [Soffit overlaps at every depth](deploy/digitalocean/development-soffit-offsets-20260918.md) records `0edd665db8157b2f31e73a71015ecd5ad7f5504f`. Embedded overlap returns are removed before insetting; 0.2, 1, 1.5 and 2 ft regressions pass. Previous editor changes are retained.

September 18 generated wall seams: [Flashing junction cleanup](deploy/digitalocean/development-flashing-seam-20260918.md) records `c21a7a8fb9f8ef433e239edebf6fd3f986d1fe99`. Roof-connected millimetre drift is aligned before merging, removing duplicate-looking internal wall seams. Prior editor and roof-fitting changes are retained.

September 18 roof editing: [Move and Extrude roof fitting](deploy/digitalocean/development-roof-move-fit-20260918.md) records `e35244102a4f7c6e8fc952287d9f5ee7b225b2b6`. Both tools fit measured roof surfaces and snap to finite eaves; M preserves connected walls. Complete editor and skylight changes are retained.

September 18 skylights: [Textured roof skylights](deploy/digitalocean/development-skylight-textures-20260918.md) records local verification and the development-only rendering delta.

September 18 wall repair: [Foundation corner tracing](deploy/digitalocean/development-wall-hole-20260918.md) records `af50a6f11117c9cd208d9d42c6af1efc43f75848`. Foundation tracing retains actual wall endpoints so repaired strips remain supported during the second generation pass.

September 18 complete editor sync: [Consolidated local features](deploy/digitalocean/development-complete-editor-sync-20260918.md) records `b77f3943131657b76e10429c2082ed1cb25fdd52` on all dev roles. Tab cycling, performance tools/optimizations, trim-follow and report improvements are now included. All 65 public editor scripts and 89 runtime/asset files were verified against the reconciled local source. Preserve this complete baseline in subsequent releases.

September 18 initial grade: [Hidden flat grade](deploy/digitalocean/development-flat-grade-20260918.md) records `3ca9f780538614c3ab78a6f7bc11118faa0e6fe1`. Wall projects start with hidden flat grade, preserving explicit saved grade choices. The concurrent exterior training release is retained.

September 18 exterior visibility: [Opaque depth ordering](deploy/digitalocean/development-opaque-depth-20260918.md) records `c6963cea9c6bc4165c56b022021933ab7838b9d7`. Development now includes the local line, marker and label occlusion helpers, stronger selected-line depth bias, and grade/base depth separation. One browser runtime file changes; saved geometry is preserved.

September 18 deeper soffits: [Overlap alignment](deploy/digitalocean/development-deeper-soffits-20260918.md) records `f188c0ebd40d32c2112b6a212158bc2886428e28` on all three development roles. Shared wall alignment preserves the deeper overhang rather than choosing the longer roof edge, and clipped return joins stay closed. The current training and Resources releases are retained. Two browser geometry files changed; production and access settings are unchanged.

September 18 exterior training: [Development training support](deploy/digitalocean/development-exterior-training-20260918.md) records source-aware practice scope, isolated references, wall editing and ungraded completion. Development only; production is unchanged.

Operational handoff for Codex and maintainers. Baseline: September 8, 2026, after production cutover, provider repairs, and successful final database validation. Verify current inventory and configuration before acting. This guide is not an instruction to deploy automatically.

September 18 development: [Soffit cleanup and foundation outlines](deploy/digitalocean/development-soffit-foundation-20260918.md) records `1bb13aee8795eb2ef8ea872541e2ac30eb5a385b` on all three development roles. Foundations follow cleaned inset wall outlines; collapsed roof returns and chimney-covered gaps close correctly. The previous soffit-overlap fix is included. Four browser geometry files changed; experimental access and production are unchanged.

September 16 development follow-up: [Rendered exterior preview](deploy/digitalocean/development-rendered-preview-20260916.md)
records `397ab55d6af2ef881c962be629d8223af3266100` on all three development roles.
Adds an optional Rendered mode with bundled 2K PBR assets, HDR reflections,
modeled opening details, lighting controls and 4K export. Source remains on
`codex/exterior-trim-controls`; this is a presentation demo, separate from measured geometry.

September 16 development follow-up: [textured finish colors](deploy/digitalocean/development-finish-color-render-20260916.md)
records `de6235dfdd1a7464c70349ebe887fe7855963a42` on all three development roles.
Finish colors use consistent color conversion with or without 3D tiles, preserving
texture shading and selection cues. Source remains on `codex/exterior-trim-controls`.

September 16 development follow-up: [sticker shortcut correction](deploy/digitalocean/development-sticker-shortcuts-20260916.md)
records `3bf6dab5e60a1cf12b710e7afe357cad493b1803` on all three development roles.
L now divides stickers and toggles direction; D is restored for doors.
Roof Parallel Lines and Face Lock retain their existing L shortcut.

September 16 development follow-up: [grouped sticker divisions](deploy/digitalocean/development-sticker-divisions-20260916.md)
records `c0faba77b5fec96a22760e069155ed914e814402` on all three development roles.
D divides windows/doors into linked sections with dashed, deletable seams;
copy/paste preserves the relationship and reports count the combined opening once.
The selected section determines the starting direction; each cut crosses the whole sticker.
Source remains on `codex/exterior-trim-controls`; preserve it in later releases.

September 16 development follow-up: [multi-face extrusion](deploy/digitalocean/development-multi-extrusion-20260916.md)
records `770d80ca598917d152b06e8c023f9eec01e530a9` on all three development roles.
E extrudes complete selected faces and stickers by a shared distance along each
face's own normal, with atomic preview/cancel/undo and combined neighbor cleanup.
The trim, chimney and palette changes are retained on `codex/exterior-trim-controls`.

September 16 development follow-up: [finish color palette](deploy/digitalocean/development-finish-palette-20260916.md)
records `1c3fc2fe458b7b0daee8d288a902353a670a2d13` on all three development roles.
Common, project and recent finish colors are open swatch palettes; custom colors
can be reused without changing the material. This retains the trim/chimney release.
Source remains on `codex/exterior-trim-controls`; preserve it in later releases.

September 16 development follow-up: [trim controls, material filters, and chimney tops](deploy/digitalocean/development-trim-materials-20260916.md)
records `fc6c83129db9ef87205c537de1834f6aa8dadfa7` on all three development roles.
Source is on `codex/exterior-trim-controls`; retain these changes when building
subsequent releases from the concurrent `codex/internal-exteriors` checkout.
Trim cycles and selections are repaired, material filters are available, roof trim
wins coplanar depth ties, and chimney tops get a plain report-excluded default.
The experimental allowlist and production are unchanged.

September 16 development follow-up: [base appearance and report exclusion](deploy/digitalocean/development-base-display-20260916.md)
records `7eb21f3ae0020980c50513d0c662391bfe85d009` on all three development roles.
The default base uses plain concrete gray in textured mode and is omitted from
the exterior report's diagrams and pages. Production and access settings are unchanged.

September 16 development follow-up: [persistent roof and wall undo](deploy/digitalocean/development-persistent-undo-20260916.md)
records `13a21682c9ae26a53a7e0f4569a28230ffd5c31a` on all three development roles.
Undo count limits are removed and project saves retain both undo and redo.
Read the record for the rejected initial candidate, immutable snapshot repair,
and live save/refresh checks. The experimental allowlist and production are unchanged.

September 16 development follow-up: [wall-mode entry and persistence repair](deploy/digitalocean/development-wall-entry-20260916.md)
records `0ea9e7a9cd6d034120e53b8fbe8aaf7ead210031` on all three development roles.
It fixes the first-entry render crash and persists roof/wall mode independently
of generated walls. The experimental allowlist and production release are unchanged.

September 16 development only: [exterior editor update](deploy/digitalocean/development-exterior-editor-20260916.md)
records `24cdfbafda2e7b9f0433ed4964476d36625136ec` on the three development roles.
The experimental editor remains restricted to `jack@1m8.ai`. Production remains
on its existing release; this development rollout did not activate production.

September 15 UTC latest: [exteriors integration and export 188 promotion](deploy/digitalocean/production-exteriors-20260915.md)
records `6eed8c8a0b0f2d02673176a0dda205d2bfc6a685` on all eight production roles
and the signed replacement channel. Exteriors are disabled, the allowlist is
empty, and normal roofing loads no wall/exterior modules or Resources tab.
Only the shared view swap/resize controls are added to roofing. The same tested
release includes export fix 188. Source is on `codex/internal-exteriors`; preserve
this baseline in subsequent work. Production configuration and data are unchanged.

September 15 UTC latest: [177/187 QA feedback and PHP memory release](deploy/digitalocean/production-qa177-php187-20260915.md)
records `42ab264b13fcc953bed4688bf112b12adbcb781d` on all eight production roles
and the signed replacement channel. The original oversized project now displays
both QA notes in the live editor; streaming verified under a 32 MiB PHP limit.
No migration/configuration/image/capacity change. See the linked development
record for save/reload, large-payload and blind-review test evidence.

September 15 UTC (September 14 local) latest: [people-first Tracking release](deploy/digitalocean/production-people184-20260915.md)
records `dcb8064af9f521d408974aa328da36d3393d533c` on all eight roles and
the signed replacement channel. Live Admin directory, search and per-user
networks/activity verified. Collection/viewing permissions are unchanged; no
migration, configuration, image or capacity change. 177/187 follow-up fixes are
not included in this release.

September 14 earlier: [API coverage rejection release](deploy/digitalocean/production-coverage-185-20260914.md)
records release `8a5e84f9348e3f8a4f44eda5b40076acd252cc83` on all eight roles
and the signed replacement channel. Confirmed missing height maps on API orders
now use the shared rejection/refund workflow after expanded-coverage fallback.
The two existing blocked orders were left unchanged for a separate decision.
The people-first Tracking redesign is excluded; existing Tracking/configuration,
image and autoscale capacity are unchanged. No database migration was required.

September 14 earlier: [staff Tracking production record](deploy/digitalocean/production-tracking-20260914.md)
records release `b976d07a3830c26e3e4fe7e7f75057c9f14f1ad3` on all eight
roles and the signed replacement channel. Tracking is enabled for all active
authenticated staff; viewing is restricted to internal Admins and explicit grants.
The replacement overlay includes its non-secret configuration. Live Admin UI,
collection and runtime checks passed. Existing PHP memory failures are tracked
separately in 1M8-187, not fixed by this release. Image/capacity remain unchanged.

September 14 earlier: [production promotion record](deploy/digitalocean/production-promotion-20260914.md)
records release `678cc85b8f13325e0b0142c9b7f65b646881c1ee` across all eight
roles and the signed replacement channel. Image 244899309 and autoscale 6–7
are unchanged. This release includes 176/177/178/182/183/185/186. Read the
expanded pricing-configuration rollback constraint before reverting code.

September 10: [production promotion record](deploy/digitalocean/production-promotion-20260910.md)
records production release `e35b8847eb42d390ba01d734f4b32bb5abe5611c`, signed
replacement image `244899309`, new web inventory, reboot/signature rehearsal and
runtime verification. The old six web hosts have been replaced. Current autoscale
range is 6–7 while retaining ten database connections of planning headroom;
the earlier 6–8 limit and launch IPs below are historical. Consult the promotion
record before changing capacity or rolling back.

September 9 live-incident follow-up: [503 and staff-page recovery](deploy/digitalocean/incident-20260909-503.md)
records the editor session-lock repair, PHP capacity adjustment, and production
readiness environment-file override. Preserve these during subsequent releases.

September 9 follow-up: see [bug-fix releases and verification](deploy/digitalocean/releases-20260909.md), including the unresolved autoscale replacement-code risk. The launch release below is historical, not the current active code.

September 9 capacity/release follow-up: [replacement release delivery](deploy/digitalocean/REPLACEMENT_RELEASES.md)
records the live database audit and the prepared signed private release channel.
The new production web activation guard requires the published channel to match
the staged artifact. This is prepared code, not an activated bootstrap: do not
declare 1M8-173 resolved or use old activation-script copies to bypass the guard.
One-time signing-key/image provisioning and real new-node rehearsal were
completed in the September 10 promotion record.

## Start here

- Develop locally, test in isolated development, then promote the exact tested release to production when authorized.
- Routine releases change code. They do not repeat the customer-data migration, archive integrity scan, or DNS cutover.
- Production is **https://app.1m8.ai**: `/portal/` for customers and `/measure/internal/` for technicians.
- The former `prerelease.1m8.ai` candidate became production. It is **not a sandbox**; its data is now live production data. Its former HTTPS certificate was replaced on port 443 by the app certificate. Use the production hostname.
- `dev.1m8.ai` is the separate development environment. Verify its current inventory, data isolation, and outbound restrictions before testing.
- The SSH alias `dev-sync-droplet` is a separate development/jump host, not the production cluster or the entire development environment.
- Migration is complete: all 11 frozen SQLite databases passed full integrity checks with zero errors. Production has new writes. Never rerun imports or reconcile live records against frozen source counts during a code deployment.

## Canonical source and release baseline

CI, release installation, activation, and verification scripts exist. A fully verified single-command fleet deployment pipeline does **not** yet exist.

The active combined source is `C:/Users/jackh/Code/2026/FirstMate Platform` on
`codex/consolidated-firstmeasure-20260923`. See [the consolidation record](docs/canonical-checkout.md)
for lineage, dirty-work recovery and verification. Original worktrees are retained
as recovery references. Always recheck live source before a release; immutable
release identity and content verification take precedence over historical notes.

## The workflow

1. **Inspect and branch.** Read applicable instructions, inspect Git status, preserve unrelated changes, and identify the affected roles. Use a `codex/` branch unless the user specifies otherwise.
2. **Develop locally.** Use `./start-local.ps1` and `./stop-local.ps1`. Default web address: `http://127.0.0.1:8021`; API: `http://127.0.0.1:3111/v1`. Machine-specific paths are in ignored `local-stack.config.json`. See [README.md](README.md) and `deploy/local-cluster/compose.yml`.
3. **Test the change.** Run appropriate tests and exercise the affected workflow. `.github/workflows/ci.yml` runs smoke and PostgreSQL integration suites. Read current `public/v1/package.json` for commands. A health endpoint does not prove checkout, email, or PDF correctness.
4. **Test in development.** Deploy the exact version to isolated development with development data and provider settings. Keep its databases, storage, credentials, and sessions separate from production. Do not use the former prerelease environment as development.
5. **Prepare the release.** Record commit/release ID, changed roles, dependencies, database/configuration changes, validation, and rollback steps. Confirm the bundle includes PHP/editor assets as well as Node code. Keep secrets and runtime data out of source bundles.
6. **Activate within the user's authorization.** If production deployment is not authorized, finish preparation and present the concrete tested release first. Do not ask again when the session already authorizes it. Coordinate roles, database compatibility, and the autoscale template.
7. **Verify and record.** Verify release identity, actual process configuration, affected workflows, errors, and jobs. Record the outcome and limitations. Do not send test messages or create charges without authorization.

Typical instruction: “Fix this locally and deploy to development for testing; hold production.” After testing: “Deploy that tested release to production and verify it.” Codex handles the individual hosts.

## Architecture and inventory

Historical inventory below must be reverified. Web IPs change when the pool replaces nodes.

| Component | Launch baseline | Responsibility |
| --- | --- | --- |
| Web pool | Six 8-vCPU / 16-GB nodes; minimum 6, maximum 8 | Customer web/API traffic; 8 Node HTTP workers per node |
| Background worker | `146.190.169.59`, 16 vCPU / 32 GB | 8 job slots; PDFs, delivery, background jobs |
| Compatibility | `144.126.222.110`, private `10.124.0.9` | Internal/PHP editor, remaining stateful legacy services, sole platform heartbeat owner |
| Managed PostgreSQL | Database `firstmeasure`, production environment | Shared application data, queues and leases |
| Spaces | Production bucket/prefix from runtime configuration | Shared project artifacts |
| Load balancer | `24.144.68.104`, IPv6 `2604:a880:4:1d0:0:3:62d7:1000` | Public HTTPS and ready-node routing |
| Old frozen source | `64.23.235.5` | Preserved migration source, not active production |

Pool ID: `e1445028-df68-42ed-af43-6c24b16cddf0`.
Load balancer ID: `bb1ffcae-8b3d-448e-b5c0-e98e6b1da41b`.
Image at cutover: `244502867`, plus production bootstrap and browser/code repairs. The image alone is not the complete final configuration.

| Web droplet ID | Public IPv4 at cutover |
| --- | --- |
| 598678504 | 159.223.207.210 |
| 598678505 | 147.182.196.155 |
| 598678506 | 209.38.141.35 |
| 598678507 | 165.232.144.109 |
| 598678508 | 24.199.113.228 |
| 598678509 | 134.199.216.71 |

Services are `firstmeasure-web`, `firstmeasure-worker`, and `firstmeasure-legacy`. Compatibility is not named `firstmeasure-legacy-node`.

Web autoscaling does not increase worker, database, or compatibility capacity. PostgreSQL's launch connection limit was 100, with a planned usable budget of 87. Web pools were capped at 1 connection per Node process; worker/compatibility pools at 4. Recalculate demand before adding processes or overlapping fleets. The successful 6-to-8-to-6 scaling test covered synthetic read/PDF traffic, not every concurrent editing/ordering scenario.

## Access and configuration

Use the existing local SSH configuration. Never print, copy, upload, or transmit private SSH keys.

```powershell
ssh -n -T -J dev-sync-droplet -o BatchMode=yes -o UpdateHostKeys=no -o ConnectTimeout=15 -i C:/Users/jackh/.ssh/id_ed25519_firstmeasure_cluster_v2 root@144.126.222.110 'systemctl is-active firstmeasure-legacy'
```

Omit `-n` when piping a script to stdin. Use literal PowerShell here-strings or properly quoted scripts; never interpolate secrets into command text. The jump host normally uses account `dev` and project directory `/home/dev/code`. A request to sync files does not imply deletion or mirroring.

Verify new web IPs against DigitalOcean inventory before accepting new host keys. Do not disable host-key verification. The old source was administered through DigitalOcean's root browser console; do not assume cluster SSH access to it.

Runtime files live under `/etc/firstmeasure`. Inspect `systemctl show SERVICE -p EnvironmentFiles -p DropInPaths` for precedence, then verify the actual process. Do not dump full environments, provider JSON, credential-bearing NGINX configurations, or customer sessions.

- Shared overlay: `/etc/firstmeasure/production-cutover.env`.
- Provider file: `/etc/firstmeasure/provider-keys.json`; verify effective `PROVIDER_KEYS_PATH` and service-user permissions.
- Historical filenames `preproduction-runtime.env`, `preproduction-worker.env`, and `preproduction-compatibility.env` now configure production roles. Their names do not establish environment safety.
- Web bootstrap fetches the shared overlay privately from `http://10.124.0.9/__firstmeasure_bootstrap_20260908/production.env`, using Host `firstmeasure-production-bootstrap.internal`, VPC restrictions, and existing `x-firstmeasure-legacy-proxy` authentication. Never expose this endpoint publicly or print its response. Worker HTTP access was blocked; do not widen access merely to copy configuration.
- Keep credential locations and validation outcomes in documentation, never values.

## Release installation and rollout

Read [deploy/digitalocean/README.md](deploy/digitalocean/README.md) and the actual scripts. The following are building blocks, not a complete fleet deployment:

```bash
sudo bash deploy/digitalocean/install-release.sh COMMIT_SHA /path/to/release-source
sudo bash /opt/firstmeasure/releases/COMMIT_SHA/deploy/digitalocean/activate-release.sh COMMIT_SHA firstmeasure-web.service
```

These arguments are placeholders. Installation refuses a dirty Git checkout and requires its HEAD to match the release ID. Non-Git source bundles exclude credentials, dependencies, builds, and runtime storage. Installation runs dependency installation, type checking, build, and dependency pruning into a new directory without activation.

Activation switches `current`, restarts the selected service, and checks readiness. Failure triggers an attempt to restore the previous symlink and restart it. Verify recovery actually succeeds: this is not a database or fleet-wide transaction. Worker readiness uses its ready log message. Web/compatibility verification must use the actual listener; the default loopback port 3101 check may not suit every compatibility configuration.

Stage web releases first. Drain/withdraw one node, activate it, verify readiness and application behavior, confirm load-balancer reentry, then continue. Keep sufficient healthy capacity. Do not restart all six together. Worker changes must allow jobs to finish or safely relinquish leases. Compatibility changes can briefly interrupt internal/PHP features while web nodes remain available.

**Update the autoscale image/template/bootstrap to the intended release as well.** Otherwise new nodes can reintroduce old code. Pool configuration changes can replace the fleet and overlap old/new nodes; inspect the behavior and connection budget first. When changing template/image behavior, verify a newly provisioned node, not only a patched existing host.

Run database migrations once through a controlled process. Use additive/backward-compatible changes while old/new code coexist. Normal `POSTGRES_AUTO_MIGRATE` should remain false; web images must not contain database administrator credentials. Destructive schema changes need a separate data recovery plan.

## Production fixes future releases must preserve

### Browser and PDF runtime

Chromium is needed on web, worker, and compatibility hosts: instant PDFs can render inline on web nodes. Use `deploy/digitalocean/install-pdf-browser.sh` with the deployed Playwright dependency's browser revision, OS dependencies, and fonts. Verify under the real service account, supplementary groups, and service restrictions.

At launch, the browser was `chromium_headless_shell-1217` under `/opt/firstmeasure/browsers`, with `/usr/bin/chromium` pointing at its executable. Derive future revisions from the dependency lock rather than hardcoding this forever.

Preserve the `instant_pdf.ts` browser-context fix: the logo calculation inside `page.evaluate` uses `payload.layout.logoHeight`, not Node-only `REPORT_LOGO_HEIGHT_PX`. Preserve the deployed job lease/renewal/completion logic when reconciling source; older worktrees had older interfaces.

Worker `FIRSTMEASURE_PDF_RUNTIME_BASE_URL` is `https://app.1m8.ai/v1/firstmeasure/pdf-runtime`. This is an asset base, not an index/health endpoint. Validate it through native main/summary rendering.

### Worker and scheduled processing

Production worker: `FIRSTMEASURE_JOB_WORKERS=8`, empty `FIRSTMEASURE_JOB_TYPES` (all registered types), `EMAIL_OUTBOUND_DISABLED=0`, `PLATFORM_HEARTBEAT_DISABLED=1`.

Historical `zz-pdf-preview.conf` still loads `/etc/firstmeasure/pdf-preview.env` LAST. It now contains those production values and the app PDF URL. Preserve or deliberately consolidate it. Editing an earlier file alone may not affect the running setting. Do not restore the old PDF-only one-slot hold.

Exactly one heartbeat owner: compatibility `firstmeasure-legacy`. Its `zz-production-heartbeat.conf` loads `/etc/firstmeasure/production-heartbeat.env` with disabled flag `0`. Shared web bootstrap retains disabled flag `1` so scheduled work does not multiply with web nodes.

### Postmark credential and delivery status

The copied credential initially existed only in migration data, not the runtime lookup path. This caused a real failed send despite the migration email hold being removed.

Production now has `POSTMARK_SERVER_TOKEN` in the shared overlay and a fallback file at `/opt/firstmeasure/current/public/v1/storage/secrets/pm_server_token.txt`, readable by the service account. When changing `current`, preserve effective credential access through the external environment or securely provision the fallback. Never rely on a file that exists only inside the old release, or include secrets in source/public artifacts.

Live Postmark authentication and a real requested resend succeeded. Normal business release windows still apply. A completed `report.delivery` job may mean it scheduled a held report, not that it sent an email. Inspect `delivery.email_state.report_email.sent_ok`, provider result/message ID, and `report_sent_at`. Do not retry an accepted send without authorization.

### Stripe and PHP HTTPS forwarding

All eight production roles were verified with live mode and credentials matching the frozen source. Stripe read-only authentication and both configured prices returned live/active results. No real payment was created during this audit.

The live webhook includes `https://app.1m8.ai/measure/internal/server.php`, forwarding to Node's `/v1/platform/stripe-webhook-proxy`.

Compatibility NGINX must preserve HTTPS for PHP behind the load balancer. The deployed fix maps `$http_x_forwarded_proto` to `$fm_forwarded_https` (`https` to `on`, default `$https`) and sets `fastcgi_param HTTPS $fm_forwarded_https` after the FastCGI parameters include. Without it, the bridge called HTTP, received a redirect, and failed. The public negative-signature probe now returns HTTP 400 `Invalid signature`, proving routing/signature rejection, not a full payment test.

Preserve the compatibility PHP app API map: `$fm_preview_php_platform_base` maps `app.1m8.ai` to `https://app.1m8.ai/v1/platform`. Web proxies preserve original `X-Forwarded-Proto`. Do not replace deployed configuration with old loopback-only templates.

### Other provider/configuration checks

Google/Gemini and internal API keys resolved under the actual service user on all eight hosts; Telnyx, Meta, and Statsig credential variables were present. Presence does not prove every external operation works. Test the provider affected by a change using an appropriate non-destructive check.

Repository NGINX/systemd examples may predate these repairs. Reconcile hostname maps, TLS forwarding, secret permissions, browser provisioning, private routing, and configuration precedence before replacing live configuration.

## Verification, rollback, and DNS

Verify the intended release, process configuration, ready-node count, and affected workflow. For broad releases include authenticated customer/staff access, authorized representative save/submit behavior, native PDFs, queues, providers, and public Stripe routing. A login page returning 200 does not prove authenticated login; credential presence does not prove a transaction.

Keep the previous code release. Code rollback requires database compatibility and does not reverse migrations, email, charges, or edits. The frozen old server is not a lossless rollback target after new production writes. Preserve/reconcile those writes before any return to it; never automatically restart its writers or rerun imports.

Routine code releases leave DNS alone. The app subdomain is delegated to DigitalOcean; the parent `1m8.ai` remains at GoDaddy. App A/AAAA point to the load balancer, TTL 600. Managed certificate `app-1m8-ai-production-20260908` serves HTTPS443. An app certificate also remained on staging port 444; that is not the normal user endpoint.

## Recovery and evidence

Private chronological handoff: `C:\Users\jackh\.codex\recovery\firstmeasure-20260907\CURRENT-STATE.md`. Read newest entries first. Older migration documents contain superseded candidate/hold/pending-scan states. The recovery directory includes bootstrap and targeted repair/audit scripts; review before running, because some are one-time mutations.

Compatibility evidence under `/var/lib/firstmeasure-migration/final-20260908/`:

- `validation-readiness-current.json`: completed cutover and validation.
- `sqlite-validation-status`: `SQLITE_VALIDATED`; `sqlite-validation-private.json`: all 11 passed. Avoid printing private paths/customer records.
- `post-cutover-provider-audit.json`: live provider audit, also on other hosts.
- `lawndale-email-repair-validation.json`: accepted requested resend; do not replay.
- Private configuration archives and before-change backups: inspect selectively, never dump.

Worker `/var/cache/firstmeasure/production-pdf-runtime-validation.json` records native main/summary rendering through the production domain without application writes.

The `watch-firstmeasure-pre-sync` automation was paused after scan success. That completed watcher is not an ongoing production incident monitor. If monitoring is requested, define its checks, schedule, and notifications explicitly.

For subsequent deployments, update this guide or a linked release record with release/template IDs, configuration changes, verification, and outstanding work. Do not record secrets or customer data.
