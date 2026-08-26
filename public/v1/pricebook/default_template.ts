import {
  DEFAULT_TEMPLATE_KEY,
  MEASUREMENT_FIELDS,
  PRICEBOOK_CATEGORIES,
  PRICEBOOK_MANUFACTURERS,
  PRICEBOOK_SEGMENTS,
  PRICEBOOK_UNITS
} from "./constants.js";

export const DEFAULT_PRICEBOOK_TEMPLATE = {
  key: DEFAULT_TEMPLATE_KEY,
  version: 1,
  name: "Default Price Book",
  description: "Bundled price book template derived from the current portal default catalog.",
  catalog: {
    taxonomy: {
      categories: [
        { value: PRICEBOOK_CATEGORIES[0], label: "Miscellaneous" },
        { value: PRICEBOOK_CATEGORIES[1], label: "Disposal" },
        { value: PRICEBOOK_CATEGORIES[2], label: "Shingle Roofs" },
        { value: PRICEBOOK_CATEGORIES[3], label: "Leak Barriers" },
        { value: PRICEBOOK_CATEGORIES[4], label: "Flashing" },
        { value: PRICEBOOK_CATEGORIES[5], label: "Accessories" },
        { value: PRICEBOOK_CATEGORIES[6], label: "Gutters" },
        { value: PRICEBOOK_CATEGORIES[7], label: "Flat Roofs" },
        { value: PRICEBOOK_CATEGORIES[8], label: "Flat Roof Accessories" }
      ],
      units: [
        { value: PRICEBOOK_UNITS[0], label: "Per Square" },
        { value: PRICEBOOK_UNITS[1], label: "Per Linear Foot" },
        { value: PRICEBOOK_UNITS[2], label: "Each" },
        { value: PRICEBOOK_UNITS[3], label: "Bundle" },
        { value: PRICEBOOK_UNITS[4], label: "Hour" }
      ],
      measurement_fields: MEASUREMENT_FIELDS.map((field) => ({ ...field })),
      manufacturers: [
        { value: PRICEBOOK_MANUFACTURERS[0], label: "All" },
        { value: PRICEBOOK_MANUFACTURERS[1], label: "Generic" },
        { value: PRICEBOOK_MANUFACTURERS[2], label: "GAF" },
        { value: PRICEBOOK_MANUFACTURERS[3], label: "Owens Corning" },
        { value: PRICEBOOK_MANUFACTURERS[4], label: "Malarkey" },
        { value: PRICEBOOK_MANUFACTURERS[5], label: "CertainTeed" },
        { value: PRICEBOOK_MANUFACTURERS[6], label: "Atlas" },
        { value: PRICEBOOK_MANUFACTURERS[7], label: "IKO" }
      ],
      segments: [
        { value: PRICEBOOK_SEGMENTS[0], label: "All" },
        { value: PRICEBOOK_SEGMENTS[1], label: "Sloped" },
        { value: PRICEBOOK_SEGMENTS[2], label: "Flat" },
        { value: PRICEBOOK_SEGMENTS[3], label: "Other" }
      ]
    },
    items: [
      { id: "matlab_misc", name: "MatLab", category: "misc", unit: "ea", unitPrice: 0, formulaConfig: { tokens: [{ type: "number", value: "1" }], includeWaste: false }, autoAdd: false, description: "Placeholder miscellaneous item", options: [], images: [], metadata: {} },
      { id: "sealant_misc", name: "Sealant / Miscellaneous", category: "misc", unit: "ea", unitPrice: 65, formulaConfig: { tokens: [{ type: "number", value: "1" }], includeWaste: false }, autoAdd: false, description: "Miscellaneous sealant and small accessories", options: [], images: [], metadata: {} },
      { id: "tearoff", name: "Remove Existing Roofing", category: "disposal", manufacturer: "generic", unit: "sq", unitPrice: 85, formulaConfig: { tokens: [{ type: "measurement", value: "roofSquares" }], includeWaste: false }, autoAdd: true, description: "Tear-off and disposal of existing roofing", options: [], images: [], metadata: {} },
      { id: "laminated_shingles", name: "Architectural Shingles", category: "shingle_roofs", manufacturer: "generic", unit: "sq", unitPrice: 365, formulaConfig: { tokens: [{ type: "measurement", value: "shingleSquares" }], includeWaste: true }, autoAdd: true, description: "Field shingles with waste applied automatically", options: [{ id: "color", label: "Color", input_type: "single_select", required: false, values: [{ id: "charcoal", label: "Charcoal" }, { id: "weathered_wood", label: "Weathered Wood" }, { id: "shakewood", label: "Shakewood" }] }], images: [], metadata: {} },
      { id: "gaf_hd", name: "GAF Timberline HDZ", category: "shingle_roofs", manufacturer: "gaf", unit: "sq", unitPrice: 398, formulaConfig: { tokens: [{ type: "measurement", value: "shingleSquares" }], includeWaste: true }, autoAdd: false, description: "Architectural laminate shingle", options: [{ id: "color", label: "Color", input_type: "single_select", required: false, values: [{ id: "charcoal", label: "Charcoal" }, { id: "barkwood", label: "Barkwood" }, { id: "fox_hollow_gray", label: "Fox Hollow Gray" }] }], images: [], metadata: {} },
      { id: "owens_duration", name: "Owens Corning Duration", category: "shingle_roofs", manufacturer: "owens_corning", unit: "sq", unitPrice: 405, formulaConfig: { tokens: [{ type: "measurement", value: "shingleSquares" }], includeWaste: true }, autoAdd: false, description: "High-definition laminate shingle", options: [], images: [], metadata: {} },
      { id: "malarkey_vista", name: "Malarkey Vista", category: "shingle_roofs", manufacturer: "malarkey", unit: "sq", unitPrice: 418, formulaConfig: { tokens: [{ type: "measurement", value: "shingleSquares" }], includeWaste: true }, autoAdd: false, description: "Impact-resistant laminate shingle", options: [], images: [], metadata: {} },
      { id: "starter", name: "Starter Strip", category: "shingle_roofs", manufacturer: "generic", unit: "lf", unitPrice: 2.45, formulaConfig: { tokens: [{ type: "measurement", value: "eavesLf" }, { type: "operator", value: "+" }, { type: "measurement", value: "rakesLf" }], includeWaste: false }, autoAdd: true, description: "Starter along eaves and rakes", options: [], images: [], metadata: {} },
      { id: "ridge_cap", name: "Ridge Cap", category: "shingle_roofs", manufacturer: "generic", unit: "lf", unitPrice: 4.25, formulaConfig: { tokens: [{ type: "measurement", value: "hipsLf" }, { type: "operator", value: "+" }, { type: "measurement", value: "ridgesLf" }], includeWaste: false }, autoAdd: true, description: "Hip and ridge cap shingles", options: [], images: [], metadata: {} },
      { id: "underlayment", name: "Synthetic Underlayment", category: "shingle_roofs", manufacturer: "generic", unit: "sq", unitPrice: 42, formulaConfig: { tokens: [{ type: "measurement", value: "shingleSquares" }], includeWaste: true }, autoAdd: true, description: "Synthetic felt underlayment", options: [], images: [], metadata: {} },
      { id: "steep_slope", name: "Steep Slope Charge", category: "shingle_roofs", manufacturer: "generic", unit: "sq", unitPrice: 35, formulaConfig: { tokens: [{ type: "paren", value: "(" }, { type: "measurement", value: "pitch9to12Squares" }, { type: "operator", value: "+" }, { type: "measurement", value: "pitch13PlusSquares" }, { type: "paren", value: ")" }], includeWaste: false }, autoAdd: true, description: "Additional labor for steep slope roof sections", options: [], images: [], metadata: {} },
      { id: "ice_water", name: "Ice & Water Shield", category: "leak_barriers", manufacturer: "generic", unit: "sq", unitPrice: 78, formulaConfig: { tokens: [{ type: "paren", value: "(" }, { type: "measurement", value: "valleyLf" }, { type: "operator", value: "+" }, { type: "measurement", value: "eavesLf" }, { type: "operator", value: "+" }, { type: "measurement", value: "rakesLf" }, { type: "paren", value: ")" }, { type: "operator", value: "/" }, { type: "number", value: "100" }, { type: "operator", value: "+" }, { type: "measurement", value: "pitch2to4Squares" }], includeWaste: false }, autoAdd: false, description: "Eaves and valleys ice barrier", options: [], images: [], metadata: {} },
      { id: "gaf_weatherwatch", name: "GAF WeatherWatch", category: "leak_barriers", manufacturer: "gaf", unit: "sq", unitPrice: 92, formulaConfig: { tokens: [{ type: "measurement", value: "shingleSquares" }], includeWaste: true }, autoAdd: false, description: "Premium leak barrier membrane", options: [], images: [], metadata: {} },
      { id: "owens_weatherlock", name: "Owens Corning WeatherLock", category: "leak_barriers", manufacturer: "owens_corning", unit: "sq", unitPrice: 95, formulaConfig: { tokens: [{ type: "measurement", value: "shingleSquares" }], includeWaste: true }, autoAdd: false, description: "Self-adhered ice and water shield", options: [], images: [], metadata: {} },
      { id: "drip_edge", name: "Drip Edge", category: "flashing", segment: "sloped", unit: "lf", unitPrice: 3.25, formulaConfig: { tokens: [{ type: "measurement", value: "eavesLf" }, { type: "operator", value: "+" }, { type: "measurement", value: "rakesLf" }], includeWaste: false }, autoAdd: true, description: "Metal drip edge at perimeter", options: [], images: [], metadata: {} },
      { id: "valley_metal", name: "Valley Metal", category: "flashing", segment: "sloped", unit: "lf", unitPrice: 8.75, formulaConfig: { tokens: [{ type: "measurement", value: "valleyLf" }], includeWaste: false }, autoAdd: true, description: "Open valley metal in roof valleys", options: [], images: [], metadata: {} },
      { id: "pipe_boot", name: "Skylight Flashing", category: "flashing", segment: "sloped", unit: "ea", unitPrice: 95, formulaConfig: { tokens: [{ type: "measurement", value: "skylightsEa" }], includeWaste: false }, autoAdd: false, description: "Replace skylight flashing kits", options: [], images: [], metadata: {} },
      { id: "step_flashing", name: "Step Flashing", category: "flashing", segment: "sloped", unit: "lf", unitPrice: 9.5, formulaConfig: { tokens: [{ type: "measurement", value: "sideWallLf" }], includeWaste: false }, autoAdd: false, description: "Wall flashing for sloped transitions", options: [], images: [], metadata: {} },
      { id: "headwall_flashing", name: "Head Wall Flashing", category: "flashing", segment: "sloped", unit: "lf", unitPrice: 11.25, formulaConfig: { tokens: [{ type: "measurement", value: "headWallLf" }], includeWaste: false }, autoAdd: false, description: "Head wall / apron flashing", options: [], images: [], metadata: {} },
      { id: "sidewall_flashing", name: "Side Wall Flashing", category: "flashing", segment: "sloped", unit: "lf", unitPrice: 10.5, formulaConfig: { tokens: [{ type: "measurement", value: "sideWallLf" }], includeWaste: false }, autoAdd: false, description: "Continuous side wall flashing", options: [], images: [], metadata: {} },
      { id: "tpo_drain", name: "TPO Drain Detail", category: "flashing", segment: "flat", unit: "ea", unitPrice: 145, formulaConfig: { tokens: [{ type: "measurement", value: "structures" }], includeWaste: false }, autoAdd: false, description: "Flat roof drain flashing detail", options: [], images: [], metadata: {} },
      { id: "pipe_jack_paint", name: "Skylight Trim Kit", category: "accessories", unit: "ea", unitPrice: 28, formulaConfig: { tokens: [{ type: "measurement", value: "skylightsEa" }], includeWaste: false }, autoAdd: false, description: "Accessory skylight trim and finish pieces", options: [], images: [], metadata: {} },
      { id: "ridge_vent", name: "Ridge Vent", category: "accessories", unit: "lf", unitPrice: 7.5, formulaConfig: { tokens: [{ type: "measurement", value: "ridgesLf" }], includeWaste: false }, autoAdd: true, description: "Continuous ridge ventilation", options: [], images: [], metadata: {} },
      { id: "chimney_flashing", name: "Chimney Flashing", category: "accessories", unit: "ea", unitPrice: 225, formulaConfig: { tokens: [{ type: "measurement", value: "chimneysEa" }], includeWaste: false }, autoAdd: false, description: "Counter flashing and base flashing at chimneys", options: [], images: [], metadata: {} },
      { id: "gutter_replace", name: "K-Style Gutter", category: "gutters", unit: "lf", unitPrice: 14.25, formulaConfig: { tokens: [{ type: "measurement", value: "gutterLf" }], includeWaste: false }, autoAdd: false, description: "5-inch seamless gutter replacement", options: [{ id: "color", label: "Color", input_type: "single_select", required: false, values: [{ id: "white", label: "White" }, { id: "brown", label: "Brown" }, { id: "black", label: "Black" }] }], images: [], metadata: {} },
      { id: "downspout", name: "Downspout", category: "gutters", unit: "lf", unitPrice: 11.5, formulaConfig: { tokens: [{ type: "measurement", value: "downspoutLf" }], includeWaste: false }, autoAdd: false, description: "Downspout replacement", options: [], images: [], metadata: {} },
      { id: "tpo_membrane", name: "TPO Membrane", category: "flat_roofs", unit: "sq", unitPrice: 465, formulaConfig: { tokens: [{ type: "measurement", value: "flatRoofSquares" }], includeWaste: true }, autoAdd: true, description: "Single-ply membrane roofing", options: [{ id: "color", label: "Membrane Color", input_type: "single_select", required: false, values: [{ id: "white", label: "White" }, { id: "gray", label: "Gray" }, { id: "tan", label: "Tan" }] }], images: [], metadata: {} },
      { id: "torch_down", name: "Torch Down Roofing", category: "flat_roofs", unit: "sq", unitPrice: 425, formulaConfig: { tokens: [{ type: "measurement", value: "flatRoofSquares" }], includeWaste: true }, autoAdd: false, description: "Modified bitumen torch down roofing", options: [], images: [], metadata: {} },
      { id: "transition_metal", name: "Transition Metal", category: "flat_roof_accessories", unit: "lf", unitPrice: 18.5, formulaConfig: { tokens: [{ type: "measurement", value: "transitionsLf" }], includeWaste: false }, autoAdd: false, description: "Transition metal for changing roof planes", options: [], images: [], metadata: {} },
      { id: "flat_roof_chimney", name: "Flat Roof Chimney Flashing", category: "flat_roof_accessories", unit: "ea", unitPrice: 185, formulaConfig: { tokens: [{ type: "measurement", value: "chimneysEa" }], includeWaste: false }, autoAdd: false, description: "Chimney curb and flashing package for flat roofs", options: [], images: [], metadata: {} },
      { id: "termination_bar", name: "Termination Bar", category: "flat_roof_accessories", unit: "lf", unitPrice: 6.75, formulaConfig: { tokens: [{ type: "measurement", value: "headWallLf" }, { type: "operator", value: "+" }, { type: "measurement", value: "sideWallLf" }], includeWaste: false }, autoAdd: false, description: "Termination bar at walls and parapets", options: [], images: [], metadata: {} }
    ],
    assets: [],
    settings: {
      suggestion_limit: 6,
      show_zero_quantity_auto_items: false
    },
    metadata: {}
  }
} as const;
