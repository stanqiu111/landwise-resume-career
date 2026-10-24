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

const SMALL_NUMBERS = Object.fromEntries(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'].map((word, value) => [word, value]));
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES = { thousand: 1e3, million: 1e6, billion: 1e9 };
const ORDINALS = Object.fromEntries(['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth']
  .map((word, index) => [word, `#${index + 1}`]));
const MULTIPLES = { half: 'x0.5', halved: 'x0.5', halving: 'x0.5', twice: 'x2', double: 'x2', doubled: 'x2', doubles: 'x2', doubling: 'x2',
  triple: 'x3', tripled: 'x3', triples: 'x3', tripling: 'x3', quadruple: 'x4', quadrupled: 'x4' };
const VAGUE_AMOUNTS = new Set(['dozens', 'hundreds', 'thousands', 'millions', 'billions']);
const MAGNITUDES = { k: 'k', thousand: 'k', m: 'm', mm: 'm', million: 'm', b: 'b', bn: 'b', billion: 'b' };
const unitValue = word => SMALL_NUMBERS[word] ?? TENS[word];

// Numbers in digits ("40+", "30%", "$1.5M", "2x", "1st") and in words ("three",
// "seventy-five", "a dozen", "doubled", "hundreds of", "second place"), each as a
// comparable token: "three" and "3" give the same token, "$1.5M" and "$1.5B" do
// not. Each line is read on its own, and "one-on-one", "one another",
// "double-check" or "first aid" are phrases, not numbers.
export function numberTokens(text) {
  return String(text ?? '').split(/\r?\n/).flatMap(line => {
    const tokens = [];
    const rest = normalizeText(line).replace(/\bone[- ]on[- ]one\b|\bone another\b|\bdouble[- ]check\w*|\bfirst[- ](?:aid|responders?|hand)\b/g, ' , ')
      .replace(/(\d+(?:[.,]\d+)*)(?:(st|nd|rd|th)\b|(x)\b|(k|mm|m|bn|b)\b|\s?(thousand|million|billion)\b)?(\s?(?:%|percent\b|per cent\b)|\+)?/g,
        (_match, digits, ordinal, times, letter, scale, suffix) => {
          const base = ordinal ? `#${digits}` : times ? `x${digits}` : `${digits}${MAGNITUDES[letter || scale] || ''}`;
          tokens.push(base + (suffix ? (suffix.trim() === '+' ? '+' : '%') : ''));
          return ' , ';
        });
    const words = rest.match(/[a-z]+|[^a-z\s-]/g) || [];
    let total = 0;
    let current = 0;
    let open = false;
    const close = (suffix = '') => {
      if (open) tokens.push(`${total + current}${suffix}`);
      total = 0; current = 0; open = false;
    };
    words.forEach((word, index) => {
      const next = words[index + 1];
      if (unitValue(word) !== undefined) {
        const value = unitValue(word);
        // "twenty five" and "one hundred five" are one number; "two three" is two.
        const joins = current % 100 === 0 || (current % 100 >= 20 && current % 10 === 0 && value < 10);
        if (open && !joins) close();
        current += value;
        open = true;
      } else if (word === 'hundred' || word === 'dozen') {
        current = (current || 1) * (word === 'hundred' ? 100 : 12);
        open = true;
      } else if (SCALES[word]) {
        total += (current || 1) * SCALES[word];
        current = 0;
        open = true;
      } else if (word === 'and' && open && unitValue(next) !== undefined) {
        // "one hundred and five" continues the number.
      } else if (open && (word === 'percent' || (word === 'per' && next === 'cent'))) {
        close('%');
      } else {
        close();
        if (ORDINALS[word]) tokens.push(ORDINALS[word]);
        else if (MULTIPLES[word]) tokens.push(MULTIPLES[word]);
        else if (VAGUE_AMOUNTS.has(word)) tokens.push(word);
      }
    });
    close();
    return tokens;
  });
}

// True when the two texts do not state the same set of numbers.
export function numbersDiffer(before, after) {
  const was = new Set(numberTokens(before));
  const now = new Set(numberTokens(after));
  return was.size !== now.size || [...was].some(token => !now.has(token));
}
