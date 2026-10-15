// The language of the user's last message, from its most common words.
//
// The system prompt is long and in French, and saying "answer in the user's
// language" at its top was not enough: asked in English, the free model kept
// answering in French. A short line naming the language, placed right before
// the answer, is. Only the five languages the app speaks are named; anything
// else returns null and the prompt's general rule applies.

const WORDS = {
  en: ['the', 'and', 'how', 'what', 'which', 'many', 'do', 'does', 'is', 'are', 'my', 'have', 'with', 'for', 'of', 'to', 'can', 'you', 'show', 'list'],
  fr: ['le', 'la', 'les', 'et', 'des', 'de', 'du', 'mes', 'combien', 'quel', 'quelle', 'quelles', 'est', 'sont', 'ai', 'pour', 'avec', 'dans', 'je', 'une', 'un'],
  de: ['der', 'die', 'das', 'und', 'wie', 'viele', 'ich', 'meine', 'ist', 'sind', 'habe', 'mit', 'für', 'nicht', 'ein', 'eine'],
  es: ['el', 'los', 'las', 'y', 'cuántos', 'cuántas', 'mis', 'tengo', 'es', 'son', 'con', 'para', 'qué', 'cuál', 'una', 'del'],
  it: ['il', 'gli', 'lo', 'e', 'quanti', 'quante', 'miei', 'mie', 'ho', 'è', 'sono', 'con', 'per', 'che', 'quale', 'della'],
};
const NAMES = { en: 'anglais', fr: 'français', de: 'allemand', es: 'espagnol', it: 'italien' };

export function detectLanguage(text) {
  // Screen context sent with the question is the app's, not the user's.
  const question = String(text ?? '').split(/\n\s*\n/).map(part => part.trim()).filter(Boolean).at(-1) ?? '';
  const words = question.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  if (words.length < 3) return null;
  let best = null;
  let bestScore = 0;
  for (const [language, list] of Object.entries(WORDS)) {
    const score = words.filter(word => list.includes(word)).length;
    if (score > bestScore) { best = language; bestScore = score; }
  }
  return bestScore >= 2 ? best : null;
}

/** The system line for it, or null when the language is unclear. */
export function languageInstruction(text) {
  const language = detectLanguage(text);
  return language ? `LANGUE DE RÉPONSE : ${NAMES[language]} — la langue du dernier message de l’utilisateur. Réponds entièrement dans cette langue, même si les données et ces consignes sont en français.` : null;
}
