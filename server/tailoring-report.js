import { containsPhrase, contentWords } from './text-match.js';

// Edits keep every line in place, so comparing the original and the draft line by
// line finds each edited bullet and its new text. Both sides get the same line
// endings and trimming (PDF text often ends with blank lines; the draft is trimmed).
function editedLines(original, draft) {
  if (typeof original !== 'string') return [];
  const lines = text => text.replace(/\r\n?/g, '\n').trim().split('\n');
  const before = lines(original);
  const after = lines(draft);
  if (before.length !== after.length) return [];
  return before.flatMap((line, index) => line !== after[index] ? [{ original: line, revised: after[index].replace(/^\s*[-•*]\s+/, '') }] : []);
}

export function buildTailoringReport(requirements, matches, claims, draft, feedback = [], original = null) {
  const changes = editedLines(original, draft);
  // An edited evidence bullet still proves a requirement only if it still states
  // the quoted fact: it keeps every meaningful word of the quote, or it names the
  // requirement's own term and keeps at least 70% of them (the job's word for
  // what the bullet already showed). An edit that deleted the fact never counts.
  const editedLine = (claim, requirement) => {
    const words = contentWords(claim.raw_phrase);
    const revised = changes.find(change => containsPhrase(change.original, claim.raw_phrase))?.revised;
    if (!revised || !words.length) return '';
    const kept = new Set(contentWords(revised));
    const share = words.filter(word => kept.has(word)).length / words.length;
    const terms = requirement.keywords?.length ? requirement.keywords : [requirement.text];
    return share === 1 || (share >= 0.7 && terms.some(term => containsPhrase(revised, term))) ? revised : '';
  };
  const items = requirements.map(requirement => {
    const match = matches.find(item => item.requirement_id === requirement.id);
    const evidence = (match?.claim_ids || []).flatMap(id => claims.filter(claim => claim.id === id));
    const note = feedback.find(item => item?.requirement_id === requirement.id);
    const quote = typeof note?.resumeQuote === 'string' ? note.resumeQuote.trim() : '';
    // Placement is accepted only when both original evidence and an actual draft
    // quote exist. A model's unsupported "included" label is never sufficient.
    const resumeQuote = evidence.length && quote && containsPhrase(draft, quote) ? quote
      : evidence.find(claim => containsPhrase(draft, claim.raw_phrase))?.raw_phrase || evidence.map(claim => editedLine(claim, requirement)).find(Boolean) || '';
    const status = !evidence.length ? 'learn' : match.match_type === 'exact' && resumeQuote ? 'included' : 'expand';
    // Used only when the writer gave no next step. A qualification (degree,
    // licence, work permit) is checked, not "practised".
    const fallback = status !== 'learn'
      ? `Prepare a concrete example for ${requirement.text}, explain your contribution and outcome, and add detail only if it is accurate.`
      : requirement.type === 'qualification'
        ? `Check whether you meet this requirement: ${requirement.text}. If you do, state it clearly on your resume; if not, ask the employer whether it is essential.`
        : requirement.type === 'responsibility' || requirement.type === 'domain'
          ? `Look for a past example of ${requirement.text}, including school, volunteer or project work. If you have none yet, plan how to build that experience before claiming it.`
          : `Check what ${requirement.text} involves. If it is new to you, practise it in a small project and keep evidence before adding it to your resume.`;
    return { id: requirement.id, requirement: requirement.text, priority: requirement.priority, status,
      evidence: evidence.map(claim => claim.raw_phrase), resumeQuote,
      explanation: match?.explanation || (evidence.length ? 'Related experience exists in your original resume.' : 'No supporting evidence was found in the original resume.'),
      nextStep: typeof note?.nextStep === 'string' && note.nextStep.trim() ? note.nextStep.trim() : fallback };
  });
  const total = requirements.reduce((sum, r) => sum + (r.priority === 'must_have' ? 2 : 1), 0);
  const earned = requirements.reduce((sum, r) => {
    const m = matches.find(item => item.requirement_id === r.id);
    return sum + (r.priority === 'must_have' ? 2 : 1) * (!m?.claim_ids.length ? 0 : m.match_type === 'exact' ? 1 : m.match_type === 'semantic' ? 0.5 : 0);
  }, 0);
  return { score: total ? Math.round(100 * earned / total) : 0,
    scoreExplanation: 'Source-evidence estimate: must-have requirements count twice. Direct evidence earns full credit, related evidence half, and missing evidence zero. This is not an ATS score or a hiring prediction.', items };
}
