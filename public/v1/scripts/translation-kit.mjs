/** Offline context extraction and translation handoff. Never calls a model or deploys. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { IntlMessageFormat } from 'intl-messageformat';

const root = path.resolve(import.meta.dirname, '../../..');
const base = path.join(root, 'public/v1/platform/localization');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const save = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); };
export const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const message = value => typeof value === 'string' ? value : value.message;
export function localeCode(value) {
  if (!value || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)) throw Error('Provide a BCP-47 locale, e.g. fr-FR');
  return Intl.getCanonicalLocales(value)[0];
}
export function argumentsOf(value, locale = 'en-US') {
  if (typeof value === 'string') return {};
  const found = {};
  function visit(nodes) { for (const n of nodes) {
    if (n.type >= 1 && n.type <= 6) {
      const type = ({ 1: 'text', 2: 'number', 3: 'date', 4: 'time', 5: 'select', 6: n.pluralType === 'ordinal' ? 'ordinal' : 'plural' })[n.type];
      found[n.value] = type;
    }
    if (n.options) for (const option of Object.values(n.options)) visit(option.value);
    if (n.children) visit(n.children);
  } }
  visit(new IntlMessageFormat(value.message, locale, undefined, { ignoreTag: true }).getAst());
  return Object.fromEntries(Object.entries(found).sort());
}
export function validateTranslation(source, translated, locale) {
  if (typeof translated !== 'string' || !translated.trim()) throw Error('Translation must be a nonempty string');
  if (typeof source !== 'string') {
    if (JSON.stringify(argumentsOf(source)) !== JSON.stringify(argumentsOf({ message: translated, format: 'icu' }, locale))) throw Error('ICU placeholder names or types changed');
  } else if (/\{[\w]+(?:[,}])/.test(translated) && !/\{[\w]+(?:[,}])/.test(source)) throw Error('Unexpected placeholder');
  const tokens = text => [...text.matchAll(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);|<\/?[a-z][^>]*>|https?:\/\/[^\s<>]+/gi)].map(m => m[0]).sort();
  if (JSON.stringify(tokens(message(source))) !== JSON.stringify(tokens(translated))) throw Error('HTML, entity or URL tokens changed');
  return typeof source === 'string' ? translated : { message: translated, format: 'icu' };
}
function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.isDirectory()) return /^(node_modules|dist|vendor|tests|scripts|catalogs|\.git|\.tmp)$/.test(e.name) ? [] : sources(path.join(dir, e.name));
    return /\.(?:js|ts)$/.test(e.name) && !/\.(?:min|bundle)\.js$/.test(e.name) ? [path.join(dir, e.name)] : [];
  });
}
function collectReferences(catalog) {
  const byKey = new Map(), byText = new Map(), refs = new Map();
  for (const [ns, entries] of Object.entries(catalog)) for (const [key, entry] of Object.entries(entries)) {
    const id = `${ns}/${key}`;
    byKey.set(key, [...(byKey.get(key) || []), id]);
    byText.set(message(entry), [...(byText.get(message(entry)) || []), id]);
  }
  for (const file of sources(path.join(root, 'public'))) {
    if (/platform-language[/\\]platform-language\.js$/.test(file)) continue;
    const code = fs.readFileSync(file, 'utf8');
    const tree = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const ids = byKey.get(node.text) || (node.text.length > 16 ? byText.get(node.text) : undefined);
        if (ids) {
          const call = ts.isCallExpression(node.parent) ? node.parent : null;
          const ns = call?.arguments[0]?.text;
          const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
          let ancestor = node.parent;
          while (ancestor.parent && ancestor.end - ancestor.getStart(tree) < 200) ancestor = ancestor.parent;
          const excerpt = code.slice(Math.max(0, node.getStart(tree) - 180), Math.min(code.length, node.end + 240));
          const property = ts.isPropertyAssignment(ancestor) ? ancestor.name.getText(tree) : '';
          const role = /placeholder/.test(property + excerpt) ? 'input guidance' : /aria-label|ariaLabel/.test(property + excerpt) ? 'accessible label' : /title|heading/.test(property) ? 'heading' : /showToast|toast\(/.test(excerpt) ? 'notification' : 'interface or output text';
          for (const id of ids) {
            if (call && /\.text$/.test(call.expression.getText(tree)) && ns && catalog[ns] && !id.startsWith(ns + '/')) continue;
            const list = refs.get(id) || [];
            const relative = path.relative(root, file).replaceAll('\\', '/');
            if (list.length < 8 && !list.some(r => r.file === relative && r.line === line)) list.push({ file: relative, line, role, excerpt });
            refs.set(id, list);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  return refs;
}
export function makeEntries(catalog, notes, references = new Map()) {
  const entries = [];
  for (const [namespace, messages] of Object.entries(catalog)) {
    const pairs = Object.entries(messages);
    pairs.forEach(([key, source], index) => {
      const id = `${namespace}/${key}`, sourceHash = hash(source), note = notes.messages?.[id];
      const reviewed = !!note?.meaning && note.source_hash === sourceHash;
      const usages = references.get(id) || [];
      const placeholders = argumentsOf(source);
      entries.push({ id, namespace, key, source: message(source), format: typeof source === 'string' ? 'plain' : 'icu', source_hash: sourceHash,
        context: {
          surface: notes.namespaces?.[namespace] || `The ${namespace} area of the FirstMate business platform.`,
          meaning: reviewed ? note.meaning : null,
          roles: [...new Set(usages.map(r => r.role))],
          nearby_catalog_text: pairs.slice(Math.max(0, index - 2), index + 3).filter(([k]) => k !== key).map(([, s]) => message(s)),
          placeholders: Object.fromEntries(Object.entries(placeholders).map(([name, type]) => [name, { type, meaning: reviewed ? note.placeholders?.[name] || null : null }])),
          constraints: reviewed ? note.constraints || [] : [],
          status: reviewed ? 'reviewed' : 'needs_context_review'
        }, references: usages });
    });
  }
  return entries;
}
const instructions = [
  'Translate only the assigned English source into the target locale. Do not read or edit application code, register packs, run app tests or deploy.',
  'Use the shared glossary and per-message context. Nearby catalog text is a clue, not proof of UI order. Automatically inferred roles may be approximate.',
  'Preserve keys, ICU placeholder names/types and plural syntax, HTML/entities, URLs, brand names and meaningful leading/trailing spaces. Use natural target-language grammar.',
  'Do not convert prices, units or numeric values. Credit means prepaid account balance where used in billing, not a loan. Roof pitch means roof slope.',
  'Return only the output JSON shape supplied. Leave uncertain translations null and put questions in issues. Never invent context.',
  'Maintain a locale glossary across packets. Work in packet-sized batches; do not load the entire catalog into one model context.'
];
export function validateResponse(packet, response, catalog) {
  if (response.packet_id !== packet.packet_id || response.locale !== packet.locale) throw Error('Wrong packet or locale');
  const allowed = new Map(packet.entries.map(e => [e.id, e]));
  if (!response.translations || typeof response.translations !== 'object' || Array.isArray(response.translations)) throw Error('Missing translations map');
  const result = {};
  for (const [id, translated] of Object.entries(response.translations)) {
    const entry = allowed.get(id);
    if (!entry) throw Error(`Unknown message: ${id}`);
    const source = catalog[entry.namespace]?.[entry.key];
    if (source === undefined || hash(source) !== entry.source_hash) throw Error(`Stale source: ${id}`);
    if (translated === null) continue;
    (result[entry.namespace] ||= {})[entry.key] = validateTranslation(source, translated, packet.locale);
  }
  for (const id of allowed.keys()) if (!(id in response.translations)) throw Error(`Missing response entry: ${id}; use null for unresolved text`);
  return result;
}
function main() {
  const [command, ...args] = process.argv.slice(2);
  const option = name => { const i = args.indexOf('--' + name); return i < 0 ? undefined : args[i + 1]; };
  const out = path.resolve(option('out') || path.join(root, 'output/translation-kit'));
  const catalog = read(path.join(base, 'catalog-source.json'));
  const notes = read(path.join(base, 'translation-context.json'));
  if (command === 'context') {
    const entries = makeEntries(catalog, notes, collectReferences(catalog));
    save(path.join(out, 'context.json'), { schema_version: 1, catalog_hash: hash(catalog), instructions, glossary: notes.glossary, entries });
    const groups = {};
    for (const entry of entries) (groups[entry.namespace] ||= []).push(entry);
    for (const [namespace, group] of Object.entries(groups)) {
      for (let i = 0; i < group.length; i += 60) save(path.join(out, 'context-review', `${namespace}-${String(i / 60 + 1).padStart(3, '0')}.json`), {
        instructions: 'Context author: inspect these source excerpts/references once. Record concise meaning, placeholder meanings and constraints in translation-context.json messages keyed by id with the matching source_hash. Do not translate. Do not mark uncertain meanings reviewed. All language workers reuse your notes. Split catalog keys when one key has incompatible meanings.',
        entries: group.slice(i, i + 60)
      });
    }
    console.log(JSON.stringify({ entries: entries.length, reviewed: entries.filter(e => e.context.status === 'reviewed').length, referenced: entries.filter(e => e.references.length).length, out }));
  } else if (command === 'packets') {
    const locale = localeCode(option('locale'));
    const context = read(path.join(out, 'context.json'));
    if (context.catalog_hash !== hash(catalog)) throw Error('Catalog changed; regenerate context');
    const refreshed = makeEntries(catalog, notes, new Map(context.entries.map(e => [e.id, e.references])));
    const pending = refreshed.filter(e => e.context.status !== 'reviewed');
    if (pending.length && !args.includes('--allow-unreviewed')) throw Error(`${pending.length} messages need shared context review; use --allow-unreviewed only for a draft translation run`);
    const groups = {};
    for (const { references, ...entry } of refreshed) (groups[entry.namespace] ||= []).push(entry);
    const activePackets = [];
    for (const [namespace, entries] of Object.entries(groups)) for (let i = 0; i < entries.length; i += 60) {
      const body = { schema_version: 1, locale, instructions, glossary: notes.glossary, entries: entries.slice(i, i + 60) };
      const packet_id = hash(body), stem = `${namespace}-${String(i / 60 + 1).padStart(3, '0')}-${packet_id.slice(0, 10)}`;
      save(path.join(out, locale, 'input', stem + '.json'), { packet_id, ...body });
      const response = path.join(out, locale, 'responses', stem + '.json');
      if (!fs.existsSync(response)) save(response, { packet_id, locale, translations: Object.fromEntries(body.entries.map(e => [e.id, null])), issues: [] });
      activePackets.push({ packet_id, input: `input/${stem}.json`, response: `responses/${stem}.json`, messages: body.entries.length });
    }
    save(path.join(out, locale, 'manifest.json'), { schema_version: 1, locale, catalog_hash: hash(catalog), unresolved_context: pending.length, packets: activePackets });
    console.log(JSON.stringify({ locale, packets: activePackets.length, unresolved_context: pending.length, out }));
  } else if (command === 'import') {
    const packet = read(path.resolve(option('packet'))), response = read(path.resolve(option('response')));
    const locale = localeCode(packet.locale);
    if (locale === 'en-US' || locale === 'en-GB') throw Error('Existing English catalogs are maintained separately');
    const { packet_id, ...body } = packet;
    if (hash(body) !== packet_id) throw Error('Packet content changed');
    const accepted = validateResponse(packet, response, catalog);
    const file = path.join(base, 'packs', locale + '.json');
    const existing = fs.existsSync(file) ? read(file) : {};
    for (const [ns, values] of Object.entries(accepted)) existing[ns] = { ...existing[ns], ...values };
    save(file, existing);
    console.log(JSON.stringify({ locale, imported: Object.values(accepted).reduce((n, e) => n + Object.keys(e).length, 0), issues: response.issues || [], file }));
  } else if (command === 'register') {
    const locale = localeCode(option('locale')), label = option('label'), direction = option('direction') || 'ltr';
    if (!label || !['ltr', 'rtl'].includes(direction)) throw Error('Provide --label and optional --direction ltr|rtl');
    if (['en-US', 'en-GB'].includes(locale)) throw Error('Existing English packs are maintained separately');
    const pack = read(path.join(base, 'packs', locale + '.json'));
    let translated = 0;
    for (const [ns, entries] of Object.entries(pack)) for (const [key, entry] of Object.entries(entries)) {
      const source = catalog[ns]?.[key];
      if (source === undefined) throw Error(`Unknown key ${ns}/${key}`);
      validateTranslation(source, message(entry), locale);
      translated++;
    }
    const total = Object.values(catalog).reduce((n, entries) => n + Object.keys(entries).length, 0);
    if (!translated) throw Error('Cannot register an empty pack');
    if (translated < total && !args.includes('--allow-partial')) throw Error(`${translated}/${total} messages translated; use --allow-partial to enable English fallback during testing`);
    const file = path.join(base, 'languages.json'), registry = read(file);
    registry.packs = [...registry.packs.filter(pack => pack.code !== locale), { code: locale, label, direction }];
    save(file, registry);
    console.log(JSON.stringify({ locale, translated, total, english_fallback: total - translated, next: 'Run localization:build and deploy through the normal development release workflow.' }));
  } else throw Error('Commands: context | packets --locale fr-FR [--allow-unreviewed] | import --packet FILE --response FILE | register --locale fr-FR --label Français [--allow-partial]; optional --out DIRECTORY');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
