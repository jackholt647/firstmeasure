import { readInternalUser } from '../internal/storage.js';
import { FirstMeasureError, conflict } from './errors.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};

// The experimental fullhouse_ workspace remains a non-deliverable draft.
export function isCustomerFullHouse(manifest: RecordValue): boolean {
  return /^exteriors_[a-f0-9]{32}$/.test(String(manifest.id ?? manifest.project_id ?? ''))
    || (manifest.measurement_scope === 'full_house' && manifest.internal_only !== true && !String(manifest.id ?? '').startsWith('fullhouse_'));
}

export type FullHouseWork = 'draft' | 'qa';
export async function fullHouseEligible(email: unknown, work: FullHouseWork): Promise<boolean> {
  const normalized = String(email ?? '').trim().toLowerCase();
  if (!normalized) return false;
  const user = await readInternalUser(normalized);
  return user?.[work === 'draft' ? 'can_draft_full_house' : 'can_qa_full_house'] === true;
}

export async function assertFullHouseEligible(manifest: RecordValue, email: unknown, work: FullHouseWork) {
  if (isCustomerFullHouse(manifest) && !await fullHouseEligible(email, work)) {
    throw new FirstMeasureError('full_house_qualification_required', 403,
      work === 'draft' ? 'This technician is not enabled to draft full-house reports.' : 'This reviewer is not enabled to QA full-house reports.');
  }
}

// Validate the exact snapshot pinned to the reviewed PDF job, not mutable editor metadata.
export function assertFullHouseSnapshot(manifest: RecordValue, value: unknown) {
  if (!isCustomerFullHouse(manifest)) return;
  const snapshot = record(value), exterior = record(snapshot.exteriorReport);
  if (snapshot.folderId !== manifest.id) throw conflict("full_house_snapshot_mismatch", "Regenerate the PDF for this full-house project.");
  const walls = Array.isArray(exterior.walls) ? exterior.walls : [];
  if (!walls.length || !(Number(record(exterior.totals).gross) > 0) || record(snapshot.exteriorSettings).include === false) {
    throw conflict('full_house_exterior_required', 'A full-house report requires measured exterior walls and the exterior report pages.');
  }
  const report = record(snapshot.report);
  if (!Array.isArray(report.lines) || !report.lines.length || !Array.isArray(exterior.roof) || !exterior.roof.length) {
    throw conflict('full_house_roof_required', 'Complete the roof measurements before submitting this full-house report.');
  }
  const stories = record(record(snapshot.gutterSettings).stories);
  if (snapshot.includeGutterMeasurements === false || manifest.include_gutter_measurements !== true
    || ['north', 'south', 'east', 'west'].some(direction => !Number.isInteger(Number(stories[direction])) || Number(stories[direction]) < 1 || Number(stories[direction]) > 9)) {
    throw conflict('full_house_gutters_required', 'Full-house reports require gutters and completed stories on all four sides.');
  }
}

export const FULL_HOUSE_REVIEW_FIELDS = ['roof', 'walls', 'openings', 'finishes_trim', 'gutters', 'references', 'pdf'] as const;
export function assertFullHouseReview(manifest: RecordValue, value: unknown) {
  if (!isCustomerFullHouse(manifest)) return;
  if (FULL_HOUSE_REVIEW_FIELDS.some(key => record(value)[key] !== true)) {
    throw conflict('full_house_review_required', 'Confirm the roof, walls, openings, finishes and trim, gutters, references and full PDF before approving.');
  }
}

export const FULL_HOUSE_QUALITY_CATEGORIES = [
  'missing_exterior_wall', 'incorrect_wall_dimensions', 'incorrect_openings',
  'incorrect_finishes_trim', 'missing_or_incorrect_gutters', 'incomplete_exterior_references'
] as const;
