import test from 'node:test';
import assert from 'node:assert/strict';
import { applyResumeEdits, editableResumeLines, rejectUnsupportedAdditions } from '../server/resume-edits.js';
import { buildTailoringReport } from '../server/tailoring-report.js';
import { studentResume } from './fixtures/resumes.js';

const requirements = [{ id: 'r1', text: 'React', priority: 'must_have' }, { id: 'r2', text: 'Cloud deployments', priority: 'must_have' }, { id: 'r3', text: 'Kubernetes', priority: 'nice_to_have' }];
const claims = [{ id: 'c1', raw_phrase: 'Built React dashboards for operations.' }, { id: 'c2', raw_phrase: 'Connected dashboard components to REST endpoints' }];
const matches = [{ requirement_id: 'r1', claim_ids: ['c1'], match_type: 'exact' }, { requirement_id: 'r2', claim_ids: ['c2'], match_type: 'semantic' }];

test('targeted edits preserve every other line, project purpose, role and source section', () => {
  const line = editableResumeLines(studentResume)[0];
  const output = applyResumeEdits(studentResume, [{ lineId: line.id, replacement: 'Developed React dashboards for operations.' }]);
  assert.equal(output, studentResume.replace('Built React dashboards for operations.', 'Developed React dashboards for operations.'));
  assert.ok(output.includes('Study Planner | Python, PostgreSQL'));
  assert.ok(output.includes('Created a planner that groups coursework by deadline'));
  assert.equal(applyResumeEdits(studentResume, []), studentResume);
});

test('deletion, new roles, multiline additions, expansion and excessive editing are rejected', () => {
  const lines = editableResumeLines(studentResume);
  for (const edits of [
    [{ lineId: 'line-0', replacement: 'New identity' }],
    [{ lineId: lines[0].id, replacement: '' }],
    [{ lineId: lines[0].id, replacement: 'Built React.\n- Led Kubernetes infrastructure.' }],
    [{ lineId: lines[0].id, replacement: 'Invented experience '.repeat(50) }],
    lines.map(line => ({ lineId: line.id, replacement: 'Different purpose' })),
    [{ lineId: lines[0].id, replacement: 'React' }, { lineId: lines[0].id, replacement: 'React again' }],
  ]) assert.throws(() => applyResumeEdits(studentResume, edits));
});

test('metrics cannot be deleted or borrowed from another experience', () => {
  const source = 'Alex\nEXPERIENCE\nEngineer\n- Reduced load time by 30%.\n- Helped 50 students.';
  assert.throws(() => applyResumeEdits(source, [{ lineId: 'line-3', replacement: 'Reduced load time by 50%.' }]));
  assert.throws(() => applyResumeEdits(source, [{ lineId: 'line-3', replacement: 'Reduced load time.' }]));
});

test('weighted match score distinguishes direct, transferable and absent evidence', () => {
  const report = buildTailoringReport(requirements, matches, claims, studentResume);
  assert.equal(report.score, 60); // (2 direct + 1 transferable) / 5 weighted requirements
  assert.deepEqual(report.items.map(item => item.status), ['included', 'expand', 'learn']);
  assert.equal(report.items[0].resumeQuote, claims[0].raw_phrase);
  assert.match(report.items[2].nextStep, /before adding it/);
});

test('invented placement and unsupported feedback cannot upgrade a requirement', () => {
  const report = buildTailoringReport(requirements, matches, claims, 'Changed draft with no original quotes', [
    { requirement_id: 'r1', resumeQuote: 'Made up quote' },
    { requirement_id: 'r3', resumeQuote: 'Changed draft', nextStep: 'Study orchestration basics.' },
  ]);
  assert.equal(report.items[0].resumeQuote, '');
  assert.equal(report.items[0].status, 'expand');
  assert.equal(report.items[2].resumeQuote, '');
  assert.equal(report.items[2].status, 'learn');
  assert.equal(report.items[2].nextStep, 'Study orchestration basics.');
});

test('a rephrased supporting passage is located in the actual final draft', () => {
  const report = buildTailoringReport(requirements, matches, claims, 'Developed React dashboards for operations.', [
    { requirement_id: 'r1', resumeQuote: 'Developed React dashboards for operations.', nextStep: 'Explain the component design.' },
  ]);
  assert.equal(report.items[0].status, 'included');
  assert.equal(report.items[0].resumeQuote, 'Developed React dashboards for operations.');
});


test('unsupported JD technologies stay out of revised bullets even when the model adds them', () => {
  const requirements = [{ id: 'r1', keywords: ['AWS', 'C++', 'Kubernetes'] }];
  for (const keyword of ['AWS', 'C++', 'Kubernetes']) {
    assert.throws(() => rejectUnsupportedAdditions(studentResume, studentResume + ` Built with ${keyword}.`, requirements, []));
  }
  assert.doesNotThrow(() => rejectUnsupportedAdditions('Built with AWS.', 'Built dashboards with AWS.', requirements, []));
  assert.doesNotThrow(() => rejectUnsupportedAdditions(studentResume, studentResume + ' The laws of design.', requirements, []));
});
