import test from 'node:test';
import assert from 'node:assert/strict';
import { groundClaims, reconcileMatches, summarizeCoverage, parseTailoredResult } from '../server/resume-quality.js';
import { parseResumeLines } from '../src/resumeDocument.js';
import { tailoringUserPrompt, TAILORING_SYSTEM_PROMPT } from '../server/prompts.js';
import { validateClaims } from '../server/schemas.js';

const resume = `Alex Rivera
alex@example.com
EXPERIENCE
Engineer | Northstar | 2021–2024
- Built React dashboards for operations.
- Reduced report time by 30%.
EDUCATION
Bachelor of Science | Western University`;

test('only source-quoted claims can enter the claim bank', () => {
  const claims = [
    { id: 'c1', raw_phrase: 'Built React dashboards for operations.' },
    { id: 'c2', raw_phrase: 'Led a team of 50 engineers' },
    { id: 'c1', raw_phrase: 'Reduced report time by 30%.' },
  ];
  const grounded = groundClaims(claims, resume);
  assert.deepEqual(grounded.map(c => c.id), ['c1']);
  assert.equal(grounded[0].text, grounded[0].raw_phrase);
});

test('one malformed extracted claim does not discard valid claims', () => {
  const valid = { id: 'c1', text: 'Built dashboards', type: 'skill', raw_phrase: 'Built React dashboards for operations.' };
  assert.deepEqual(validateClaims([valid, { id: 'c2' }]).map(c => c.id), ['c1']);
});

test('coverage uses existing requirement and claim IDs only', () => {
  const requirements = [{ id: 'r1', text: 'React' }, { id: 'r2', text: 'AWS' }];
  const claims = [{ id: 'c1' }];
  const matches = reconcileMatches([
    { requirement_id: 'r1', claim_ids: ['c1', 'made-up'], match_type: 'exact' },
    { requirement_id: 'r2', claim_ids: ['made-up'], match_type: 'semantic' },
    { requirement_id: 'r3', claim_ids: ['c1'], match_type: 'exact' },
  ], requirements, claims);
  assert.deepEqual(matches.map(m => m.claim_ids), [['c1'], []]);
  assert.deepEqual(summarizeCoverage(requirements, matches), {
    claim_coverage: 50,
    unsupported_requirements: ['AWS'],
  });
});

test('incomplete tailored drafts are rejected', () => {
  const good = {
    transformedResume: `Alex Rivera\nalex@example.com\nEXPERIENCE\n- Built React dashboards for operations.\nEDUCATION\nBachelor of Science | Western University`,
    matchScore: null,
  };
  assert.equal(parseTailoredResult(JSON.stringify(good), resume).transformedResume, good.transformedResume);
  assert.throws(() => parseTailoredResult(JSON.stringify({ ...good, transformedResume: good.transformedResume.replace('alex@example.com', 'no contact here') }), resume));
  assert.throws(() => parseTailoredResult(JSON.stringify({ ...good, transformedResume: good.transformedResume.replace('EDUCATION', 'STUDIES') }), resume));
  assert.throws(() => parseTailoredResult(JSON.stringify({ ...good, transformedResume: good.transformedResume.replace('React dashboards', 'React dashboards for 500 users') }), resume));
  assert.throws(() => parseTailoredResult('not JSON', resume));
});

test('resume headings and bullets have shared preview/export structure', () => {
  assert.deepEqual(parseResumeLines(resume).map(line => line.type), [
    'name', 'contact', 'section', 'body', 'bullet', 'bullet', 'section', 'body',
  ]);
});

test('writer sees the full source and an explicit no-invention rule', () => {
  const prompt = tailoringUserPrompt({ analysis: {}, claimAnalysis: {}, resume, relevantChunks: 'React dashboards' });
  assert.ok(prompt.includes('Bachelor of Science | Western University'));
  assert.ok(TAILORING_SYSTEM_PROMPT.includes('Never invent numbers'));
});
