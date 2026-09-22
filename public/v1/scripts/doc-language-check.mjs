/**
 * Verification for the FMDocLanguage engine (spellcheck / grammar / autocorrect).
 * Loads the dev harness over the local nginx stack and asserts the public API.
 *
 *   node scripts/doc-language-check.mjs      (from public/v1; local stack on :8011)
 */
import { chromium } from "playwright-core";
import { access } from "node:fs/promises";

const HARNESS = process.env.LANG_HARNESS_URL || "http://127.0.0.1:8011/libraries/doc-language/dev-language.html";

async function browserPath() {
  const candidates = process.platform === "win32"
    ? ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
       "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
       "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium"];
  for (const c of candidates) { try { await access(c); return c; } catch { /* next */ } }
  throw new Error("no Chrome/Edge found");
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : "  " + JSON.stringify(detail).slice(0, 400)}`);
};

const browser = await chromium.launch({ executablePath: await browserPath(), headless: true, args: ["--no-sandbox"] });
const page = await (await browser.newContext()).newPage();
page.on("pageerror", (e) => console.log("   [pageerror]", e.message));

await page.goto(HARNESS, { waitUntil: "domcontentloaded" });

// --- init ---------------------------------------------------------------
const status = await page.evaluate(() => window.__langReady);
check("init resolves with spelling engine ready", status && status.spelling === true, status);

// --- spelling -----------------------------------------------------------
const misspelled = await page.evaluate(() => FMDocLanguage.checkSpelling("I will recieve the package tomorrow."));
const recieve = (misspelled || []).find((r) => r.word === "recieve");
check("\"recieve\" is flagged", !!recieve, misspelled);
check("\"recieve\" suggests \"receive\"", !!recieve && recieve.suggestions.includes("receive"), recieve && recieve.suggestions);
check("flag carries correct offsets", !!recieve && recieve.start === 7 && recieve.end === 14, recieve && { start: recieve.start, end: recieve.end });
check("suggestions capped at 5", (misspelled || []).every((r) => r.suggestions.length <= 5));

const clean = await page.evaluate(() => FMDocLanguage.checkSpelling("The quick brown fox jumps over the lazy dog."));
check("clean sentence has no spelling flags", Array.isArray(clean) && clean.length === 0, clean);

const skips = await page.evaluate(() => FMDocLanguage.checkSpelling("Email jane@exampl.com about https://exampl.com/xyz and the NASA API for FirstMate."));
check("urls/emails/acronyms/custom words not flagged", Array.isArray(skips) && skips.length === 0, skips);

// --- autocorrect --------------------------------------------------------
const auto = await page.evaluate(() => ({
  teh: FMDocLanguage.autocorrect("teh"),
  Teh: FMDocLanguage.autocorrect("Teh"),
  recieve: FMDocLanguage.autocorrect("recieve"),
  langauge: FMDocLanguage.autocorrect("langauge"),
  the: FMDocLanguage.autocorrect("the"),
  hous: FMDocLanguage.autocorrect("hous"),
}));
check("autocorrect(\"teh\") === \"the\"", auto.teh === "the", auto.teh);
check("autocorrect preserves case (Teh -> The)", auto.Teh === "The", auto.Teh);
check("autocorrect fixes curated typo recieve -> receive", auto.recieve === "receive", auto.recieve);
check("autocorrect single-edit fix langauge -> language", auto.langauge === "language", auto.langauge);
check("autocorrect leaves correct words alone", auto.the === null, auto.the);
check("autocorrect refuses ambiguous fixes (hous)", auto.hous === null, auto.hous);

// --- grammar ------------------------------------------------------------
const gStatus = await page.evaluate(() => FMDocLanguage.status());
if (!gStatus.grammar) {
  console.log("NOTE  grammar engine reported unavailable; checkGrammar degrades to []");
  const empty = await page.evaluate(() => FMDocLanguage.checkGrammar("the the"));
  check("grammar unavailable degrades to empty array", Array.isArray(empty) && empty.length === 0, empty);
} else {
  const doubled = await page.evaluate(() => FMDocLanguage.checkGrammar("I saw the the dog."));
  const dbl = (doubled || []).find((r) => /repeated/i.test(r.message));
  check("doubled word (\"the the\") is flagged", !!dbl, doubled);
  check("doubled-word fix offered", !!dbl && dbl.replacements.includes("the"), dbl && dbl.replacements);

  const gAll = await page.evaluate(() => FMDocLanguage.checkGrammar("It was a honest answer. You could of asked. thanks alot."));
  const an = gAll.find((r) => /"an"/.test(r.message));
  const of_ = gAll.find((r) => /could have/.test(r.message));
  const alot = gAll.find((r) => /alot/.test(r.message));
  const cap = gAll.find((r) => /capital/i.test(r.message));
  check("a/an agreement flagged (a honest -> an)", !!an && an.replacements.includes("an"), an);
  check("\"could of\" flagged with \"could have\"", !!of_ && of_.replacements.includes("could have"), of_);
  check("\"alot\" flagged", !!alot && alot.replacements.includes("a lot"), alot);
  check("lowercase sentence start flagged", !!cap && cap.replacements.includes("T"), cap);

  const gClean = await page.evaluate(() => FMDocLanguage.checkGrammar("This is a perfectly normal sentence. It reads well."));
  check("clean text has no grammar flags", Array.isArray(gClean) && gClean.length === 0, gClean);
}

// --- custom dictionary --------------------------------------------------
const custom = await page.evaluate(() => {
  const before = FMDocLanguage.checkSpelling("Powered by Roofalytics today.");
  FMDocLanguage.addToDictionary("Roofalytics");
  const after = FMDocLanguage.checkSpelling("Powered by Roofalytics today.");
  return { before: before.length, after: after.length, added: window.__addedWords.slice() };
});
check("unknown brand word flagged before addToDictionary", custom.before === 1, custom);
check("addToDictionary clears the flag", custom.after === 0, custom);
check("onAddWord callback fired", custom.added.includes("Roofalytics"), custom.added);

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED:", failed.map((f) => f.name).join("; "));
  process.exit(1);
}
