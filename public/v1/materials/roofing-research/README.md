# Roofing catalog research (2026)

[roofing-catalog-2026.json](roofing-catalog-2026.json) is source data for the
guided price book setup for roofing companies. It covers four shingle
manufacturers, their product lines and system accessories, common non-brand
items, labor and service lines, estimating rules written over measurement
dictionary keys, and regional price multipliers. Every figure cites a source.

Researched 2026-10-24. Nothing in the platform reads this file yet. It is input
for the setup flow and for extending
[roofing-library-data.ts](../roofing-library-data.ts).

## What is in it

| Part | Count | Notes |
|---|---|---|
| `manufacturers[]` | 4 | GAF, Owens Corning, Malarkey, CertainTeed ("Certainty" is listed as an alias) |
| `product_lines[]` | 20 | 3-tab, architectural, premium architectural, impact-rated (UL 2218 Class 4) and designer |
| `accessories[]` | 31 | starter, hip & ridge, synthetic underlayment, ice & water, ridge vent |
| `generic_items[]` | 16 | drip edge, pipe boots, step/head wall flashing, valley metal, nails, cap nails, sealant, decking, generic underlayment |
| `labor_items[]` | 11 | tear-off, extra layers, install, three steep tiers, high roof, hand-carry, decking per sheet, dumpster, permit |
| `estimating_rules[]` | 27 | Each has a plain-language explanation, a formula, a price book formula where one is possible, and its unit |
| `regions[]` | 6 | national, Northeast, Midwest, South, Mountain West/Southwest, Pacific |
| `sources[]` | 67 | URL, access date and kind (manufacturer, retail listing, cost guide, code, sample estimate) |

## Method

1. Read the existing library (`roofing-library-data.ts`, supplier research of
   2026-10-12), the price book template (`pricebook/default_template.ts`,
   `constants.ts`, `schemas.ts`) and the roofing measurement schema
   (`platform/publication/measurement-schemas.ts`).
2. Took product facts (bundles per square, pieces per square, lineal feet per
   bundle, roll sizes, impact class) from manufacturer data sheets and pages
   where they could be fetched. Malarkey's sheets were read directly. GAF's site
   blocks automated fetches, so GAF figures come from GAF documents found in
   search results and retailer listings that quote the wrapper.
3. Took prices from 2026 retail and supply-house listings (Home Depot, Lowe's,
   All Roofing Supply, ASO, McCoy's, as reported by The Roofing Brief on
   2026-10-09 and 2026-10-19), the library's 2026-10-12 observations, and 2025-2026
   cost guides. ABC Supply, SRS/Roofhub and Beacon do not publish prices
   without a contractor login, so no supply-house list price from them is used.
4. Wrote estimating rules as formulas over dictionary keys and checked each
   identifier against the dictionary with a script.

## Confidence and what is estimated

Every priced entry has a `price_confidence`:

- **observed**: a public listing showed this price. The date is in the
  price note or the source.
- **sourced_range**: one or more cost guides or listings support the range.
  The default is a point inside the range.
- **estimate**: no current price was found. The value is reasoned from related
  figures, and the price note says how.

Facts with lower confidence have a `*_confidence: "estimate"` field next to
them (for example `bundles_per_square_confidence`).

**Least certain items:**

- **Malarkey prices.** All are estimates. Malarkey publishes no prices, no
  2025-2026 listing was found, and the 2024 cost-guide tables contradict each
  other. Ask a Malarkey distributor.
- **Impact-rated premiums.** GAF Timberline AS II and CertainTeed Landmark
  ClimateFlex have no price found. Duration FLEX and STORM have one 2026
  review only.
- **Designer lines.** Grand Sequoia, Presidential Shake and Windsor have
  estimated prices. Presidential Shake's 5 bundles per square comes from a
  retailer listing of the same-format Presidential line plus 90 shingles per
  square on the data sheet. The existing template also uses 5.
