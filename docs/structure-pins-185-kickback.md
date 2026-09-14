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

## Expanded verification and public API follow-up

After Jack challenged the initial conclusion, additional read-only requests used
`requiredQuality=BASE`, `experiments=EXPANDED_COVERAGE`, `view=DSM_LAYER`, and
0.5m pixels. Both 60m pin-centered requests and all five 20m individual-pin
requests returned 404 / NOT_FOUND with no DSM. Separately, LOW / DSM_LAYER /
1.0m pixels / exactQualityRequired=false also returned 404 for both centers.
An independent control at Google's documented example coordinates returned 200
and a downloadable image/tiff (69,785 bytes) using the same production credentials.
This rules out a general credential failure and the tested view/resolution paths;
it does not prove that no Google product or other provider has any height data.
Expanded coverage is documented as experimental; it was probed only, not enabled
as an automatic production fallback.

Public API report polling already reads current manifest status. Staff coverage
rejection uses /projects/:id/coverage/reject, which performs refund bookkeeping
and rejection email handling before/after the rejected_no_coverage transition.
None of those production actions were exercised. Found/fixed locally: API report
summaries omitted rejection details for legacy rejected_no_coverage records with
no reason, and ignored customer_rejection_message set by the staff workflow.
The summary now supplies a no_coverage reason/status-based message fallback and
uses the staff customer-facing message when no explicit rejection_message exists.
Pending needs_coverage_review remains non-terminal, not a rejection. Three new
tests plus the existing seven pin tests pass. This verifies serialization, not
live refund execution or customer webhook delivery. The public /webhooks/test
endpoint is a test receiver, not evidence of outbound rejection notifications.

## Remaining decision

### User decision: automatically reject API orders without height-map coverage

Jack confirmed that API orders must mirror frontend coverage rejection when no
height map can be obtained. Implemented locally (not activated):

- Required dataLayers requests try BASE/EXPANDED_COVERAGE after standard 404,
  keeping coordinates unchanged. Only another 404 is confirmed no coverage;
  provider errors, missing URLs and failed TIFF downloads remain retryable.
- All API-origin imagery entry points share a wrapper that routes confirmed
  no-coverage through the same rejection function used by the staff endpoint.
  Non-API orders retain existing coverage-review handling. No permission or
  authentication bypass endpoint was added.
- The shared workflow retains organization credit refund bookkeeping, terminal
  rejected_no_coverage status, customer-facing reason/message and rejection email.
  Structure-pin state becomes rejected, not ready; background success handling
  cannot overwrite that terminal result.
- A shared project rejection lock serializes repeats. The credit transaction
  deduplicates rejection refunds using project + original charge token so a retry
  after a manifest-write failure cannot issue another refund. A newly charged
  reorder has a distinct key. Terminal repeats do not resend rejection emails.
- Twelve focused tests exercise standard/expanded coverage, transient failures,
  concurrent shared rejection, retained coordinates and API serialization.
  No production rejection, refund, email, or deployment was performed.

The earlier open decision below is historical and superseded by this instruction.

The user has been asked whether the team can complete these using an approved
alternate/manual imagery workflow or needs coverage review for cancellation.
The code fix prevents a misleading retry loop; it cannot create missing geographic
height data. Do not call these two reports unblocked or mark 185 fully fixed on
the strength of this change. Production activation and any order-specific action
remain outstanding. Tracking's people-first redesign is a separate local commit;
do not accidentally include it in an urgent production release without review.
