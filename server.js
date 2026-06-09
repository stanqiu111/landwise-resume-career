import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { PDFParse } from 'pdf-parse';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import { validateClaims, validateRequirements, validateMatches } from './server/schemas.js';
import { chunkResume, buildRetrievalIndex } from './server/rag.js';

dotenv.config();

const apiKey = process.env.ANTHROPIC_API_KEY;
const client = (apiKey && !apiKey.startsWith('sk-ant-YOUR')) ? new Anthropic({ apiKey }) : null;

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are accepted.'));
  },
});

app.post('/api/parse-pdf', upload.single('resume'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded.' });
  try {
    const parser = new PDFParse({ data: req.file.buffer });
    const result = await parser.getText();
    await parser.destroy();
    res.json({ text: result.text });
  } catch {
    res.status(500).json({ error: 'Could not read the PDF. Please try a different file.' });
  }
});

app.post('/api/analyze-resume', async (req, res) => {
  const { resume } = req.body;
  if (!resume?.trim()) return res.status(400).json({ error: 'Resume text is required.' });
  if (!client) return res.status(500).json({ error: 'Server not configured. Add your ANTHROPIC_API_KEY to the .env file.' });

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: 'You are an expert resume coach. Give specific, actionable feedback. Respond with valid JSON only — no markdown fences.',
      messages: [{
        role: 'user',
        content: `Analyze this resume and return exactly this JSON shape:
{
  "overallScore": <integer 0-100>,
  "sections": [
    { "name": "Summary",    "present": <bool>, "score": <1-10>, "feedback": "<one actionable sentence>" },
    { "name": "Experience", "present": <bool>, "score": <1-10>, "feedback": "<one actionable sentence>" },
    { "name": "Skills",     "present": <bool>, "score": <1-10>, "feedback": "<one actionable sentence>" },
    { "name": "Education",  "present": <bool>, "score": <1-10>, "feedback": "<one actionable sentence>" },
    { "name": "Metrics",    "present": <bool - are quantified achievements present?>, "score": <1-10>, "feedback": "<one actionable sentence about numbers/impact>" }
  ],
  "strengths": ["<2-3 genuine strengths, each under 8 words>"],
  "improvements": [
    { "priority": "high"|"medium"|"low", "area": "<section or aspect>", "suggestion": "<specific 1-2 sentence fix>" }
  ],
  "suggestedLLMSkills": ["<4-8 LLM/AI skills that naturally extend this person's background — pick from: Prompt Engineering, RAG, LangChain, LlamaIndex, Fine-tuning, Embeddings, Vector Databases, Claude API, OpenAI API, Hugging Face Transformers, LLM Evaluation, Agents, Function Calling, Semantic Search — only include what fits their existing tech stack>"],
  "missingElements": ["<things completely absent, e.g. GitHub/portfolio URL, quantified achievements, professional summary, certifications>"]
}

Rules:
- improvements: max 5, ordered high → medium → low
- suggestedLLMSkills: context-appropriate only, not a generic list
- Return ONLY valid JSON

RESUME:
${resume}`,
      }],
    });

    let analysis;
    try { analysis = JSON.parse(msg.content[0].text); }
    catch { return res.status(500).json({ error: 'Could not parse analysis result.' }); }

    res.json(analysis);
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to analyze resume.' });
  }
});