- **CertainTeed XT 25 and ClimateFlex bundles per square.** Both use the
  3-bundle norm, which no CertainTeed sheet confirmed.
- **Underlayment roll sizes for ProArmor, RhinoRoof and Tiger Paw.** These
  assume the usual 10-square roll.
- **Steep, high-roof and hand-carry adders.** Published figures disagree:
  flat $25-75 per square, +15-50% of labor, or Xactimate sample lines
  (about $66 per square for 7-9/12 and $104 for 10-12/12). The defaults are
  judgement calls. There is no published figure above 12/12.
- **Warranty accessory counts.** Owens Corning's published versions say "2 of
  4" or "3 of 4" component categories. GAF's Golden Pledge charts say 4 or 5
  accessories. No current CertainTeed document gave a count. All three are
  summarized and flagged rather than stated as rules.
- **Regional multipliers.** These come from cost guides about installed cost,
  which is mostly labor. The Roofing Brief's figures are its own editorial
  estimates; CalcSummit's labor table cites RSMeans 2026.
  `material_multiplier` is our own estimate, kept near 1.0, because supplier
  price differs more by supplier and volume than by region.
- **Allowances in rules.** These are rules of thumb, not published standards:
  the waste-from-complexity hint, the 5% on drip edge and flashing, nails and
  cap nails per square, sealant tubes, and 30 squares per dumpster.

**Prices move.** Shingle makers announced two 2026 increases: about 5-8% in
spring and 6-9% on June 1. Aluminum flashing rose 10-13% after the April 2026
Section 232 change. Treat every default as a starting point and ask the
organization for its supplier prices as early in setup as possible.

## Alignment with existing code

- **Ids.** Items that already exist in `roofing-library-data.ts` keep their
  `lib-*` id. 45 catalog entries reuse a library id. 22 are new and follow the
  same pattern (`lib-shingle-<brand>-<line>`, `lib-starter-…`, `lib-ridge-…`,
  `lib-underlay-…`, `lib-iws-…`). Labor and service lines have new
  `labor-*`/`service-*` ids, because the library has none.
- **Template links.** `template_item_id` names the matching item in
  `pricebook/default_template.ts` where there is one: `gaf_hd`, `gaf_uhdz`,
  `gaf_ns`, `owens_duration`, `malarkey_vista`, `gaf_grand_sequoia`,
  `ct_presidential_shake`, `starter`, `ridge_cap`, `underlayment`,
  `gaf_feltbuster`, `gaf_tiger_paw`, `ice_water`, `gaf_weatherwatch`,
  `owens_weatherlock`, `drip_edge`, `valley_metal`, `step_flashing`,
  `headwall_flashing`, `ridge_vent`, `tearoff`, `steep_slope`,
  `pipe_boot_lifetime` and `sealant_misc`.
- **Manufacturer ids.** These are the `PRICEBOOK_MANUFACTURERS` values:
  `gaf`, `owens_corning`, `malarkey`, `certainteed`.
- **Units.** Product lines are priced per order unit (bundle, roll, piece,
  box). Rules compute quantity in the price book unit (`sq`, `lf`, `ea`), and
  `order_packaging` converts it to order units, the same way the template's
  `units_per_package` and `packages_per_unit` work.
- **Formulas.** `pricebook_formula` uses only dictionary keys, numbers,
  `+ - * /` and parentheses, so it maps directly to `formula_config.tokens`.
  Rules that need a non-dictionary input have `pricebook_formula: null` and
  list the input in `inputs[]`.

**Differences from existing code to resolve:**

1. **`shingleSquares` is not a dictionary key.** The template uses it. The
   dictionary equivalent is `roofSquares - flatRoofSquares`.
