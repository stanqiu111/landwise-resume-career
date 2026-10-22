import { containsPhrase, contentWords, isNamedTerm, normalizeText, numbersDiffer } from './text-match.js';

const wordCount = text => text.replace(/^\s*[-•*]\s+/, '').trim().split(/\s+/).filter(Boolean).length;
const sameBullet = (a, b) => {
  const plain = text => normalizeText(text.replace(/^\s*[-•*]\s+/, '')).replace(/[.;!]+$/, '');
  return plain(a) === plain(b);
};

// An edit that turns its bullet into another bullet: an exact copy of a
// different bullet, or one made at least 80% of another bullet's words while
// keeping less than half of its own. Bullets that were already identical are
// not counted as copies of each other.
export function copiesAnotherBullet(source, replacement, bullets) {
  const words = contentWords(replacement);
  const own = contentWords(source.text);
  const kept = own.filter(word => words.includes(word)).length;
  return bullets.some(other => {
    if (other.id === source.id || sameBullet(other.text, source.text)) return false;
    if (sameBullet(other.text, replacement)) return true;
    const theirs = new Set(contentWords(other.text));
    return words.length >= 3 && words.filter(word => theirs.has(word)).length >= 0.8 * words.length && kept < 0.5 * own.length;
  });
}

// Keep every source entry and its order. The model can only replace selected
// existing bullets; it cannot regenerate or silently drop entire experiences.
export function editableResumeLines(resume) {
  let section = '';
  let context = '';
  return resume.split(/\r?\n/).flatMap((text, index) => {
    if (/^[A-Z][A-Z /&]{2,}:?$/.test(text.trim())) section = text.trim();
    if (!/^\s*[-•*]\s+/.test(text)) { if (text.trim()) context = text.trim(); return []; }
    return [{ id: `line-${index}`, text, section, context }];
  });
}

export function applyResumeEdits(resume, edits = []) {
  if (!Array.isArray(edits)) throw new Error('Invalid resume edits.');
  const lines = resume.split(/\r?\n/);
  const editable = editableResumeLines(resume);
  if (edits.length > Math.max(1, Math.ceil(editable.length * 0.35))) throw new Error('Too many resume edits.');
  const seen = new Set();
  for (const edit of edits) {
    const source = editable.find(line => line.id === edit.lineId);
    if (!source || seen.has(edit.lineId) || typeof edit.replacement !== 'string') throw new Error('Invalid edit target.');
    const replacement = edit.replacement.trim().replace(/^[-•*]\s+/, '');
    if (!replacement || /[\r\n]/.test(replacement)) throw new Error('An edit must preserve one existing bullet.');
    // Keep edits small and prevent an oversized new narrative under a real role.
    if (wordCount(replacement) > wordCount(source.text) + 8) throw new Error('An edit expands the original experience too far.');
    if (copiesAnotherBullet(source, replacement, editable)) throw new Error('An edit copies another bullet.');
    if (numbersDiffer(source.text, replacement)) throw new Error('An edit changes source metrics.');
    seen.add(edit.lineId);
    lines[Number(edit.lineId.slice(5))] = source.text.match(/^\s*[-•*]\s+/)[0] + replacement;
  }
  return lines.join('\n');
}

export function rejectUnsupportedAdditions(original, draft, requirements, matches) {
  const contains = (text, term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
  };
  for (const requirement of requirements) {
    const match = matches.find(item => item.requirement_id === requirement.id);
    if (match?.claim_ids.length) continue;
    for (const keyword of requirement.keywords || []) {
      if (keyword.trim().length > 1 && !contains(original, keyword) && contains(draft, keyword)) {
        throw new Error('An edit adds an unsupported job keyword.');
      }
    }
  }
}

