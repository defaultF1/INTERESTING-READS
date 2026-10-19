import { essays, type Essay } from "../data/essays";

/**
 * The single search entry point used by the UI.
 *
 * Today it ranks the shelf on the client. To plug in an AI endpoint later
 * (e.g. POST /api/search -> { ids: string[] }), change only this function:
 * call the endpoint, keep ids that exist in `essays`, and fall back to
 * `localSearch(query)` on any error. The UI never needs to change.
 *
 * Returns essay ids, best match first.
 */
export async function searchEssays(query: string): Promise<string[]> {
  return localSearch(query);
}

// ---------------------------------------------------------------------------
// Client-side ranked search: tokenized, every term must match somewhere,
// weighted by field.
// ---------------------------------------------------------------------------

const FIELD_WEIGHTS = {
  title: 6,
  topics: 4,
  author: 4,
  publication: 3,
  description: 2,
  format: 1.5,
} as const;
type Field = keyof typeof FIELD_WEIGHTS;

/** Extra words that should find each format. */
const FORMAT_WORDS: Record<Essay["format"], string> = {
  essay: "essay essays article articles",
  video: "video videos youtube watch film",
  x_post: "x post posts tweet tweets thread twitter",
  book: "book books",
};

/** Filler words dropped from queries ("essays about money" -> "money"). */
const STOPWORDS = new Set(
  (
    "a an and are about any as at be by can do does did for from get give has have i in into is it its me " +
    "my of on or some something stuff that the their them these this those to want was what " +
    "which with you your anything things thing please show find looking how why when where who " +
    "we us our so just really very"
  ).split(" "),
);

export function tokenize(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

type Indexed = { id: string; order: number; fields: Record<Field, string[]>; title: string };

let index: Indexed[] | null = null;
function getIndex(): Indexed[] {
  if (index) return index;
  index = essays.map((e, order) => ({
    id: e.id,
    order,
    title: tokenize(e.title).join(" "),
    fields: {
      title: tokenize(e.title),
      topics: tokenize(e.topics.join(" ")),
      author: tokenize(e.author),
      publication: tokenize(e.publication),
      description: tokenize(e.description),
      format: tokenize(FORMAT_WORDS[e.format]),
    },
  }));
  return index;
}

const SUFFIXES = ["ations", "ation", "ities", "ity", "ings", "ing", "ics", "ies", "ied", "ed", "es", "ic", "al", "ly", "s", "y"];

/** A very light stemmer: "economy"/"economics" -> "econom", "stories" -> "stor". */
function stem(word: string): string {
  for (const suf of SUFFIXES) {
    if (word.endsWith(suf) && word.length - suf.length >= 4) return word.slice(0, -suf.length);
  }
  return word;
}

/** Strength of one query term against one token: exact 1, prefix 0.7, shared stem 0.6. */
function termMatch(term: string, token: string): number {
  if (token === term) return 1;
  if (term.length <= 2) return 0; // "ai", "x": exact only
  if (token.startsWith(term)) return 0.7; // "startup" -> "startups"
  const s = stem(term);
  if (s.length >= 3 && (stem(token) === s || (s !== term && token.startsWith(s)))) return 0.6;
  return 0;
}

export function localSearch(query: string): string[] {
  const all = tokenize(query);
  let terms = all.filter((t) => !STOPWORDS.has(t));
  if (terms.length === 0) terms = all; // a query made only of stopwords still searches
  if (terms.length === 0) return [];

  const phrase = all.join(" ");
  const scored: { id: string; order: number; score: number }[] = [];

  for (const doc of getIndex()) {
    let total = 0;
    let ok = true;
    for (const term of terms) {
      let best = 0;
      let fieldsHit = 0;
      for (const field of Object.keys(FIELD_WEIGHTS) as Field[]) {
        let m = 0;
        for (const tok of doc.fields[field]) {
          const s = termMatch(term, tok);
          if (s > m) m = s;
          if (m === 1) break;
        }
        if (m > 0) {
          fieldsHit++;
          best = Math.max(best, m * FIELD_WEIGHTS[field]);
        }
      }
      if (best === 0) {
        ok = false;
        break;
      }
      total += best + (fieldsHit - 1) * 0.5; // small bonus for matching in several fields
    }
    if (!ok) continue;
    if (phrase.length > 3 && doc.title.includes(phrase)) total += 6;
    scored.push({ id: doc.id, order: doc.order, score: total });
  }

  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.map((s) => s.id);
}