2. **The template's ice & water formula looks wrong.** `LEAK_BARRIER_FORMULA`
   takes `(valleyLf + eavesLf + rakesLf) / 100 + pitch2to4Squares`. That
   counts 1 ft of width per foot of eave and adds rakes. The researched rule is
   `(eavesLf * 6 + valleyLf * 3) / 100 + pitch2to4Squares`, with the eave width
   an organization setting (6, 3 or 0 ft).
3. **WeatherWatch roll size differs.** The template's `gaf_weatherwatch`
   assumes a 1.5-square roll. The library and retailers list the 2-square
   (36 in x 66.7 ft) roll, and a 36 in x 50 ft roll also exists. Pick one per
   SKU.
4. **Missing dictionary keys.** `pipeBootsEa`, stories, tear-off layers and
   `wastePercent` are not in the dictionary. Pipe boot count and stories
   should probably become dictionary definitions, because roof reports carry
   them. Waste is a price book variable.
5. **Pitch bands do not match Xactimate's steep tiers.** The dictionary splits
   at 6, 8 and 12. Xactimate splits at 7-9/12 and 10-12/12. The exact-pitch
   keys (`pitch7Squares` and so on) can rebuild Xactimate tiers if a company
   needs them.
6. **Owens Corning squares are smaller.** A 3-bundle "square" covers 98.4
   sq ft, so use `100 / coverage_sq_ft_per_bundle` rather than a flat 3.

## How the setup flow should use it

Show these steps in order:

1. **Region.** Pick from the state of the organization's address
   (`regions[].states`). Apply `price_multiplier` to labor and service
   defaults. Apply `material_multiplier` to materials only until the
   organization enters supplier prices.
2. **Manufacturers.** Show the four `manufacturers[]` with their `logo_hint`
   wordmark and colour, plus "Use all". Use text wordmarks: Malarkey marks its
   logo "no reproduction without prior permission", and none of the brands has
   granted logo use. For Malarkey, show its `availability_note`.
3. **Shingle lines per brand.** Group by `tier` (3-tab, Architectural,
   Premium, Impact-rated, Designer). Preselect `popular: true` and offer
   "Include all". Show bundles per square and the default price per bundle.
   Let the user override the price inline.
4. **Accessories.** Default to the same brand's starter, hip & ridge,
   underlayment, ice & water and ridge vent. Show one sentence from
   `warranty_system.summary`, for example: "Using GAF starter, ridge cap and
   underlayment keeps the roof eligible for GAF's enhanced warranties." Let
   the user swap in a generic or another brand's item. Malarkey has no ridge
   vent, so suggest Air Vent ShingleVent II.
5. **Common items.** `generic_items[]`, with optional items unchecked.
6. **Labor.** Install, tear-off, steep tiers, dumpster and permit. Each shows
   its range and default.
7. **"How we figure your materials".** Show the rules with
   `show_in_setup: true` in `order`, one card each:
   - the `label`;
   - the `explanation` as written;
   - the formula rendered with friendly measurement labels from the
     dictionary (for example "Eaves + Rakes");
   - the `worked_example`, or one computed from a sample roof.

   Show these rules: shingle squares, waste, shingle bundles, starter, hip &
   ridge, ice & water, underlayment, drip edge, ridge vent, step flashing,
   pipe boots, decking allowance, tear-off, install labor, the three steep
   charges, dumpster and permit.

   Only two rules need a choice: waste (four options) and ice & water width
   (two rows, one row or valleys only). Every other rule is shown, not asked.
   Put the rest (head wall flashing, valley metal, nails, cap nails, sealant,
   extra layers, high roof, hand-carry) under "More details".

Do not show `price_confidence` labels to the roofer. Instead, mark every
default as "typical price, replace with yours". Keep the source list for
support and for agents explaining a number.

## Keeping it current

Update prices by adding newer observations and changing `researched_on`. Do
not silently overwrite a sourced figure. If a manufacturer changes a bundle or
roll size, add a new product entry rather than changing the old one, because
existing price book items may carry the old packaging.
