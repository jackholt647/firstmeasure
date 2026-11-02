# Production release 091e5c36: the Exteriors engine from dev, full-house switched on for Jack and Ben, and the Full Exterior training course, October 29, 2026

Released at Jack's request ("get it fully pushed"). It is production `ef39262b` (records `24fe5bab`) plus `091e5c36`: the editor from the measure-internal lane `a57dbbd9`, which dev.1m8.ai serves.

## What changed

- **Editor.**
  - All 30 changed editor scripts are byte-identical to the lane. Three are new: `wall_stickers.js`, `wall_roof_rebuild.js` and `exterior_cover.js`.
  - From `editor.php`: the three script tags and the pane-divider code. From `project_resources.php`: the `source_video` field.
  - The editor's request-security PHP (`_staff_session.php`, signed Node calls, `backend_login.php` and the rest) stays out. It needs production's Node roles to have the request-security release first.
  - `portal_scripts/customers.js` stays at production's version, which keeps the 1M8-249 fix. `index.php` and `feature_flags.js` stay too: they read the config library, which production doesn't have.
- **Roof reports.** Before release, the same roof report was rendered with production's scripts and with the lane's, in six scenarios (full, summary, defaults, customer cover settings full and summary, commercial flat), and every jsPDF call was compared.
  - Every page is identical except two:
    - Ventilation: the diagram and its key now sit in one card.
    - Notes: the layout is about 7 mm shorter, so the page footer shows again.
  - Production has no `report_orientation` anywhere, so roof reports stay portrait.
- **Full-house setting.** `FIRSTMEASURE_FULL_HOUSE_ENABLED=1` and `FIRSTMEASURE_FULL_HOUSE_EMAILS=jack@1m8.ai,ben@1m8.ai` were appended to `/etc/firstmeasure/production-cutover.env`:
  - on compatibility, whose copy is also the bootstrap overlay that new web nodes fetch;
  - on all six web nodes.
  - It opens training and direct full-house drafts for those two people only. Customer exterior orders are unaffected.
- **Training data.** Seven `fullhouse_` sources were copied from development with their development IDs, written with `createProject({fullHouse:true})`, `saveArtifact` and `saveAppMetadata`. That came to 619 PutObject calls with 0 failures.
  - Only imagery, the height map, the mask, insights, reference photos and video chunks, plus the drawing, were copied. Editor undo history was not.
  - The sources: 4725 W Mercer Way, 9632 Lake Washington Blvd NE, 9311 SE 36th St, 2605 Camas Ave NE, 17415 159th Ave SE, 14100 SE 171st Way and 15952 SE 176th Pl.
- **Curriculum.** `tutorials/courses/full-house-drawing/master/curriculum.json` (course "Full House Drawing") has three chapters:
  1. Intro to Full Exterior Reports;
  2. Foundations and Grades;
  3. Exteriors Practice, which is hidden with an empty `visible_to`.
  - Development's earlier 8-chapter outline is kept beside its curriculum as `curriculum.outline-20261029.json`.

## Rollout (UTC)

- **Build.** Built on the dev worker with `build.sh`. Archive `56212258…`, 363,789,968 bytes, verified.
- **Compatibility, 11:07.** Ready, with 0 errors in the next 20 s. Its environment shows both settings.
- **Web nodes, 11:08–11:18,** one at a time. Each was withdrawn with the NGINX health route (4–5 load-balancer probe failures seen) and `firstmeasure-web` restarted in place on `ef39262b`. The setting, pool 4 and 8 workers were checked in each process environment before the node rejoined.
- **Worker and signed channel.** Unchanged (`ef39262b`): only compatibility serves `/measure/internal`, and the Node code is identical.

## Checks

- Public readiness answered from all six web nodes.
- In Jack's session on app.1m8.ai:
  - The course shows three chapters.
  - Six of the seven sources pass the training check.
  - A chapter 1 practice started, and the editor opened in Tutorial Mode with imagery, the height-map 3D view, the four-way photo view and the exterior tools.
  - The editor served `wall_mode.js` with SHA-256 `edf93953…`, which matches the lane.

## Open

- **9632 Lake Washington Blvd NE.** It has no photo tagged `right`, so Foundations and Grades practice refuses to start until one is tagged in Resources.
- **17151 158th Ct SE.** It was left out because it has no elevation tags.
- **Hidden chapters.** Hiding is applied in the page only. The server checks course assignment, not chapter visibility.

## Rollback

- **Compatibility:** `activate-release.sh ef39262b0ef277b6d84e6341251741d3851b5a46 firstmeasure-legacy.service`.
- **Setting:** each host keeps `production-cutover.env.before-full-house-20261029`. Restore it and restart the service, draining web nodes as above.
