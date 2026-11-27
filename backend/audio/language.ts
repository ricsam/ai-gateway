/**
 * Languages of transcripts. Clients name the spoken language with an ISO 639-1
 * code; verbose_json and subtitle JSON report it by its English name, as
 * OpenAI does ("english"). Without a code, a transcript's language is guessed
 * from its most common words, for the languages the Voxtral models know best
 * and a few more.
 */
const names = new Intl.DisplayNames(["en"], { type: "language" });

/** The English name of an ISO 639 language code ("de" -> "German"), or undefined. */
export function languageName(code: string): string | undefined {
  try {
    const name = names.of(code);
    return name && name.toLowerCase() !== code.toLowerCase() ? name : undefined;
  } catch {
    return undefined;
  }
}

/** The primary language of a BCP 47 or ISO 639 code ("en-US" -> "en"), if it is one. */
export function normalizeLanguageCode(value: string): string | undefined {
  const match = /^([a-z]{2,3})(?:[-_][a-z0-9]{1,8})*$/i.exec(value.trim());
  if (!match) return undefined;
  const code = match[1]!.toLowerCase();
  return languageName(code) ? code : undefined;
}

const STOPWORDS: Record<string, readonly string[]> = {
  en: ["the", "and", "is", "of", "to", "in", "that", "it", "you", "for", "with", "this", "are", "was", "we"],
  de: ["der", "die", "und", "ist", "das", "nicht", "ich", "sie", "es", "mit", "den", "ein", "wir", "auf", "zu"],
  fr: ["le", "la", "les", "et", "est", "des", "une", "un", "que", "pas", "nous", "vous", "pour", "dans", "je"],
  es: ["el", "la", "los", "las", "y", "que", "es", "en", "un", "una", "por", "con", "para", "no", "se"],
  it: ["il", "la", "che", "è", "di", "e", "non", "un", "una", "per", "con", "sono", "gli", "lo", "si"],
  pt: ["o", "a", "os", "as", "que", "é", "de", "não", "um", "uma", "para", "com", "em", "do", "da"],
  nl: ["de", "het", "en", "een", "is", "dat", "niet", "van", "ik", "je", "we", "met", "op", "zijn", "voor"],
  sv: ["och", "att", "det", "är", "en", "som", "på", "för", "med", "inte", "jag", "vi", "har", "till", "den"],
  da: ["og", "at", "det", "er", "en", "som", "på", "for", "med", "ikke", "jeg", "vi", "har", "til", "den"],
  no: ["og", "at", "det", "er", "en", "som", "på", "for", "med", "ikke", "jeg", "vi", "har", "til", "ikkje"],
  fi: ["ja", "on", "ei", "se", "että", "oli", "hän", "kun", "mutta", "ole", "me", "te", "tämä", "niin", "jos"],
  pl: ["i", "w", "nie", "na", "się", "to", "że", "z", "jest", "do", "co", "jak", "ale", "tak", "jestem"],
};

/** The ISO 639-1 code of the transcript's language, when its words make it clear. */
export function guessLanguage(text: string): string | undefined {
  if (/\p{Script=Devanagari}/u.test(text)) return "hi";
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 3) return undefined;
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const scores = Object.entries(STOPWORDS)
    .map(([code, list]) => [code, list.reduce((sum, word) => sum + (counts.get(word) ?? 0), 0)] as const)
    .sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  // Clear only when common words are common, and one language's clearly more so.
  if (!best || best[1] < Math.max(2, words.length * 0.08)) return undefined;
  if (second && second[1] >= best[1] * 0.8) return undefined;
  return best[0];
}