// Check each edit on its own, so one invalid edit is dropped instead of failing
// the whole draft. Returns the edits that pass and, for the others, a reason code
// only (never text). Besides the rules applyResumeEdits enforces (including no
// changed number, in digits or words, and no copy of another bullet), an edit may
// not remove an email or link from its bullet, may not add a key term of a
// requirement the resume does not support, and may not add a named tool,
// technology, standard or credential of a requirement with only related evidence
// to a bullet that did not already name it (general wording is allowed).
// With claims, a job term newly added to a bullet must also belong to a
// requirement whose verbatim evidence is in that bullet, so a term supported
// elsewhere (a skills line, another role) is never attached to unrelated work.
// Edits are kept in the order given until the edit budget is used.
export function screenResumeEdits(resume, edits, requirements = [], matches = [], claims = []) {
  if (!Array.isArray(edits)) throw new Error('Invalid resume edits.');
  const editable = editableResumeLines(resume);
  const limit = Math.max(1, Math.ceil(editable.length * 0.35));
  const contacts = text => (text.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\/[^\s)]+|www\.[^\s)]+/gi) || []).map(item => item.toLowerCase());
  const matchOf = requirement => matches.find(item => item.requirement_id === requirement.id);
  const termsOf = list => list.flatMap(requirement => requirement.keywords || []).filter(term => typeof term === 'string' && term.trim().length > 1);
  const unsupportedTerms = termsOf(requirements.filter(requirement => !matchOf(requirement)?.claim_ids.length))
    .filter(term => !containsPhrase(resume, term));
  const directTerms = new Set(termsOf(requirements.filter(requirement => matchOf(requirement)?.claim_ids.length && matchOf(requirement).match_type === 'exact'))
    .map(term => term.toLowerCase()));
  const relatedTerms = termsOf(requirements.filter(requirement => matchOf(requirement)?.claim_ids.length && matchOf(requirement).match_type !== 'exact'))
    .filter(term => isNamedTerm(term) && !directTerms.has(term.toLowerCase()));
  const claimById = new Map(claims.map(claim => [claim.id, claim]));
  const direct = requirements.filter(requirement => matchOf(requirement)?.claim_ids.length && matchOf(requirement).match_type === 'exact')
    .map(requirement => ({ terms: termsOf([requirement]), evidence: matchOf(requirement).claim_ids.map(id => claimById.get(id)?.raw_phrase).filter(Boolean) }));
  const misplaced = (sourceText, replacement) => claims.length > 0 && direct.some(({ terms }) => terms.some(term =>
    containsPhrase(replacement, term) && !containsPhrase(sourceText, term)
    && !direct.some(other => other.terms.some(t => t.toLowerCase() === term.toLowerCase()) && other.evidence.some(phrase => containsPhrase(sourceText, phrase)))));
  const kept = [];
  const dropped = [];
  const seen = new Set();
  for (const edit of edits) {
    const source = editable.find(line => line.id === edit?.lineId);
    const replacement = typeof edit?.replacement === 'string' ? edit.replacement.trim().replace(/^[-•*]\s+/, '') : '';
    const reason = !source || typeof edit?.replacement !== 'string' ? 'invalid_target'
      : seen.has(edit.lineId) ? 'duplicate_target'
        : !replacement || /[\r\n]/.test(replacement) ? 'multiline_or_empty'
          : wordCount(replacement) > wordCount(source.text) + 8 ? 'expansion'
            : copiesAnotherBullet(source, replacement, editable) ? 'copied_bullet'
              : numbersDiffer(source.text, replacement) ? 'metrics_changed'
                : contacts(source.text).some(contact => !replacement.toLowerCase().includes(contact)) ? 'contact_removed'
                  : unsupportedTerms.some(term => containsPhrase(replacement, term)) ? 'unsupported_keyword'
                    : relatedTerms.some(term => containsPhrase(replacement, term) && !containsPhrase(source.text, term)) ? 'semantic_keyword'
                      : misplaced(source.text, replacement) ? 'misplaced_keyword'
                        : kept.length >= limit ? 'over_limit' : null;
    if (reason) dropped.push({ lineId: typeof edit?.lineId === 'string' ? edit.lineId : null, reason });
    else { kept.push(edit); seen.add(edit.lineId); }
  }
  return { kept, dropped };
}
