import { z } from 'zod';

const TailoredResultSchema = z.object({
  transformedResume: z.string().trim().min(80),
  matchScore: z.number().int().min(0).max(100).nullable().optional(),
  keywordsAdded: z.array(z.string()).default([]),
  missingSkills: z.array(z.string()).default([]),
  improvements: z.array(z.string()).default([]),
});

const normalize = text => text.normalize('NFKC').replace(/[\s\u00a0]+/g, ' ').trim().toLowerCase();

// A model-produced citation is usable only when its quoted evidence is in the source.
export function groundClaims(claims, originalResume) {
  const source = normalize(originalResume);
  const seen = new Set();
  return claims.filter(claim => {
    const phrase = normalize(claim.raw_phrase);
    if (!phrase || !source.includes(phrase) || seen.has(claim.id)) return false;
    seen.add(claim.id);
    return true;
  }).map(claim => ({ ...claim, text: claim.raw_phrase }));
}

export function reconcileMatches(matches, requirements, claims) {
  const requirementIds = new Set(requirements.map(item => item.id));
  const claimIds = new Set(claims.map(item => item.id));
  const seen = new Set();
  return matches.filter(match => {
    if (!requirementIds.has(match.requirement_id) || seen.has(match.requirement_id)) return false;
    seen.add(match.requirement_id);
    return true;
  }).map(match => {
    const validIds = [...new Set(match.claim_ids.filter(id => claimIds.has(id)))];
    return {
      ...match,
      claim_ids: match.match_type === 'unsupported' ? [] : validIds,
      match_type: validIds.length ? match.match_type : 'unsupported',
    };
  });
}

export function summarizeCoverage(requirements, matches) {
  const covered = new Set(matches.filter(m => m.claim_ids.length).map(m => m.requirement_id));
  return {
    claim_coverage: requirements.length ? Math.round(100 * covered.size / requirements.length) : 0,
    unsupported_requirements: requirements.filter(r => !covered.has(r.id)).map(r => r.text),
  };
}

export function parseTailoredResult(text, originalResume) {
  const parsed = TailoredResultSchema.parse(JSON.parse(text));
  const output = parsed.transformedResume;
  const emails = originalResume.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g) || [];
  if (emails.some(email => !output.toLowerCase().includes(email.toLowerCase()))) {
    throw new Error('Tailored resume omitted source contact information.');
  }
  if (/^education\s*:?\s*$/im.test(originalResume) && !/^education\s*:?\s*$/im.test(output)) {
    throw new Error('Tailored resume omitted the education section.');
  }
  const sourceNumbers = new Set(originalResume.match(/\d+(?:[.,]\d+)?[%+]?/g) || []);
  const newNumbers = (output.match(/\d+(?:[.,]\d+)?[%+]?/g) || []).filter(number => !sourceNumbers.has(number));
  if (newNumbers.length) throw new Error('Tailored resume added a number not present in the source.');
  return parsed;
}
