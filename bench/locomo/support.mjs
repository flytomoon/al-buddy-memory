/**
 * The support check (`--support-check`): before the reader answers, do the
 * turns it is shown say what the question asks of the person it names? No
 * model call: it reads the shown turns' words and who said them.
 *
 * Why: three in four of LoCoMo's 446 adversarial questions take a thing one
 * speaker said and ask it of the other ("What did Caroline realize after her
 * charity race?" when the race was Melanie's); 39 of the 1,540 scored
 * questions look like that. The reader (the pinned c25 prompt) is never told
 * it may say a thing was not mentioned, so it answers with the other
 * speaker's story.
 *
 * The check runs only when the question names exactly one of the two
 * speakers (by name, or by a capitalised word of three or more letters that
 * begins it, "Deb" for Deborah). The question's content words (names,
 * pronouns, question and counting words left out; compared by their first
 * five letters, so "research" matches "researching") are counted in each
 * shown turn. A turn counts for the named person when that person said it, or
 * when the other speaker said it to or of them (it says "you", "your" or
 * their name). It fires when the best turn of the other speaker's own (none
 * of those words) matches at least two of the question's words and more than
 * any turn for the named person does.
 *
 * Measured over all 1,986 questions with the retrieval it ships beside
 * (`--expand --strip-speakers --content-words --neighbours 34`), no model:
 * it fires on 90 of the 446 adversarial questions (69 of them ones the
 * reader of the first full run, 2026-11-17, did not abstain on), and on 3 of
 * 282 in category 1, 1 of 321 in category 2, 0 of 96 in category 3 and 10 of
 * 841 in category 4. Gates read from recall's ranking instead (the top one or
 * two shown turns are the other speaker's own) reach a few more adversarial
 * questions at about one more category-4 question each; not used.
 *
 * When it fires, the reader's context ends with `supportNote`. The memories
 * themselves are shown as they are, word for word; the note is a separate
 * paragraph after them, and is the only thing the check changes.
 */

const STOP = new Set(
  (
    "how many much often long what which who whom whose when where why is are was were be been being am do does did done have has had " +
    "i me my mine myself we us our you your he him his she her hers they them their theirs " +
    "the a an of to in on at for from by with about into and or that this these those it its there " +
    "total number amount count times altogether combined overall sum different all both each every any some can could would should will just also " +
    "currently current now still ever far so recently lately kind type get got make made go went like"
  ).split(" "),
);
const stem = (w) => w.replace(/['’]s$/, "").slice(0, 5);
const words = (text) => String(text).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
/** The content words of `text`, stemmed, each once. */
export const contentTerms = (text) => [...new Set(words(text).filter((w) => !STOP.has(w) && w.length > 2).map(stem))];

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameRe = (name, extra = "") => new RegExp(`(?<![\\p{L}\\p{N}])(?:${extra}${escapeRegExp(name)})(?![\\p{L}\\p{N}])`, "iu");
const firstName = (s) => s.trim().split(/\s+/)[0];

/** Whether `question` names `name`: the name itself, or a capitalised word of three or more letters it begins with ("Deb" for Deborah). */
function namesSpeaker(question, name) {
  if (nameRe(name).test(question)) return true;
  return (question.match(/(?<![\p{L}\p{N}])\p{Lu}\p{Ll}{2,}(?![\p{L}\p{N}])/gu) ?? []).some((w) => w.length < name.length && name.startsWith(w));
}

/**
 * The check for one question against the turns the reader is shown.
 * `{ checked: false, why }` when it does not apply; otherwise
 * `{ checked: true, person, other, terms, bestPerson, bestOther, fired }`.
 */
export function supportCheck(question, speakers, shown) {
  const names = speakers.map(firstName);
  if (names.length !== 2 || names[0].toLowerCase() === names[1].toLowerCase()) return { checked: false, why: "the speakers' first names do not tell them apart" };
  const named = names.filter((n) => namesSpeaker(question, n));
  if (named.length !== 1) return { checked: false, why: named.length === 0 ? "names neither speaker" : "names both speakers" };
  const person = named[0];
  const other = names.find((n) => n !== person);
  let rest = question;
  for (const n of names) rest = rest.replace(new RegExp(nameRe(n).source + "(?:['’]s)?", "giu"), " ");
  const terms = contentTerms(rest);
  if (terms.length === 0) return { checked: false, why: "no content words" };
  const addressed = nameRe(person, "you|your|yours|");
  let bestPerson = 0;
  let bestOther = 0;
  for (const t of shown) {
    const have = new Set(contentTerms(`${t.text} ${t.caption ?? ""}`));
    const n = terms.filter((w) => have.has(w)).length;
    if (firstName(t.speaker) === person || addressed.test(t.text)) bestPerson = Math.max(bestPerson, n);
    else bestOther = Math.max(bestOther, n);
  }
  return { checked: true, person, other, terms: terms.length, bestPerson, bestOther, fired: bestOther >= 2 && bestOther > bestPerson };
}

/** NOT from the pinned prompts file: the paragraph the context ends with when the check fires. */
export function supportNote({ person, other }) {
  return `Note: of the memories above, the ones that share the most words with this question were said by ${other}, not by or to ${person}. Answer only from what is said by or about ${person}; if nothing above says it of ${person}, answer that it is not mentioned in the conversation.`;
}

export const SUPPORT_CHECK_DESCRIPTION =
  "bench/locomo/support.mjs supportCheck, no model call: when the question names one speaker (or a capitalised word of 3+ letters that begins that speaker's name), and the shown turn of the other speaker's own (no \"you\", \"your\" or the named one's name) that shares the most of the question's content words shares at least two and more than any turn said by or to the named one, the context ends with supportNote: \"Note: of the memories above, the ones that share the most words with this question were said by <other>, not by or to <named>. Answer only from what is said by or about <named>; if nothing above says it of <named>, answer that it is not mentioned in the conversation.\"";
