# SMS registration copy and marketing examples — October 11, 2026

Removes descriptive sidebar subtitles while retaining completion/attention states.
Moves editable campaign description to Business (step 1) with matching validation
and error navigation. Step 6 heading is Review and Submit. Removes requested
attachment/privacy explanatory lines and standardizes example-link copy.

Draft START replies name selected purposes and include the purchase disclaimer
for marketing. Maximum-length (75-character) brand names fit the 255-character
reply bound. Existing submitted campaigns retain their registered START copy.
Adds required second marketing sample (sample4), its different expandable example,
and client/server completeness checks. Preserves saved sample4; does not populate
sample text. Additional sample5 remains optional.

Validation: four browser tests cover description placement, second marketing field,
sidebar empty status, updated policy labels, START content/length and submitted
copy preservation. Focused API workflow verifies second marketing sample required
and successful provider payload. Development-only guarded per-host overlays.
No provider submissions, purchases or real messages in tests.

## Development verification

Activated `0200f8b07c24bd5c46ec6b9643923864e8933708` on all four dev roles;
HTTP readiness passed and worker is active. Concurrent Activity rollout changed
web's release afterward; its SMS frontend/API hashes exactly match this payload.
Public readiness is healthy and the public settings asset matches SHA-256
`051d8759a16ad1becfe3e87cdeb776249aff5f2cb5b39d49ef196364019181fe`.
All four browser tests pass against merged live source. No production changes.
