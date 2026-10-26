// Address match: whether Google's answer for a typed address is the address
// the person typed, only completed.
//
// Google may add a city, state, ZIP or country. It must not change the street
// line the person typed: house number, street name, street type or direction.
// Rules (both sides are normalised the same way):
// - Case, punctuation and extra spaces do not count.
// - A street type, direction, state or country written short or in full is the
//   same word ("St" = "Street", "N" = "North", "CO" = "Colorado"); a different
//   word is not ("Ave" is not "St").
// - Unit and suite formatting is tolerated ("Apt 4", "Unit 4", "#4", "Ste 4"),
//   and Google leaving the unit off is tolerated; a different unit number is not.
// - Google's street line (the formatted address up to its first comma) must be
//   exactly the start of what was typed: nothing added to it, nothing changed.
// - Whatever was typed after the street line (city, state, ZIP) must appear in
//   Google's answer, in order; Google may add words around it.
(function(root){
  const STREET_TYPES = {
    alley:'aly', allee:'aly', aly:'aly', avenue:'ave', av:'ave', ave:'ave', aven:'ave', avenu:'ave', avn:'ave', avnue:'ave',
    boulevard:'blvd', blvd:'blvd', boul:'blvd', boulv:'blvd', bypass:'byp', byp:'byp', causeway:'cswy', cswy:'cswy',
    circle:'cir', cir:'cir', circ:'cir', circl:'cir', crcl:'cir', court:'ct', ct:'ct', cove:'cv', cv:'cv',
    crossing:'xing', xing:'xing', drive:'dr', dr:'dr', drv:'dr', expressway:'expy', expy:'expy', freeway:'fwy', fwy:'fwy',
    highway:'hwy', hwy:'hwy', hiway:'hwy', lane:'ln', ln:'ln', loop:'loop', parkway:'pkwy', pkwy:'pkwy', pky:'pkwy',
    place:'pl', pl:'pl', plaza:'plz', plz:'plz', point:'pt', pt:'pt', road:'rd', rd:'rd', route:'rte', rte:'rte',
    square:'sq', sq:'sq', street:'st', st:'st', str:'st', strt:'st', terrace:'ter', ter:'ter', terr:'ter',
    trail:'trl', trl:'trl', turnpike:'tpke', tpke:'tpke', way:'way', wy:'way', run:'run', path:'path', pike:'pike',
    row:'row', walk:'walk', heights:'hts', hts:'hts', ridge:'rdg', rdg:'rdg', crescent:'cres', cres:'cres',
    landing:'lndg', lndg:'lndg', meadows:'mdws', mdws:'mdws', grove:'grv', grv:'grv', hollow:'holw', holw:'holw',
    saint:'st'
  };
  const DIRECTIONS = {
    n:'n', north:'n', s:'s', south:'s', e:'e', east:'e', w:'w', west:'w',
    ne:'ne', northeast:'ne', nw:'nw', northwest:'nw', se:'se', southeast:'se', sw:'sw', southwest:'sw'
  };
  // Not "fl" or "no": Florida and the word No are more common in an address than a floor or a number sign.
  const UNIT_WORDS = new Set(['#', 'apt', 'apartment', 'unit', 'ste', 'suite', 'rm', 'room', 'bldg', 'building', 'floor', 'lot', 'spc', 'space', 'trlr', 'trailer']);
  const STATES = {
    alabama:'al', alaska:'ak', arizona:'az', arkansas:'ar', california:'ca', colorado:'co', connecticut:'ct', delaware:'de',
    florida:'fl', georgia:'ga', hawaii:'hi', idaho:'id', illinois:'il', indiana:'in', iowa:'ia', kansas:'ks', kentucky:'ky',
    louisiana:'la', maine:'me', maryland:'md', massachusetts:'ma', michigan:'mi', minnesota:'mn', mississippi:'ms',
    missouri:'mo', montana:'mt', nebraska:'ne', nevada:'nv', 'new hampshire':'nh', 'new jersey':'nj', 'new mexico':'nm',
    'new york':'ny', 'north carolina':'nc', 'north dakota':'nd', ohio:'oh', oklahoma:'ok', oregon:'or', pennsylvania:'pa',
    'rhode island':'ri', 'south carolina':'sc', 'south dakota':'sd', tennessee:'tn', texas:'tx', utah:'ut', vermont:'vt',
    virginia:'va', washington:'wa', 'west virginia':'wv', wisconsin:'wi', wyoming:'wy', 'district of columbia':'dc'
  };
  const COUNTRIES = { 'united states of america':'us', 'united states':'us', usa:'us', 'u s a':'us', 'u s':'us', us:'us' };
  // Multi-word names first so "north carolina" is one word before "north" is read as a direction.
  const PHRASES = [...Object.entries(STATES), ...Object.entries(COUNTRIES)]
    .filter(([name]) => name.includes(' '))
    .sort((a, b) => b[0].length - a[0].length);
  const SINGLE_STATES = Object.fromEntries(Object.entries(STATES).filter(([name]) => !name.includes(' ')));

  function cleanText(value){ return String(value ?? '').replace(/\s+/g, ' ').trim(); }

  // Lower case, punctuation gone, "#" kept as its own word, multi-word state and country names joined.
  function baseText(value){
    let text = String(value ?? '').toLowerCase()
      .replace(/[.'’`]/g, '')
      .replace(/#/g, ' # ')
      .replace(/[^a-z0-9#]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    for (const [name, short] of PHRASES) text = ` ${text} `.replace(new RegExp(` ${name} `, 'g'), ` ${short} `).trim();
    return text;
  }

  function canonicalWord(word){
    return STREET_TYPES[word] || DIRECTIONS[word] || SINGLE_STATES[word] || COUNTRIES[word] || word;
  }

  // Words of one part of an address, with the unit taken out ("apt 4", "#4", "suite 4b" -> unit "4").
  function parsePart(value){
    const words = baseText(value).split(' ').filter(Boolean);
    const out = [];
    let unit = '';
    for (let i = 0; i < words.length; i += 1) {
      const word = words[i];
      if (UNIT_WORDS.has(word) && i > 0 && words[i + 1] && /\d/.test(words[i + 1] + (word === '#' ? '0' : ''))) {
        // A unit word means a unit only when a number follows; "#" always does.
        let next = words[i + 1];
        if (next === '#' && words[i + 2]) { i += 1; next = words[i + 1]; }
        unit = next;
        i += 1;
        continue;
      }
      out.push(canonicalWord(word));
    }
    return { words: out, unit };
  }

  function isSubsequence(needle, haystack){
    let at = 0;
    for (const word of haystack) if (at < needle.length && word === needle[at]) at += 1;
    return at === needle.length;
  }

  function resolvedText(resolved){
    if (!resolved) return '';
    if (typeof resolved === 'string') return resolved;
    return cleanText(resolved.formatted_address || resolved.formattedAddress || resolved.address || '');
  }

  function splitStreet(text){
    const value = cleanText(text);
    const comma = value.indexOf(',');
    return comma < 0 ? [value, ''] : [value.slice(0, comma), value.slice(comma + 1)];
  }

  // Google's address components by type ({ long_name, short_name, types }).
  function component(parts, type, which = 'long_name'){
    const part = parts.find((item) => Array.isArray(item?.types) && item.types.includes(type));
    return cleanText(part?.[which]);
  }

  // The street line and the rest of an address. A string's street line runs
  // to its first comma. A Google answer with address components is read from
  // them, because its formatted address can start with a place name
  // ("Google Building 40, 1600 Amphitheatre Pkwy, ...").
  function describe(address){
    const parts = address && typeof address === 'object' && Array.isArray(address.address_components) ? address.address_components : [];
    const number = component(parts, 'street_number');
    const route = component(parts, 'route');
    if (number && route) {
      const unit = component(parts, 'subpremise');
      const streetText = `${number} ${route}${unit ? ` # ${unit}` : ''}`;
      const restText = [
        component(parts, 'neighborhood'), component(parts, 'sublocality'), component(parts, 'locality'), component(parts, 'postal_town'),
        component(parts, 'administrative_area_level_2'),
        component(parts, 'administrative_area_level_1'), component(parts, 'administrative_area_level_1', 'short_name'),
        component(parts, 'postal_code'),
        component(parts, 'country'), component(parts, 'country', 'short_name')
      ].filter(Boolean).join(' ');
      return { streetText, street: parsePart(streetText), rest: parsePart(restText) };
    }
    const [streetText, restText] = splitStreet(resolvedText(address));
    return { streetText, street: parsePart(streetText), rest: parsePart(restText) };
  }

  // Why a typed address and Google's answer are not the same address, or '' when they are.
  function typedMismatch(typed, resolved){
    if (!cleanText(typed)) return 'nothing_typed';
    if (!resolvedText(resolved) && !(resolved && typeof resolved === 'object' && Array.isArray(resolved.address_components))) return 'no_answer';
    if (resolved && typeof resolved === 'object' && resolved.partial_match === true) return 'partial_match';
    const { street, rest } = describe(resolved);
    const mine = parsePart(typed);
    if (!street.words.length) return 'no_street';
    for (let i = 0; i < street.words.length; i += 1) {
      if (mine.words[i] === undefined) return 'street_added';
      if (mine.words[i] !== street.words[i]) return 'street_changed';
    }
    const answerUnit = street.unit || rest.unit;
    if (mine.unit && answerUnit && mine.unit !== answerUnit) return 'unit_changed';
    if (!mine.unit && answerUnit) return 'unit_added';
    if (!isSubsequence(mine.words.slice(street.words.length), rest.words)) return 'locality_changed';
    return '';
  }

  function matchesTyped(typed, resolved){ return typedMismatch(typed, resolved) === ''; }

  // Two addresses (strings or Google answers) name the same place: the same
  // street line (a unit on one side only is tolerated) and the shorter rest
  // found in the longer one.
  function sameAddress(a, b){
    const da = describe(a), db = describe(b);
    const sa = da.street, sb = db.street;
    if (!sa.words.length || sa.words.join(' ') !== sb.words.join(' ')) return false;
    if (sa.unit && sb.unit && sa.unit !== sb.unit) return false;
    const ra = da.rest.words, rb = db.rest.words;
    return ra.length <= rb.length ? isSubsequence(ra, rb) : isSubsequence(rb, ra);
  }

  // The street line, as a search would find it: a Google answer's street in
  // Google's short form ("1600 Amphitheatre Pkwy"), a string's up to its first comma.
  function streetLine(address){
    const parts = address && typeof address === 'object' && Array.isArray(address.address_components) ? address.address_components : [];
    const number = component(parts, 'street_number');
    const route = component(parts, 'route', 'short_name') || component(parts, 'route');
    if (number && route) return `${number} ${route}`;
    return splitStreet(resolvedText(address))[0];
  }

  const api = { normalize:(value) => parsePart(value).words.join(' '), parsePart, typedMismatch, matchesTyped, sameAddress, streetLine };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FirstMateAddressMatch = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
