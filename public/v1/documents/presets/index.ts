/**
 * Seeded preset themes + templates (contract path: documents/presets/index.ts).
 *
 * The implementation lives in ../seeds.ts; this module is the stable import
 * surface the contracts document names. Seeding follows the scope-template
 * preset pattern: metadata.preset + preset_revision drive first-use seeding
 * and shipped upgrades, while org-forked copies are never overwritten.
 */
export {
  DOCUMENT_PRESET_REVISION,
  THEME_SEEDS,
  TEMPLATE_SEEDS,
  ensureDefaultDocumentAssets,
  ensureDefaultDocumentAssets as ensureDocumentPresets
} from "../seeds.js";
