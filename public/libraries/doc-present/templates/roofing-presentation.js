/**
 * Sample prices for the roofing sales presentation, in the editor and the dev player.
 *
 * The decks themselves are config library entries (presentation_deck roofing_itemized, roofing_options,
 * roofing_gutters; docs/architecture/config-library.md): ordinary paged DocModels edited on dev and copied to each
 * organization as a presentation module. Pages read them from /v1/config-library/read/presentation_deck. What is
 * left here is the stand-in live state a deck is shown with before an estimate has real prices, and how that sample
 * is re-priced when a choice changes (the server prices real estimates).
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FMRoofingPresentation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** A stand-in live state, for previews and the editor before real prices exist. */
  function sampleState(deck) {
    const option = (id, title, description, color, price_cents, selected) => ({ id, title, description, color: /^#/.test(color) ? color : '', swatch: /^#/.test(color) ? '' : color, details: description + ' Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.', price_cents, selected: !!selected });
    if (deck === 'gutters') return {
      groups: [],
      addons: [option('gutter_guard', 'Gutter guards', 'Micro-mesh guards that keep leaves and roof grit out.', 'linear-gradient(135deg,#d7dde5,#9aa7b5)', 171000)],
      base_cents: 366000,
      totals: {}
    };
    const roof = (id, title, description, price_cents, highlights, selected) => Object.assign(option(id, title, description, '', price_cents, selected), { highlights });
    if (deck === 'options') return {
      groups: [{ id: 'roof_package', title: 'Your roof', options: [
        roof('good', 'Good', 'A dependable architectural roof at the lowest price.', 2030500, ['GAF Timberline NS', 'Synthetic underlayment', 'Ice & water shield']),
        roof('better', 'Better', 'Our most chosen roof: high-definition shingles and a 50-year system warranty.', 2270600, ['GAF Timberline HDZ', 'GAF FeltBuster', 'GAF WeatherWatch', 'GAF System Plus warranty'], true),
        roof('best', 'Best', 'The thickest shingle, premium underlayment and manufacturer-backed workmanship coverage.', 2656300, ['GAF Timberline UHDZ', 'GAF Tiger Paw', 'GAF WeatherWatch', 'Lifetime pipe boots', 'GAF Silver Pledge warranty'])
      ] }],
      addons: [option('gutters', 'Seamless gutters', 'New 5-inch aluminum gutters along the eaves.', 'linear-gradient(135deg,#e6e9ee,#b4bcc8)', 282200)],
      base_cents: 0,
      totals: {}
    };
    return {
      groups: [
        { id: 'shingle_profile', title: 'Shingles', options: [
          option('gaf_ns', 'GAF Timberline NS', 'Natural Shadow. Clean, classic architectural look.', '#4a4d52', 974400),
          option('gaf_hd', 'GAF Timberline HDZ', 'High definition, with the widest nailing zone.', '#6f6354', 1089200, true),
          option('gaf_uhdz', 'GAF Timberline UHDZ', 'Ultra-thick, with a bolder shadow line.', '#55606a', 1302000)
        ] },
        { id: 'underlayment_profile', title: 'Underlayment', options: [
          option('underlayment', 'Synthetic underlayment', 'Light, strong and tear resistant.', '#c9d1da', 142800, true),
          option('gaf_feltbuster', 'GAF FeltBuster', 'High-traction synthetic felt.', '#aebbc9', 168000),
          option('gaf_tiger_paw', 'GAF Tiger Paw', 'Premium, with moisture control.', '#93a4b6', 226800)
        ] },
        { id: 'leak_barrier_profile', title: 'Ice & water barrier', options: [
          option('ice_water', 'Ice & water shield', 'Self-sealing membrane at eaves and valleys.', '#3a4a60', 86400, true),
          option('gaf_weatherwatch', 'GAF WeatherWatch', 'Mineral-surfaced leak barrier.', '#2f3d52', 104400),
          option('owens_weatherlock', 'Owens Corning WeatherLock', 'Flexible, for complex roof lines.', '#44405c', 118800)
        ] }
      ],
      addons: [
        option('gutters', 'Seamless gutters', 'New 6-inch aluminum gutters and downspouts.', 'linear-gradient(135deg,#e6e9ee,#b4bcc8)', 248000),
        option('ridge_vent', 'Ridge ventilation', 'Continuous ridge vent to keep the attic cool and dry.', 'linear-gradient(135deg,#d9c9a8,#a68f63)', 96000),
        option('skylight', 'Skylight re-flash', 'New flashing kits around both skylights.', 'linear-gradient(135deg,#bfe0f2,#6fa8cc)', 72000)
      ],
      base_cents: 412030,
      totals: {}
    };
  }
  /** Recompute a sample state's totals from its choices (the server does this for real estimates). */
  function priceSample(state) {
    const picked = (state.groups || []).reduce((sum, group) => sum + (Number(((group.options || []).find((entry) => entry.selected) || {}).price_cents) || 0), 0);
    const extras = (state.addons || []).filter((entry) => entry.selected).reduce((sum, entry) => sum + (Number(entry.price_cents) || 0), 0);
    const total = (Number(state.base_cents) || 0) + picked + extras;
    const deposit = Math.round(total * 0.3 / 100) * 100;
    state.totals = { subtotal_cents: total, tax_cents: 0, total_cents: total, deposit_cents: deposit, balance_cents: total - deposit };
    return state;
  }

  return { sampleState, priceSample };
});