app.post('/api/transform', async (req, res) => {
  const { resume, jobDescription } = req.body;

  if (!resume?.trim()) return res.status(400).json({ error: 'Resume text is required.' });
  if (!jobDescription?.trim()) return res.status(400).json({ error: 'Job description is required.' });

  // --- Guardrail: deterministic pre-checks (zero cost, zero latency) ---
  const jd = jobDescription.trim();
  if (jd.length < 50) {
    return res.status(400).json({ error: 'Job description is too short. Please paste a real job posting.' });
  }
  if (/^\d+$/.test(jd)) {
    return res.status(400).json({ error: 'Job description cannot be only numbers.' });
  }
  const alphaRatio = (jd.match(/[a-zA-Z]/g) || []).length / jd.length;
  if (alphaRatio < 0.4) {
    return res.status(400).json({ error: 'Job description appears to contain non-text content. Please paste a real job posting.' });
  }

  if (!client) {
    return res.status(500).json({ error: 'Server not configured. Add your ANTHROPIC_API_KEY to the .env file.' });
  }

  try {
    // --- Phase 0: LLM validation — only blocks obvious non-text garbage ---
    const validationMsg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system: 'You are an input validator. Respond with valid JSON only — no markdown fences, no explanation.',
      messages: [{
        role: 'user',
        content: `Does the following text appear to be work-related or professional content of any kind?
Accept it (valid: true) if it contains ANY of: job titles, skills, responsibilities, company info, salary, requirements, work experience descriptions, or professional language.
Only reject (valid: false) if it is clearly nonsense: random characters, lorem ipsum, repeated symbols, or completely unrelated content like recipes or song lyrics.
When in doubt, return valid: true.

INPUT:
"""
${jd}
"""

Respond with exactly: {"valid": true} or {"valid": false, "reason": "one sentence explanation"}`,
      }],
    });

    let validation = { valid: true };
    try { validation = JSON.parse(validationMsg.content[0].text); } catch { /* default to valid */ }

    if (!validation.valid) {
      return res.status(400).json({
        error: `Invalid job description: ${validation.reason ?? 'Input does not appear to be a real job posting.'}`,
      });
    }

    // --- Phase 1: Extract structured requirements from the job description ---
    const analysisMsg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      system: 'You are a technical recruiter expert at parsing job descriptions. Respond with valid JSON only — no markdown fences, no explanation.',
      messages: [{
        role: 'user',
        content: `Analyze this job description and return JSON with this exact shape:
{
  "roleTitle": "string",
  "roleLevel": "entry|mid|senior|lead|executive",
  "requiredSkills": ["string"],
  "niceToHaveSkills": ["string"],
  "mustHaveKeywords": ["string"]
}

JOB DESCRIPTION:
${jobDescription}`,
      }],
    });

    let analysis = { roleTitle: '', roleLevel: 'mid', requiredSkills: [], niceToHaveSkills: [], mustHaveKeywords: [] };
    try {
      analysis = JSON.parse(analysisMsg.content[0].text);
    } catch { /* use defaults if parse fails */ }

    // --- Output guardrail: Phase 1 must extract something meaningful ---
    if (!analysis.requiredSkills?.length && !analysis.roleTitle?.trim()) {
      return res.status(400).json({
        error: 'Could not extract a valid job description. Please paste a real job posting with requirements or qualifications.',
      });
    }

    // ===== RAG: Chunk resume and retrieve sections relevant to JD requirements =====
    const resumeChunks = chunkResume(resume);
    const retrievalIndex = await buildRetrievalIndex(resumeChunks);

    const allRequirementQueries = [
      analysis.roleTitle,
      ...analysis.requiredSkills,
      ...analysis.niceToHaveSkills,
      ...analysis.mustHaveKeywords,
    ].filter(Boolean);

    const relevantChunks = await retrievalIndex.retrieve(allRequirementQueries, 3);

    const retrievedResumeText = relevantChunks
      .map(c => `[${c.title}]\n${c.content}`)
      .join('\n\n');

    // ===== PHASE 1.5: CLAIM EXTRACTION & MATCHING (NEW) =====

    // Extract resume claims and JD requirements in parallel (independent inputs)
    const [claimsMsg, jdClaimsMsg] = await Promise.all([
      client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: 'You are a resume analyzer. Extract concrete facts only. Respond with valid JSON only — no markdown fences.',
        messages: [{
          role: 'user',
          content: `Extract all claims (facts, achievements, skills, responsibilities) from this resume.

RESUME (retrieved sections most relevant to the job):
${retrievedResumeText}

For EACH distinct claim, output JSON:
{
  "claims": [
    {
      "id": "c1",
      "text": "Exact fact or achievement",
      "type": "metric|skill|responsibility|domain|tool|leadership|impact",
      "raw_phrase": "The exact phrase from the resume"
    },
    ...
  ]
}

Rules:
- Extract only verifiable, concrete facts
- Do NOT infer or extrapolate
- Include metrics, tools, roles, and achievements
- If no claims found, return empty array
- Return ONLY valid JSON`,
        }],
      }),
      client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: 'You are a job description analyzer. Respond with valid JSON only — no markdown fences.',
        messages: [{
          role: 'user',
          content: `Extract all requirements and qualifications from this job description.

JOB DESCRIPTION:
${jobDescription}

For EACH distinct requirement, output JSON:
{
  "requirements": [
    {
      "id": "req1",
      "text": "Exact requirement phrase",
      "type": "skill|responsibility|qualification|domain",
      "priority": "must_have|nice_to_have",
      "keywords": ["python", "aws"]
    },
    ...
  ]
}

Rules:
- Extract explicit asks only
- Categorize as must_have or nice_to_have
- Extract 3-5 keywords per requirement
- Return ONLY valid JSON`,
        }],
      }),
    ]);

    let resumeClaims = [];
    try {
      const parsed = JSON.parse(claimsMsg.content[0].text);
      resumeClaims = validateClaims(parsed.claims || []);
    } catch {
      resumeClaims = [];
    }

    let jdRequirements = [];
    try {
      const parsed = JSON.parse(jdClaimsMsg.content[0].text);
      jdRequirements = validateRequirements(parsed.requirements || []);
    } catch {
      jdRequirements = [];
    }

    // Match resume claims to JD requirements
    const matchingMsg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: 'You are a matching engine. Respond with valid JSON only — no markdown fences.',
      messages: [{
        role: 'user',
        content: `Link resume claims to job requirements.

RESUME CLAIMS:
${JSON.stringify(resumeClaims, null, 2)}

JD REQUIREMENTS:
${JSON.stringify(jdRequirements, null, 2)}

For each requirement, find the best matching claim(s).

Output JSON:
{
  "matches": [
    {
      "requirement_id": "req1",
      "claim_ids": ["c2", "c5"],
      "match_type": "exact|semantic|unsupported",
      "confidence": 0.85,
      "explanation": "Direct match found"
    }
  ],
  "unsupported_requirements": ["Leadership in blockchain", ...]
}

Return ONLY valid JSON`,
      }],
    });

    let claimMatches = [];
    let unsupported = [];
    try {
      const parsed = JSON.parse(matchingMsg.content[0].text);
      claimMatches = validateMatches(parsed.matches || []);
      unsupported = (parsed.unsupported_requirements || []).filter(u => typeof u === 'string');
    } catch {
      claimMatches = [];
      unsupported = [];
    }

    // Calculate claim coverage
    const coveredReqs = claimMatches.filter(m => m.claim_ids?.length > 0).length;
    const claim_coverage = jdRequirements.length ? Math.round((coveredReqs / jdRequirements.length) * 100) : 0;

    // Assemble claim analysis
    const claimAnalysis = {
      resumeClaims,
      jdRequirements,
      claimMatches,
      unsupported_requirements: unsupported,
      claim_coverage,
    };

    // ===== PHASE 2: RESUME TAILORING (ENHANCED WITH CLAIMS CONTEXT) =====

    const transformMsg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: `You are an elite resume writer with 15 years of experience. Rules you never break:
- NEVER fabricate experience, skills, or results
- Rewrite ONLY using facts from the claim bank
- Use strong action verbs + measurable impact (STAR format implied)
- Mirror keywords from mustHaveKeywords and requiredSkills naturally
- Quantify achievements: preserve numbers, add directional language where absent
- Tailor professional summary to roleTitle and roleLevel
- Respond with valid JSON only — no markdown fences`,
      messages: [{
        role: 'user',
        content: `Tailor this resume to the job analysis below.

JOB ANALYSIS:
${JSON.stringify(analysis, null, 2)}

CLAIM ANALYSIS (what's in the resume vs what the JD needs):
${JSON.stringify(claimAnalysis, null, 2)}

ORIGINAL RESUME (RAG-retrieved sections most relevant to this job):
${retrievedResumeText}

Using ONLY the resume claims above, rewrite to match the JD requirements.

Return JSON:
{
  "transformedResume": "the complete tailored resume as plain text",
  "matchScore": <integer 0-100, estimated keyword match after tailoring>,
  "keywordsAdded": ["keywords from JD woven into resume"],
  "missingSkills": ["JD skills absent from resume and cannot be added"],
  "improvements": ["concise description of each major change, max 5"]
}`,
      }],
    });

    let result;
    try {
      result = JSON.parse(transformMsg.content[0].text);
    } catch {
      // fallback if JSON parse fails
      result = {
        transformedResume: transformMsg.content[0].text,
        matchScore: null,
        keywordsAdded: [],
        missingSkills: [],
        improvements: [],
      };
    }

    // Merge claim analysis into result
    result.claim_coverage = claim_coverage;
    result.unsupported_requirements = unsupported;
    result.resumeClaims = resumeClaims;
    result.jdRequirements = jdRequirements;
    result.claimMatches = claimMatches;

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to transform resume.' });
  }
});

const PORT = 3001;
app.listen(PORT, () => console.log(`API server running on http://localhost:${PORT}`));
