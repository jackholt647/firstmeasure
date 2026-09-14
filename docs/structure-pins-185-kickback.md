# 1M8-185: height-map kickback, September 14

## Production diagnosis (read-only)

The production worker runs b976d07, including the earlier no-Building-Insights
fallback. Both reported orders remain needs_structure_pins / failed. This is
not an omitted rollout. No production manifest, pins, billing, customer delivery,
or workflow state was changed during diagnosis.

The two reported projects (Worthington and Clay City) have three and two saved
pins respectively. The actual deployed geometry functions produced 60m capture
areas at their pin-centered locations, with pixelSizeMeters=0.1 and LOW minimum
quality. Google dataLayers returned HTTP404 / NOT_FOUND and no DSM URL for both.
Independent 20m requests at each of the five individual saved pins also returned
404 / NOT_FOUND. Building Insights failed at all five pins as well.

Google documents dataLayers NOT_FOUND as outside its coverage area:
https://developers.google.com/maps/documentation/solar/reference/rpc/google.maps.solar.v1

The old fetchJson/fetchBinary helpers discarded HTTP failures and eventually
reported only `dsm_missing`. Thus missing coverage, permissions, rate limits and
failed downloads were indistinguishable. Background processing put all errors
back into Needs Structure Pins, although pins were already correctly supplied.

## Local fix (not deployed)

- Required Solar layers distinguish coverage 404 from provider HTTP failures and
  malformed responses. Error strings do not expose credential-bearing URLs or
  raw provider response bodies.
- Required DSM downloads fail explicitly when missing, unsuccessful, empty or
  lacking a TIFF header. A failed/expired download URL is not called no coverage.
- Confirmed dataLayers no coverage goes to existing needs_coverage_review /
  waiting queue handling. Other failures retain retryable Needs Structure Pins.
- Pins, coordinates, billing and refund state are untouched by the failure patch.
  No automatic rejection, submission, notification or fabricated DSM is added.
- Existing instant-report restrictions remain intact.

Seven focused tests pass, covering provider status branches, download failures,
full process orchestration with valid/no-coverage fixtures and actual background
processing state updates. TypeScript check passes. Provider fixtures do not prove
availability of alternate imagery at the two addresses; real read-only requests
above established the current Google failures.

## Still needed

The user has been asked whether the team can complete these using an approved
alternate/manual imagery workflow or needs coverage review for cancellation.
The code fix prevents a misleading retry loop; it cannot create missing geographic
height data. Do not call these two reports unblocked or mark 185 fully fixed on
the strength of this change. Production activation and any order-specific action
remain outstanding. Tracking's people-first redesign is a separate local commit;
do not accidentally include it in an urgent production release without review.
