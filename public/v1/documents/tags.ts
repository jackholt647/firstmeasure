import { badRequest } from '../platform/errors.js';
/** Stable exact-match labels; never infer semantic tags from titles. */
export function documentTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 50 || value.some(tag => typeof tag !== 'string' || tag.trim().length > 80)) throw badRequest('document_tags_invalid', 'Use at most 50 text tags of 80 characters.');
  return [...new Set(value.map(tag => tag.trim().normalize('NFKC').toLowerCase()).filter(Boolean))];
}
