import { z } from 'zod';

// Resume claim extracted from original text
export const ClaimSchema = z.object({
  id: z.string(),
  // groundClaims sets text to the verified raw_phrase, so the model need not repeat it.
  text: z.string().optional().default(''),
  // Any short label: a fact labelled "education" or "qualification" must never be
  // dropped (that silently turned listed degrees into gaps). Nothing branches on it.
  type: z.string().max(40).catch('fact'),
  raw_phrase: z.string(),
  confidence: z.number().min(0).max(1).optional().default(0.8),
});

// JD requirement extracted from job description
export const JDRequirementSchema = z.object({
  id: z.string(),
  text: z.string(),
  type: z.enum(['skill', 'responsibility', 'qualification', 'domain']),
  priority: z.enum(['must_have', 'nice_to_have']),
  keywords: z.array(z.string()).optional().default([]),
  esco_code: z.string().optional(),
});

// Semantic match between a claim and a requirement
export const ClaimMatchSchema = z.object({
  requirement_id: z.string(),
  claim_ids: z.array(z.string()),
  match_type: z.enum(['exact', 'semantic', 'unsupported']),
  confidence: z.number().min(0).max(1).optional().default(0.7),
  explanation: z.string().optional(),
});

// Full claim analysis output
export const ClaimAnalysisSchema = z.object({
  resumeClaims: z.array(ClaimSchema),
  jdRequirements: z.array(JDRequirementSchema),
  claimMatches: z.array(ClaimMatchSchema),
  unsupported_requirements: z.array(z.string()),
  claim_coverage: z.number().min(0).max(100),
});

// Validate and parse claim analysis JSON safely
export function validateClaimAnalysis(data) {
  try {
    return ClaimAnalysisSchema.parse(data);
  } catch (err) {
    console.error('Claim analysis validation error:', err.errors);
    return {
      resumeClaims: [],
      jdRequirements: [],
      claimMatches: [],
      unsupported_requirements: [],
      claim_coverage: 0,
    };
  }
}

export function validateClaims(data) {
  return parseValidItems(data, ClaimSchema);
}

export function validateRequirements(data) {
  return parseValidItems(data, JDRequirementSchema);
}

export function validateMatches(data) {
  return parseValidItems(data, ClaimMatchSchema);
}

function parseValidItems(data, schema) {
  if (!Array.isArray(data)) return [];
  return data.flatMap(item => {
    const result = schema.safeParse(item);
    return result.success ? [result.data] : [];
  });
}
