/* libraries/doc-language/firstmate-doc-language.js
 * FirstMate document language engine: spellcheck, light grammar, autocorrect.
 * Fully client-side. Spelling is Hunspell-format en_US (SCOWL) checked with a
 * vendored nspell bundle; dictionaries are lazy-loaded via fetch at init().
 * Grammar is a built-in deterministic rule engine (no ML, no network).
 *
 *   await FMDocLanguage.init({ baseUrl, customWords, onAddWord });
 *   FMDocLanguage.checkSpelling(text)  -> [{ word, start, end, suggestions }]
 *   FMDocLanguage.checkGrammar(text)   -> [{ start, end, message, replacements }]
 *   FMDocLanguage.autocorrect(word)    -> replacement string | null
 *   FMDocLanguage.addToDictionary(word)
 */
(function(){
  const root = window;
  if (root.FMDocLanguage?.__initialized) return;

  /* Resolve the directory this script was loaded from so vendored assets can
   * be fetched relative to it. Captured at parse time (currentScript is null
   * later), overridable via init({ baseUrl }). */
  const scriptBase = (() => {
    try {
      const src = document.currentScript?.src || '';
      if (src) return src.slice(0, src.lastIndexOf('/') + 1);
    } catch { /* ignore */ }
    return '/libraries/doc-language/';
  })();

  const state = {
    initPromise: null,
    spellReady: false,
    spell: null,
    baseUrl: scriptBase,
    customWords: new Set(),          // lowercase entries
    onAddWord: null,
    correctCache: new Map(),         // token -> boolean
    suggestCache: new Map(),         // lowercase token -> [suggestions]
  };
  const SUGGEST_CACHE_MAX = 2000;

  /* ------------------------------------------------------------------ */
  /* Curated common-typo map (classic autocorrect pairs, all lowercase). */
  /* Only unambiguous slips belong here — never real words.              */
  /* ------------------------------------------------------------------ */
  const COMMON_TYPOS = {
    teh: 'the', hte: 'the', tehy: 'they', thge: 'the',
    adn: 'and', nad: 'and', anbd: 'and',
    abotu: 'about', abbout: 'about', aobut: 'about',
    taht: 'that', thta: 'that', htat: 'that',
    thsi: 'this', tihs: 'this', hting: 'thing',
    jsut: 'just', juts: 'just',
    waht: 'what', wht: 'what', wich: 'which', whihc: 'which',
    wehn: 'when', hwen: 'when', wiht: 'with', witht: 'with', wtih: 'with',
    woudl: 'would', wouldnt: "wouldn't", coudl: 'could', shoudl: 'should',
    cna: 'can', cant: "can't", dont: "don't", doesnt: "doesn't",
    didnt: "didn't", isnt: "isn't", wasnt: "wasn't", wont: "won't",
    havent: "haven't", hasnt: "hasn't", couldnt: "couldn't",
    shouldnt: "shouldn't", arent: "aren't", werent: "weren't",
    im: "I'm", ive: "I've", ill: null, id: null, // ambiguous: never touch
    youre: "you're", theyre: "they're", thats: "that's", whats: "what's",
    heres: "here's", theres: "there's", lets: null, its: null, // ambiguous
    recieve: 'receive', recieved: 'received', reciept: 'receipt',
    beleive: 'believe', beleived: 'believed', belive: 'believe',
    seperate: 'separate', seperately: 'separately',
    definately: 'definitely', defiantly: null, // real word — leave alone
    occured: 'occurred', occurence: 'occurrence',
    untill: 'until', unitl: 'until', tommorow: 'tomorrow', tommorrow: 'tomorrow',
    accross: 'across', alot: 'a lot', allready: 'already',
    almsot: 'almost', alwasy: 'always', aroudn: 'around',
    becuase: 'because', becasue: 'because', beacuse: 'because',
    begining: 'beginning', buisness: 'business', bussiness: 'business',
    calender: 'calendar', catagory: 'category', cheif: 'chief',
    comming: 'coming', commitee: 'committee', completly: 'completely',
    concious: 'conscious',
    embarass: 'embarrass', enviroment: 'environment', excercise: 'exercise',
    familar: 'familiar', finaly: 'finally', foriegn: 'foreign',
    freind: 'friend', futher: 'further', goverment: 'government',
    gaurd: 'guard', happend: 'happened', immediatly: 'immediately',
    indispensible: 'indispensable', intrest: 'interest', knwo: 'know',
    liason: 'liaison', libary: 'library', lisence: 'license',
    maintenence: 'maintenance', managment: 'management', mispell: 'misspell',
    neccessary: 'necessary', necesary: 'necessary', noticable: 'noticeable',
    occassion: 'occasion', occasionaly: 'occasionally', offical: 'official',
    orginal: 'original', paralell: 'parallel', peice: 'piece',
    perfomance: 'performance', persistant: 'persistent', posession: 'possession',
    prefered: 'preferred', probaly: 'probably', proffesional: 'professional',
    publically: 'publicly', realy: 'really', reccomend: 'recommend',
    recomend: 'recommend', refered: 'referred', relevent: 'relevant',
    remeber: 'remember', responce: 'response', responsability: 'responsibility',
    rythm: 'rhythm', scedule: 'schedule', shedule: 'schedule',
    similiar: 'similar', sincerly: 'sincerely', succesful: 'successful',
    successfull: 'successful', sucess: 'success', suprise: 'surprise',
    truely: 'truly', usualy: 'usually', vaccum: 'vacuum',
    wierd: 'weird', writting: 'writing', yeild: 'yield',
  };

  /* ------------------------------------------------------------------ */
  /* Helpers                                                            */
  /* ------------------------------------------------------------------ */

  function matchCase(original, replacement){
    if (!replacement) return replacement;
    if (original.length > 1 && original === original.toUpperCase() && /[A-Z]/.test(original)) {
      return replacement.toUpperCase();
    }
    if (/^[A-Z]/.test(original)) {
      return replacement.charAt(0).toUpperCase() + replacement.slice(1);
    }
    return replacement;
  }

  /* Damerau-Levenshtein distance, early-exit above `max`. */
  function editDistance(a, b, max){
    if (a === b) return 0;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > max) return max + 1;
    const d = [];
    for (let i = 0; i <= la; i++) d[i] = [i];
    for (let j = 0; j <= lb; j++) d[0][j] = j;
    for (let i = 1; i <= la; i++) {
      let rowMin = Infinity;
      for (let j = 1; j <= lb; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          v = Math.min(v, d[i - 2][j - 2] + 1); // transposition
        }
        d[i][j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
    }
    return d[la][lb];
  }

  /* Spans (URLs, emails, code-ish tokens) the spellchecker must ignore. */
  const MASK_RE = /(?:https?:\/\/|www\.)[^\s]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|`[^`]*`/g;
  function maskedRanges(text){
    const ranges = [];
    MASK_RE.lastIndex = 0;
    let m;
    while ((m = MASK_RE.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
    return ranges;
  }
  function inRanges(ranges, start, end){
    for (const [a, b] of ranges) { if (start < b && end > a) return true; }
    return false;
  }

  const WORD_RE = /[A-Za-zÀ-ɏ]+(?:['’][A-Za-zÀ-ɏ]+)*/g;

  function normalizeApostrophes(word){
    return word.replace(/’/g, "'");
  }

  function isSkippableToken(token){
    if (token.length < 2) return true;
    // Acronyms / all-caps (SKU, ASAP) and mixed internal caps (FirstMate, iPhone)
    if (token.length > 1 && token === token.toUpperCase()) return true;
    if (/[A-Z]/.test(token.slice(1))) return true; // CamelCase / internal caps

    return false;
  }

  function isCustomWord(word){
    return state.customWords.has(word.toLowerCase());
  }

  function spellCorrect(token){
    if (state.correctCache.has(token)) return state.correctCache.get(token);
    let ok = false;
    try { ok = state.spell.correct(token); } catch { ok = false; }
    if (!ok) {
      // Possessives: "Acme's" — check the stem.
      const stem = token.replace(/'s$/i, '');
      if (stem !== token) { try { ok = state.spell.correct(stem); } catch { /* no */ } }
    }
    if (state.correctCache.size > 20000) state.correctCache.clear();
    state.correctCache.set(token, ok);
    return ok;
  }

  function spellSuggest(token){
    const key = token.toLowerCase();
    if (state.suggestCache.has(key)) {
      return state.suggestCache.get(key).map((s) => matchCase(token, s));
    }
    let raw = [];
    try { raw = state.spell.suggest(key) || []; } catch { raw = []; }
    const cleaned = [];
    for (const s of raw) {
      if (!cleaned.includes(s)) cleaned.push(s);
      if (cleaned.length >= 5) break;
    }
    if (state.suggestCache.size > SUGGEST_CACHE_MAX) state.suggestCache.clear();
    state.suggestCache.set(key, cleaned);
    return cleaned.map((s) => matchCase(token, s));
  }

  /* ------------------------------------------------------------------ */
  /* Grammar rule engine (deterministic, precision-first)               */
  /* ------------------------------------------------------------------ */

  const DOUBLED_WORD_EXCEPTIONS = new Set(['had', 'that', 'ha', 'no', 'so', 'la']);

  // "an" is correct before these consonant-spelled words (silent h etc.)
  const AN_CONSONANT = /^(hour|honest|honor|honou?r|heir|herb)/i;
  // "a" is correct before these vowel-spelled words (pronounced /ju:/, /w/, "one")
  const A_VOWEL = /^(uni(?![nm])|use|usu|usa|utah|euro|eu|ewe|one(?!r)|once|u[A-Z-])/i;

  function needsAn(word){
    if (AN_CONSONANT.test(word)) return true;
    if (A_VOWEL.test(word)) return false;
    return /^[aeiouAEIOU]/.test(word);
  }

  const ABBREVIATIONS = /(?:\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|approx|dept|est|min|max|no|inc|ltd|co|fig|e\.g|i\.e|a\.m|p\.m)|\b[A-Z])\.$/i;

  function grammarRules(text, out){
    let m;

    // 1. Repeated word ("the the")
    const doubled = /\b([A-Za-z]+)([ \t]+)\1\b/gi;
    while ((m = doubled.exec(text)) !== null) {
      const w = m[1];
      if (DOUBLED_WORD_EXCEPTIONS.has(w.toLowerCase())) continue;
      out.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `Repeated word: "${w}".`,
        replacements: [w],
      });
      doubled.lastIndex = m.index + m[0].length;
    }

    // 2. a/an agreement
    const article = /\b(a|an)([ \t]+)([A-Za-z][A-Za-z-]*)/gi;
    while ((m = article.exec(text)) !== null) {
      const art = m[1], next = m[3];
      if (next.length > 1 && next === next.toUpperCase()) continue; // acronyms: pronunciation unknown
      const wantAn = needsAn(next);
      const isAn = art.toLowerCase() === 'an';
      if (wantAn === isAn) continue;
      const fixed = matchCase(art, wantAn ? 'an' : 'a');
      out.push({
        start: m.index,
        end: m.index + art.length,
        message: wantAn
          ? `Use "an" before "${next}".`
          : `Use "a" before "${next}".`,
        replacements: [fixed],
      });
    }

    // 3. Modal + "of" ("could of" -> "could have")
    const modalOf = /\b(could|would|should|must|might|may)([ \t]+)of\b/gi;
    while ((m = modalOf.exec(text)) !== null) {
      out.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `Did you mean "${m[1]} have"?`,
        replacements: [`${m[1]} have`],
      });
    }

    // 4. "alot" -> "a lot"
    const alot = /\balot\b/gi;
    while ((m = alot.exec(text)) !== null) {
      out.push({
        start: m.index,
        end: m.index + m[0].length,
        message: '"alot" is not a word.',
        replacements: [matchCase(m[0], 'a lot')],
      });
    }

    // 5. "irregardless" -> "regardless"
    const irr = /\birregardless\b/gi;
    while ((m = irr.exec(text)) !== null) {
      out.push({
        start: m.index,
        end: m.index + m[0].length,
        message: 'Nonstandard word; use "regardless".',
        replacements: [matchCase(m[0], 'regardless')],
      });
    }

    // 6. "your welcome" at a clause boundary -> "you're welcome"
    const yw = /\byour([ \t]+)welcome\b(?=[ \t]*(?:[.!?,;:]|$))/gim;
    while ((m = yw.exec(text)) !== null) {
      out.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `Did you mean "you're welcome"?`,
        replacements: [`${matchCase(m[0], "you're")} welcome`],
      });
    }

    // 7. Lowercase sentence start (after . ! ?), guarded against abbreviations
    const sentStart = /([.!?])([ \t]+)([a-z])/g;
    while ((m = sentStart.exec(text)) !== null) {
      const before = text.slice(Math.max(0, m.index - 8), m.index + 1);
      if (ABBREVIATIONS.test(before)) continue;
      const capIdx = m.index + 1 + m[2].length;
      out.push({
        start: capIdx,
        end: capIdx + 1,
        message: 'Sentence should start with a capital letter.',
        replacements: [m[3].toUpperCase()],
      });
    }

    // 8. Space before punctuation ("word ," -> "word,")
    const spacePunct = /([A-Za-z0-9])([ \t]+)([,.;:!?])(?=\s|$)/g;
    while ((m = spacePunct.exec(text)) !== null) {
      // Don't fight ellipses or spaced en-dash conventions
      if (m[3] === '.' && text[m.index + m[0].length] === '.') continue;
      out.push({
        start: m.index + 1,
        end: m.index + m[0].length,
        message: 'Remove the space before the punctuation.',
        replacements: [m[3]],
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Vendor loading                                                     */
  /* ------------------------------------------------------------------ */

  function loadScript(url){
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = url;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error(`Failed to load ${url}`));
      document.head.appendChild(el);
    });
  }

  async function fetchText(url){
    const resp = await fetch(url, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error(`${resp.status} fetching ${url}`);
    return resp.text();
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                         */
  /* ------------------------------------------------------------------ */

  const api = {
    __initialized: true,

    /** Load engines + dictionaries. Safe to call more than once. */
    init(options){
      if (state.initPromise) return state.initPromise;
      const opts = options || {};
      if (opts.baseUrl) {
        state.baseUrl = String(opts.baseUrl).endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`;
      }
      if (Array.isArray(opts.customWords)) {
        for (const w of opts.customWords) {
          if (typeof w === 'string' && w.trim()) state.customWords.add(w.trim().toLowerCase());
        }
      }
      if (typeof opts.onAddWord === 'function') state.onAddWord = opts.onAddWord;

      state.initPromise = (async () => {
        try {
          if (typeof root.__FMNSpellFactory !== 'function') {
            await loadScript(`${state.baseUrl}vendor/nspell.min.js`);
          }
          const [aff, dic] = await Promise.all([
            fetchText(`${state.baseUrl}vendor/en_US.aff`),
            fetchText(`${state.baseUrl}vendor/en_US.dic`),
          ]);
          state.spell = root.__FMNSpellFactory(aff, dic);
          for (const w of state.customWords) { try { state.spell.add(w); } catch { /* ignore */ } }
          state.spellReady = true;
        } catch (err) {
          state.spellReady = false;
          console.warn('[FMDocLanguage] spelling engine unavailable:', err);
        }
        return api.status();
      })();
      return state.initPromise;
    },

    status(){
      return {
        spelling: state.spellReady,
        grammar: true,               // built-in rule engine, always available
        grammarEngine: 'fm-rules',   // deterministic rules, not ML
        dictionary: 'en_US (SCOWL)',
      };
    },

    /** -> [{ word, start, end, suggestions }] */
    checkSpelling(text){
      const results = [];
      if (!state.spellReady || typeof text !== 'string' || !text) return results;
      const masked = maskedRanges(text);
      WORD_RE.lastIndex = 0;
      let m;
      while ((m = WORD_RE.exec(text)) !== null) {
        const rawToken = m[0];
        const start = m.index;
        const end = start + rawToken.length;
        if (inRanges(masked, start, end)) continue;
        const token = normalizeApostrophes(rawToken);
        if (isSkippableToken(token)) continue;
        if (isCustomWord(token)) continue;
        // Skip file-ish / id-ish contexts: letter run glued to digits
        if (/[0-9]/.test(text[start - 1] || '') || /[0-9]/.test(text[end] || '')) continue;
        if (spellCorrect(token)) continue;
        results.push({ word: rawToken, start, end, suggestions: spellSuggest(token) });
      }
      return results;
    },

    /** -> [{ start, end, message, replacements }] ([] if engine unavailable) */
    checkGrammar(text){
      const results = [];
      if (typeof text !== 'string' || !text) return results;
      try {
        grammarRules(text, results);
      } catch (err) {
        console.warn('[FMDocLanguage] grammar check failed:', err);
        return [];
      }
      results.sort((a, b) => a.start - b.start || a.end - b.end);
      return results;
    },

    /** Obvious-typo fix for a just-typed word. -> replacement | null */
    autocorrect(word, _context){
      if (typeof word !== 'string') return null;
      const token = normalizeApostrophes(word.trim());
      if (token.length < 2 || !/^[A-Za-z][A-Za-z']*$/.test(token)) return null;
      if (isCustomWord(token)) return null;
      const lower = token.toLowerCase();

      // 1. Curated map (null entries mark ambiguous words: never touch).
      if (Object.prototype.hasOwnProperty.call(COMMON_TYPOS, lower)) {
        const fix = COMMON_TYPOS[lower];
        if (!fix) return null;
        // "I'm"-style fixes already carry their casing.
        return /^[A-Z]/.test(fix) ? fix : matchCase(token, fix);
      }

      // 2. Dictionary-backed: unambiguous single-edit-distance fix.
      if (!state.spellReady || token.length < 3) return null;
      if (token.length > 1 && token === token.toUpperCase()) return null; // acronyms
      if (spellCorrect(token)) return null;
      let suggestions = [];
      try { suggestions = state.spell.suggest(lower) || []; } catch { return null; }
      const oneEdit = [];
      for (const s of suggestions) {
        const cand = s.toLowerCase();
        if (cand.includes(' ') || cand.includes('-')) continue;
        if (editDistance(lower, cand, 1) === 1 && !oneEdit.includes(cand)) oneEdit.push(cand);
      }
      if (oneEdit.length !== 1) return null; // ambiguous -> leave it flagged, don't auto-fix
      return matchCase(token, oneEdit[0]);
    },

    /** Accept a word for this org/user. Persistence is the host's job. */
    addToDictionary(word){
      if (typeof word !== 'string') return false;
      const clean = word.trim();
      if (!clean) return false;
      state.customWords.add(clean.toLowerCase());
      if (state.spellReady) {
        try { state.spell.add(clean); } catch { /* ignore */ }
      }
      state.correctCache.delete(clean);
      state.correctCache.delete(clean.toLowerCase());
      state.suggestCache.delete(clean.toLowerCase());
      if (state.onAddWord) {
        try { state.onAddWord(clean); } catch (err) { console.warn('[FMDocLanguage] onAddWord failed:', err); }
      }
      return true;
    },
  };

  root.FMDocLanguage = api;
})();
