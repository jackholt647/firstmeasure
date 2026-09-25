/* Presentation boundary only. Stored roof takeoffs stay in feet/squares; geometry stays in metres. */
(function(root) {
  'use strict';
  const catalogs = {
    'en-US': {},
    'en-GB': { color:'colour', colors:'colours', colored:'coloured', center:'centre', centered:'centred',
      aluminum:'aluminium', gray:'grey', labor:'labour', vapor:'vapour', miter:'mitre', miters:'mitres', story:'storey', stories:'storeys', meters:'metres', meter:'metre',
      millimeters:'millimetres', millimeter:'millimetre', "square footage":'area' }
  };
  function create(preferences = {}) {
    const metric = preferences.measurement_system === 'metric';
    const requested = preferences.language_snapshot?.locale || preferences.report_language;
    let language = 'en-US';
    if (requested && (Object.hasOwn(catalogs, requested) || preferences.language_snapshot?.report_dictionary || root.PlatformLanguage?.supportedLocales?.includes(requested))) {
      try { language = Intl.getCanonicalLocales(requested)[0] || 'en-US'; } catch { /* Invalid legacy locale retains the original default. */ }
    }
    const dictionary = preferences.language_snapshot?.report_dictionary || catalogs[language] || {};
    const factors = { ft:.3048, sf:.09290304, sq:9.290304, inch:25.4, si:6.4516, gallon:3.785411784 };
    const units = { ft:'m', sf:'m²', sq:'m²', inch:'mm', si:'cm²', gallon:'L' };
    const imperial = { ft:'ft', sf:'sq ft', sq:'squares', inch:'in', si:'sq in', gallon:'gal' };
    const value = (n, kind) => Number(n) * (metric ? factors[kind] : 1);
    const number = (n, kind, digits = 2) => value(n, kind).toLocaleString(language, { maximumFractionDigits:digits });
    const unit = kind => (metric ? units : imperial)[kind];
    const quantity = (n, kind, digits = 2) => number(n, kind, digits) + ' ' + unit(kind);
    const text = input => {
      if (language === 'en-US' || typeof input !== 'string') return input;
      if (dictionary[input]) return dictionary[input];
      return input.replace(/\bsquare footage\b|\b(?:colors?|colored|centered|center|aluminum|gray|labor|vapor|miters?|stories|story|millimeters?|meters?)\b/gi, word => {
        const replacement = dictionary[word.toLowerCase()] || word;
        return word === word.toUpperCase() ? replacement.toUpperCase() : /^[A-Z]/.test(word) ? replacement[0].toUpperCase()+replacement.slice(1) : replacement;
      });
    };
    const label = input => {
      let result = text(input);
      if (metric && typeof result === 'string') result = result.replace(/(\d+(?:\.\d+)?)\s*(sq ft|sq in|ft|inches|inch|[″”"]|[′'])/g, (all,n,suffix) => {
        const kind = ({'sq ft':'sf','sq in':'si',ft:'ft',inches:'inch',inch:'inch','″':'inch','”':'inch','"':'inch',"'":'ft','′':'ft'})[suffix];
        return quantity(Number(n),kind);
      });
      return result;
    };
    return { metric, language, value, number, unit, quantity, text, label,
      length: (feet, legacy) => metric ? quantity(feet, 'ft') : legacy,
      area: (feet, legacy) => metric ? quantity(feet, 'sf') : legacy,
      squares: (squares, legacy) => metric ? quantity(squares, 'sq') : legacy,
      // Distances supplied by geometry tools are already metres.
      distance: (metres, legacy) => metric ? Number(metres).toFixed(2)+' m' : legacy,
      inputScale: owner => owner?.unit === 'degrees' ? (owner.unitsPerInput ?? 1) : metric ? (owner?.unit === 'inches' ? .001 : 1) : (owner?.unitsPerInput ?? .3048)
    };
  }
  let cachedKey, cachedUnits;
  const current = () => {
    const preferences = root.currentProjectManifest || {}, key = preferences.id + ":" + preferences.measurement_system + ":" + preferences.report_language + ":" + preferences.language_snapshot?.catalog_versions?.reports;
    if (key !== cachedKey) { cachedKey = key; cachedUnits = create(preferences); }
    return cachedUnits;
  };
  const api = { create, current, catalogs };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ReportUnits = api;
})(typeof window === 'undefined' ? globalThis : window);
