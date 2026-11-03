# Production hotfix cb4034d8: the guide preview works without Exteriors, November 3, 2026

Released on Jack's request ("that will need to be pushed to prod because I'm doing my testing there"). Run from this PC through fm-agents-1.

It is production-live `b0a441a3` (release `ac09d330`) plus one commit, cherry-picked from canonical `23526c6f`: `cb4034d8`. 3 files, +23/−13.

## Change

`FirstMateGuides.preview(id)` (`GET /v1/guided-experiences/organizations/:orgId/experiences/:id/preview`) no longer checks the experience's eligibility (capabilities, permissions, conditions) or introduction. It still needs a signed-in session in the organization, still records nothing, and steps keep their own eligibility. Ordering is checked by the order flow, so an organization without Exteriors can see the Exteriors popup but cannot order a Full Exterior.

## Checks before release

- Dev: `platform-20261103043840-9951252c`, with `npm run check`, `flag-introductions`, `guided-experiences`, `guided-experiences-dev`, `guided-tab-tours` and `setup-steps` passing on the server. In Jack's dev org without Exteriors, the preview opened the popup.
- Build on the dev worker: archive sha256 `4e2b59ff1dc9d0dec109a24711d4405532b1526bfb27262ef0ed0552230abb34`, verified there and again on compatibility and the worker.

## Rollout

- The tracker bug-fix router was stopped at 04:39:48 UTC. FM-322's worker, started at 04:33, kept running on its own; its production step waits for the router.
- Compatibility at 04:48 UTC from `ac09d330`; Node ready on `cb4034d8`. Background loops still off, full house on.
- Worker at 04:48:45 UTC, after no running jobs: 8 slots, production.
- Signed channel published against `b7a37755…` (from the release's real path; the `current` path does nothing).
- Six web nodes from 04:50:27 to 05:03:39 UTC, one at a time, each drained, ready, assets matching, pool 4, 8 workers, full house on, back behind the load balancer before the next.

## After

- Public readiness `cb4034d8` 20 of 20.
- In Jack's production org without Exteriors, `FirstMateGuides.preview('exteriors.introduction')` showed Ben's popup with his own Get Started button. Escape closed it. Only the two GETs (`/preview`, `/billboards/exteriors_popup`) were sent, so nothing was recorded.
- 5xx: compatibility 0.26% since activation; web nodes 0–0.34%, all the existing `top_view_reroll_proxy.php`; no restarts.

## Rollback

Every role keeps `ac09d330`. Republish its archive (`b7a37755…`) to the channel from `/opt/firstmeasure/releases/ac09d330…/deploy/digitalocean/`, then `activate-release.sh ac09d330… <service>` on each role. Code only.
