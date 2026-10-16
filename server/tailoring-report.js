const normalized = value => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

export function buildTailoringReport(requirements, matches, claims, draft, feedback = []) {
  const items = requirements.map(requirement => {
    const match = matches.find(item => item.requirement_id === requirement.id);
    const evidence = (match?.claim_ids || []).flatMap(id => claims.filter(claim => claim.id === id));
    const note = feedback.find(item => item?.requirement_id === requirement.id);
    const quote = typeof note?.resumeQuote === 'string' ? note.resumeQuote.trim() : '';
    // Placement is accepted only when both original evidence and an actual draft
    // quote exist. A model's unsupported "included" label is never sufficient.
    const resumeQuote = evidence.length && quote && normalized(draft).includes(normalized(quote)) ? quote : evidence.find(claim => normalized(draft).includes(normalized(claim.raw_phrase)))?.raw_phrase || '';
    const status = !evidence.length ? 'learn' : match.match_type === 'exact' && resumeQuote ? 'included' : 'expand';
    const fallback = status === 'learn'
      ? `Check what ${requirement.text} involves. If it is new to you, practise it in a small project and keep evidence before adding it to your resume.`
      : `Prepare a concrete example for ${requirement.text}, explain your contribution and outcome, and add detail only if it is accurate.`;
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
