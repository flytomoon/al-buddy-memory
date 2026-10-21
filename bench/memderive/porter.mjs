/**
 * The Porter stemmer (M.F. Porter, "An algorithm for suffix stripping", 1980),
 * as Lucene's PorterStemFilter and Pyserini's default English analyzer apply
 * it. Bench-only: it gives the BM25 baseline the stemming a standard BM25 run
 * has. Input is one lowercase word; words of two letters or fewer are returned
 * unchanged.
 */

const isConsonant = (w, i) => {
  const c = w[i];
  if ("aeiou".includes(c)) return false;
  if (c === "y") return i === 0 || !isConsonant(w, i - 1);
  return true;
};

/** m in [C](VC)^m[V], over w[0..end). */
function measure(w, end = w.length) {
  let m = 0;
  let i = 0;
  while (i < end && isConsonant(w, i)) i += 1;
  while (i < end) {
    while (i < end && !isConsonant(w, i)) i += 1;
    if (i >= end) break;
    while (i < end && isConsonant(w, i)) i += 1;
    m += 1;
  }
  return m;
}

const hasVowel = (w, end = w.length) => {
  for (let i = 0; i < end; i += 1) if (!isConsonant(w, i)) return true;
  return false;
};

const endsDoubleConsonant = (w) => w.length >= 2 && w[w.length - 1] === w[w.length - 2] && isConsonant(w, w.length - 1);

/** *o: the stem ends consonant-vowel-consonant, the last not w, x or y. */
const endsCvc = (w) => {
  const n = w.length;
  if (n < 3) return false;
  if (!isConsonant(w, n - 3) || isConsonant(w, n - 2) || !isConsonant(w, n - 1)) return false;
  return !"wxy".includes(w[n - 1]);
};

/** Replace `suffix` by `to` when the stem left before it has measure > `min`; returns null when the suffix does not match. */
function replaceIf(w, suffix, to, min) {
  if (!w.endsWith(suffix)) return null;
  const stem = w.slice(0, w.length - suffix.length);
  return measure(stem) > min ? stem + to : w;
}

const STEP2 = [
  ["ational", "ate"], ["tional", "tion"], ["enci", "ence"], ["anci", "ance"], ["izer", "ize"], ["bli", "ble"],
  ["alli", "al"], ["entli", "ent"], ["eli", "e"], ["ousli", "ous"], ["ization", "ize"], ["ation", "ate"],
  ["ator", "ate"], ["alism", "al"], ["iveness", "ive"], ["fulness", "ful"], ["ousness", "ous"], ["aliti", "al"],
  ["iviti", "ive"], ["biliti", "ble"], ["logi", "log"],
];
const STEP3 = [["icate", "ic"], ["ative", ""], ["alize", "al"], ["iciti", "ic"], ["ical", "ic"], ["ful", ""], ["ness", ""]];
const STEP4 = ["al", "ance", "ence", "er", "ic", "able", "ible", "ant", "ement", "ment", "ent", "ion", "ou", "ism", "ate", "iti", "ous", "ive", "ize"];

/** The first rule in `rules` whose suffix matches decides, whether or not its condition holds. */
function firstRule(w, rules, min) {
  for (const [suffix, to] of rules) {
    const out = replaceIf(w, suffix, to, min);
    if (out !== null) return out;
  }
  return w;
}

export function porterStem(word) {
  let w = word;
  if (w.length <= 2) return w;

  // Step 1a
  if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ies")) w = w.slice(0, -2);
  else if (w.endsWith("ss")) {
    /* unchanged */
  } else if (w.endsWith("s")) w = w.slice(0, -1);

  // Step 1b
  let cleanup = false;
  if (w.endsWith("eed")) {
    if (measure(w, w.length - 3) > 0) w = w.slice(0, -1);
  } else if (w.endsWith("ed") && hasVowel(w, w.length - 2)) {
    w = w.slice(0, -2);
    cleanup = true;
  } else if (w.endsWith("ing") && hasVowel(w, w.length - 3)) {
    w = w.slice(0, -3);
    cleanup = true;
  }
  if (cleanup) {
    if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) w += "e";
    else if (endsDoubleConsonant(w) && !"lsz".includes(w[w.length - 1])) w = w.slice(0, -1);
    else if (measure(w) === 1 && endsCvc(w)) w += "e";
  }

  // Step 1c
  if (w.endsWith("y") && hasVowel(w, w.length - 1)) w = `${w.slice(0, -1)}i`;

  // Steps 2 and 3
  w = firstRule(w, STEP2, 0);
  w = firstRule(w, STEP3, 0);

  // Step 4: the longest matching suffix decides
  for (const suffix of [...STEP4].sort((a, b) => b.length - a.length)) {
    if (!w.endsWith(suffix)) continue;
    const stem = w.slice(0, w.length - suffix.length);
    const ok = measure(stem) > 1 && (suffix !== "ion" || stem.endsWith("s") || stem.endsWith("t"));
    if (ok) w = stem;
    break;
  }

  // Step 5a
  if (w.endsWith("e")) {
    const stem = w.slice(0, -1);
    const m = measure(stem);
    if (m > 1 || (m === 1 && !endsCvc(stem))) w = stem;
  }
  // Step 5b
  if (measure(w) > 1 && endsDoubleConsonant(w) && w.endsWith("l")) w = w.slice(0, -1);
  return w;
}
