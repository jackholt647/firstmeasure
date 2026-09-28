import {z} from 'zod';

const labels=z.record(z.string().min(1).max(160),z.record(z.string().min(1).max(160),z.string().max(160)));
/** Validate display values at the common persistence boundary, including API callers.
 * Keep unknown module metadata and installed/future locale dictionaries intact.
 */
export const terminologyMappingsSchema=z.object({labels:labels.optional(),localized_labels:z.record(z.string().min(2).max(40),labels).optional()}).passthrough();
