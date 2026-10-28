# Roofing catalog research (2026)

> The research files that used to sit here are config library entries now
> ([config library](../../../../docs/architecture/config-library.md)):
> `pricebook_setup/roofing.catalog` (was `roofing-catalog-2026.json`),
> `pricebook_setup/roofing.components` (was `roof-type-components-2026.json`),
> `pricebook_setup/roofing.suppliers` (was `roofing-suppliers-2026.json`), and the
> 2026-10-12 library `material_library/roofing` (was `roofing-library-data.ts`).
> Each keeps the schema described below. Replace or extend them on dev through the
> library (same fields); nothing else needs to change. This file stays as the
> record of how the research was done.

The roofing research catalog is source data for the
guided price book setup for roofing companies. It covers the eight major US
residential asphalt shingle manufacturers, their logos, their product lines
and system accessories, common non-brand items, labor and service lines,
estimating rules written over measurement dictionary keys, and regional price
multipliers. Every figure cites a source.

Researched 2026-10-24. The guided price book setup
([pricebook/setups/roofing.ts](../../pricebook/setups/roofing.ts)) reads it. It
is also input for extending the roofing material library.

## What is in it

| Part | Count | Notes |
|---|---|---|
| `manufacturers[]` | 8 | GAF, Owens Corning, Malarkey, CertainTeed ("Certainty" is listed as an alias), IKO, Atlas, TAMKO, PABCO. Each has a `logo` (see [Logos](#logos)) and a `lineup_note` saying what was checked and what was left out |
| `manufacturers_considered[]` | 6 | Brands looked at, and why each is or is not included |
| `product_lines[]` | 62 | 3-tab, architectural, premium architectural, impact-rated (UL 2218 Class 4) and designer |
| `accessories[]` | 66 | starter, hip & ridge, synthetic underlayment, ice & water, ridge vent |
| `generic_items[]` | 16 | drip edge, pipe boots, step/head wall flashing, valley metal, nails, cap nails, sealant, decking, generic underlayment |
| `labor_items[]` | 11 | tear-off, extra layers, install, three steep tiers, high roof, hand-carry, decking per sheet, dumpster, permit |
| `estimating_rules[]` | 27 | Each has a plain-language explanation, a formula, a price book formula where one is possible, and its unit |
| `regions[]` | 6 | national, Northeast, Midwest, South, Mountain West/Southwest, Pacific |
| `sources[]` | 256 | URL, access date and kind (manufacturer, retail listing, cost guide, code, sample estimate) |

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
5. Checked each brand's 2026 lineup against its own product pages. For GAF,
   Owens Corning and Malarkey, also checked the 2026 price-increase letters
   they sent distributors (hosted by ABC Supply), which list every current
   product. A line missing from those lists is treated as discontinued and
   named in the brand's `lineup_note` instead of being added.

## Which manufacturers, and why

The major US residential asphalt shingle makers in 2026 are GAF, Owens Corning,
CertainTeed, IKO, Atlas, TAMKO and Malarkey, plus PABCO in the West. The
evidence is ARMA's residential brand list and its 2026 board. RoofVista's
unverified estimate puts GAF, Owens Corning, CertainTeed, IKO and Atlas at
about 90% of the market combined. `manufacturers_considered[]` records the
brands left out:

- **Building Products of Canada (BP)** is on ARMA's list but sells through
  Canadian distribution; no US distribution or share was found.
- **Elk** has been part of GAF since 2007.
- **Westlake Royal (former Boral), Decra, DaVinci, Brava** make tile, metal or
  composite, not asphalt shingles.
- **Polyglass, Tarco, GCP, Siplast, Johns Manville** make underlayments,
  membranes or commercial roofing, not residential shingles.
- **Private labels** such as TRI-BUILT are made by the major manufacturers.

**PABCO is regional.** It has one plant in Tacoma, WA and sells in the Western
US. Show it first to organizations in the Pacific and Mountain regions, and
behind "More manufacturers" elsewhere. PABCO makes no underlayment, ice &
water or ridge vent (`underlayment_note`, `ice_water_note`,
`ridge_vent_note`), so a PABCO roof takes those from another brand. IKO makes
no ridge vent either (`ridge_vent_note`).

**Bundle sizes differ.** These lines are not 3-bundle squares:

- PABCO: 4 or 5 bundles per square.
- GAF Camelot II, Woodland and Grand Sequoia: 4.
- GAF Grand Canyon and Owens Corning Woodcrest and Woodmoor: 6.

TAMKO, Atlas and Owens Corning laminates cover 32.8 sq ft a bundle. Compute
bundles from `coverage_sq_ft_per_bundle` (or `bundles_per_square`), and
compare prices per square, not per bundle.

**Class 3 lines.** IKO Dynasty, Royal Estate and Armourshake, and Atlas
Pinnacle Pristine, Pinnacle Sun and ProLam, are UL 2218 Class 3. They have
`impact_rating: "none"` and say Class 3 in `impact_note`.

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

- **The four added brands' prices.** All IKO, TAMKO and PABCO accessory prices
  but one (TAMKO CoolRidge) are estimates, and so are many of their line
  prices: IKO 5 of 7, TAMKO 2 of 5 (2 more from ranges), PABCO 3 of 6.
  Distributors hide prices and Home Depot blocks fetching. Atlas is best
  covered, with 5 of 7 lines observed at The Roofing Brief, Menards and
  McCoy's. PABCO's two "observed" prices and many of the added GAF, Owens
  Corning and CertainTeed designer prices come from superarbor.io, a reseller
  that charges well above contractor cost. Their defaults are set below
  those listings.
- **Added CertainTeed designer lines.** Bundles per square for Landmark
  Premium, Highland Slate, Grand Manor and Carriage House are estimates. Their
  prices are 2024 cost-guide figures plus about 15%.
- **Coverage conflicts.** IKO Hip & Ridge 12 is 29.5 lf on IKO's page but
  36.5 lf in retailer titles. Leading Edge Plus is 109 lf now and 123 lf in an
  older brochure. PABCO's Premier and Prestige data sheets date from 2020.

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
  `gaf`, `owens_corning`, `malarkey`, `certainteed`, `atlas`, `iko`. `tamko`
  and `pabco` are not in `pricebook/constants.ts` yet. Add them there before
  price book items use them as a manufacturer filter value.
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
2. **Manufacturers.** Show the `manufacturers[]` with their `logo`, plus
   "Use all". The `logo_hint` wordmark is the fallback. Show PABCO first only
   in the West. Show the `availability_note` for Malarkey, PABCO and any brand
   outside its strong regions. See [Logos](#logos) for how to show logos.
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

## Logos

Each manufacturer's `logo` is a site path under
[`public/images/brands/roofing/`](../../../images/brands/roofing/). Its
`logo_source` gives the source URL, access date, size, what was done to the
file and the usage guidance found. Every file came from the brand's own website
or brand material on 2026-10-24, none from a logo aggregator or Wikimedia. The
older `public/images/brand-logos/` files used by the proposal builder came from
Wikimedia and worldvectorlogo and are not used here.

| Brand | File | Format and size | Source |
|---|---|---|---|
| GAF | `gaf.svg` | SVG, 100 x 100, 0.7 KB | Inline SVG in the gaf.com header (square mark, without the slogan) |
| Owens Corning | `owens_corning.svg` | SVG, 8.5 KB | `imagecdn.owenscorning.com/.../meganav/oc-logo.svg` (site navigation) |
| Malarkey | `malarkey.svg` | SVG, 209 x 44, 13.9 KB | `malarkeyroofing.com/.../logo-horizontal-full-color.svg` (site header) |
| CertainTeed | `certainteed.svg` | SVG, 286 x 66, 14.5 KB | `certainteed.com/themes/custom/certainteed/images/logo.svg` (with "Saint-Gobain") |
| IKO | `iko.svg` | SVG, 153 x 57, 3.9 KB | `iko.com/na/wp-content/uploads/2026/02/IKO-Logo.svg` (current identity) |
| Atlas | `atlas.png` | PNG, 393 x 262, transparent, 15.1 KB | `atlasroofing.com/img/atlas-logo.png` (site header) |
| TAMKO | `tamko.png` | PNG, 1277 x 512, transparent, 20.9 KB | `tamko.com/images/default-source/2025design/tamko-logo-black.png` (site header) |
| PABCO | `pabco.png` | PNG, 1200 x 207, transparent, 32.8 KB | Rendered from `pabcoroofing.com/wp-content/uploads/2022/12/Pabco-logo.svg` (84 KB) |

**Processing.** From the SVGs, only comments, editor metadata and whitespace
were removed; each still renders pixel-identical to the download. The Atlas PNG
was recompressed losslessly. The TAMKO PNG is unchanged. PABCO's SVG was
rendered at 1200 px wide to keep it under 50 KB. No colours or shapes were
changed. Atlas also offers EPS and a 3190 px JPG on its marketing resources
page, if a larger file is needed.

**How to show them.** Use a logo only to say whose product a line is, next to
that brand's products (nominative use). Show every logo at the same height,
never larger than the organization's own name, with clear space around it, on
a light background. Never combine a logo with other marks, and never suggest
the manufacturer endorses FirstMate or the roofer.

**Usage guidance found:**

- **GAF** (Trademark Use and Brand Guidelines for Contractors, 12/24): the GAF
  Logo may be used where you identify the brands you install. It must be no
  more than half the size of your own name, equally prominent with other
  brands, with clear space as wide as the "F", in GAF Red, never altered and
  never suggesting endorsement. The guide is written for GAF-certified
  contractors and tells them to use logos from the GAF Partner Portal or Brand
  Team rather than copying from gaf.com. **Before this ships, ask GAF's brand
  team (brand portal at gaf.bynder.com) to confirm or supply the file.**
- **Atlas** (Partner Brand Style Guide 2025): the globe and ATLAS are always
  used together, in full colour, black or reverse white. Clear space equals
  the "A" on the left, top and right, and half that below.
- **TAMKO** (logo download site terms): exact, unaltered copies only, though
  resizing is allowed. No implied endorsement, no use on products or packaging
  without a licence, and stop on request. The terms are written for
  contractors, dealers and distributors. This file comes from the public site
  header, not the download site, which needs registration and acceptance of
  its terms.
- **Malarkey** (marketing assets page and its terms): logos are Malarkey
  trademarks, and reproduction or modification needs prior written consent.
  **Ask Malarkey before showing it to customers.**
- **Owens Corning, CertainTeed, IKO, PABCO:** no public logo guidelines were
  found. Owens Corning's logo is the red square. The Pink Panther and PINK are
  separate licensed marks and must not be used.

**Colours.** `logo_hint.primary_color` now comes from each logo file. Owens
Corning changed from pink (#E4007C) to the logo's red (#DE222C), CertainTeed
from #004B87 to #005EB8, and Malarkey from #009A44 to #009845. The old value is
kept in `primary_color_before`.

## Keeping it current

Update prices by adding newer observations and changing `researched_on`. Do
not silently overwrite a sourced figure. If a manufacturer changes a bundle or
roll size, add a new product entry rather than changing the old one, because
existing price book items may carry the old packaging.
