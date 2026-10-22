// Shared text matching for evidence and job terms. Quotes are compared as whole
// words, so "Java" never matches inside "JavaScript" or "SQL" inside "NoSQL".
// Curly quotes and dashes are folded, so a model that writes ' or - where the
// resume has ’ or – still matches the resume's own words.
export function normalizeText(value) {
  return String(value ?? '').normalize('NFKC')
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'").replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\s\u00a0]+/g, ' ').trim().toLowerCase();
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// True when the phrase appears in the text and neither end is glued to another
// letter or digit.
export function containsPhrase(text, phrase) {
  const needle = normalizeText(phrase);
  if (!needle) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}($|[^\\p{L}\\p{N}])`, 'u').test(normalizeText(text));
}

const STOP_WORDS = new Set(['and', 'the', 'for', 'with', 'from', 'into', 'onto', 'that', 'this', 'these', 'those', 'their', 'our', 'your', 'its',
  'was', 'were', 'are', 'been', 'has', 'have', 'had', 'via', 'per', 'all', 'any', 'each', 'other', 'more', 'most', 'over', 'than', 'then', 'also',
  'while', 'within', 'across', 'who', 'which', 'when', 'where']);

// A named tool, technology, product, standard or credential (Kubernetes, Excel,
// ISO 9001, C++, Node.js, AWS) as opposed to general wording (data quality,
// documentation). Named terms carry capitals, digits or symbols.
export function isNamedTerm(term) {
  return /[A-Z0-9+#/]|\.\p{L}/u.test(String(term ?? ''));
}

// Meaningful words (three or more letters, not filler words) with simple endings
// removed, for checking that an edited bullet still states a quoted fact.
export function contentWords(text) {
  return [...new Set(normalizeText(text).split(/[^\p{L}\p{N}+#]+/u).filter(word => word.length >= 3 && !STOP_WORDS.has(word))
    .map(word => (word.length > 4 ? word.replace(/(ing|ed|es|s)$/, '') : word)))];
}
