import test from 'node:test';
import assert from 'node:assert/strict';
import { applyResumeEdits, editableResumeLines, screenResumeEdits } from '../server/resume-edits.js';
import { buildTailoringReport } from '../server/tailoring-report.js';
import { groundClaims } from '../server/resume-quality.js';
import { numberTokens } from '../server/text-match.js';
import { transformResume } from '../server/transform.js';
import { studentResume } from './fixtures/resumes.js';

test('each edit is checked on its own: invalid edits are dropped with a reason code, valid ones kept', () => {
  const source = 'Sam Lee\nsam@example.com\nEXPERIENCE\nAnalyst | Acme | 2024\n- Built weekly sales dashboards in Excel for 12 managers.\n- Cleaned customer data and fixed reporting errors.\n- Presented findings to the operations team.\n- Trained two new hires on reporting tools.';
  const requirements = [{ id: 'r1', text: 'SQL', priority: 'must_have', keywords: ['SQL'] }];
  const matches = [{ requirement_id: 'r1', claim_ids: [], match_type: 'unsupported' }];
  const { kept, dropped } = screenResumeEdits(source, [
    { lineId: 'line-4', replacement: 'Built weekly sales dashboards in Excel for 12 store managers.' },
    { lineId: 'line-5', replacement: 'Cleaned 40 customer records and fixed reporting errors.' },
    { lineId: 'line-0', replacement: 'Someone Else' },
    { lineId: 'line-4', replacement: 'A second edit to the same bullet.' },
    { lineId: 'line-6', replacement: 'Presented findings to the operations team and wrote SQL queries.' },
    { lineId: 'line-7', replacement: 'Trained two new hires on reporting tools, dashboards, data checks, naming rules and review steps every week.' },
    null,
  ], requirements, matches);
  assert.deepEqual(kept.map(edit => edit.lineId), ['line-4']);
  assert.deepEqual(dropped, [
    { lineId: 'line-5', reason: 'metrics_changed' },
    { lineId: 'line-0', reason: 'invalid_target' },
    { lineId: 'line-4', reason: 'duplicate_target' },
    { lineId: 'line-6', reason: 'unsupported_keyword' },
    { lineId: 'line-7', reason: 'expansion' },
    { lineId: null, reason: 'invalid_target' },
  ]);
  assert.ok(dropped.every(item => Object.keys(item).join() === 'lineId,reason'), 'reasons carry no resume text');
});

test('edits beyond the 35% budget are dropped as over_limit', () => {
  const lines = editableResumeLines(studentResume);
  const limit = Math.max(1, Math.ceil(lines.length * 0.35));
  const { kept, dropped } = screenResumeEdits(studentResume, lines.map(line => ({ lineId: line.id, replacement: `${line.text.replace(/^\s*[-•*]\s+/, '')} (revised)` })));
  assert.equal(kept.length, limit);
  assert.ok(dropped.length && dropped.every(item => item.reason === 'over_limit'));
});

test('named tools of related-only requirements, removed contacts and +9-word edits are dropped', () => {
  const source = 'Sam Lee\nsam@example.com\nEXPERIENCE\nEngineer | Acme | 2024\n- Packaged services with Docker containers.\n- Published release notes at docs.example.com and sam@example.com.\n- Fixed flaky tests in the build pipeline.';
  const requirements = [{ id: 'r1', text: 'Kubernetes', priority: 'must_have', keywords: ['Kubernetes'] }];
  const matches = [{ requirement_id: 'r1', claim_ids: ['c1'], match_type: 'semantic' }];
  const { dropped } = screenResumeEdits(source, [
    { lineId: 'line-4', replacement: 'Packaged services with Docker containers on Kubernetes.' },
    { lineId: 'line-5', replacement: 'Published release notes at docs.example.com.' },
    { lineId: 'line-6', replacement: 'Fixed flaky tests in the build pipeline, cutting reruns for every single developer on the team.' },
  ], requirements, matches);
  assert.deepEqual(dropped.map(item => item.reason), ['semantic_keyword', 'contact_removed', 'expansion']);
  const ok = screenResumeEdits(source, [{ lineId: 'line-6', replacement: 'Fixed flaky tests in the build pipeline, cutting reruns for every single developer.' }], requirements, matches);
  assert.equal(ok.kept.length, 1, 'exactly 8 more words is allowed');
});

test('numbers written in words or with M/B suffixes count like digits, but "three" to "3" is not a change', () => {
  const source = 'Sam Lee\nsam@example.com\nEXPERIENCE\nTutor | Acme | 2024\n- Tutored three students in algebra each week.\n- Raised $1.5M for the campus food bank.\n- Built a study guide for the course.\n- Placed second in the regional math contest.\n- Led one-on-one sessions for new tutors.\n- Cut printing costs by 30% with shared notes.\n- Doubled sign-ups for the spring review sessions.\n- Answered questions from hundreds of students online.';
  const { dropped } = screenResumeEdits(source, [
    { lineId: 'line-4', replacement: 'Tutored seventy-five students in algebra each week.' },
    { lineId: 'line-5', replacement: 'Raised $1.5B for the campus food bank.' },
    { lineId: 'line-6', replacement: 'Built two study guides for the course.' },
  ]);
  assert.deepEqual(dropped.map(item => item.reason), ['metrics_changed', 'metrics_changed', 'metrics_changed']);
  assert.deepEqual(screenResumeEdits(source, [
    { lineId: 'line-7', replacement: 'Placed first in the regional math contest.' },
    { lineId: 'line-10', replacement: 'Tripled sign-ups for the spring review sessions.' },
    { lineId: 'line-11', replacement: 'Answered questions from thousands of students online.' },
  ]).dropped.map(item => item.reason), ['metrics_changed', 'metrics_changed', 'metrics_changed']);
  const { kept } = screenResumeEdits(source, [
    { lineId: 'line-4', replacement: 'Tutored 3 students in algebra every week.' },
    { lineId: 'line-5', replacement: 'Raised $1.5 million for the campus food bank.' },
    { lineId: 'line-8', replacement: 'Led individual sessions for new tutors.' },
    { lineId: 'line-9', replacement: 'Cut printing costs by 30 percent with shared notes.' },
  ]);
  assert.equal(kept.length, 3, 'the 35% budget allows 3 of 8 bullets');
  assert.deepEqual(numberTokens('Certified in CPR and First Aid; first-hand experience with one-on-one care.'), []);
  assert.deepEqual(numberTokens('Two programs that talk to one another.'), ['2']);
  assert.throws(() => applyResumeEdits(source, [{ lineId: 'line-4', replacement: 'Tutored seventy-five students in algebra each week.' }]), /metrics/);
});

test('an edit that copies another bullet is dropped; similar wording and duplicated source bullets are not copies', () => {
  const source = 'Sam Lee\nsam@example.com\nEXPERIENCE\nTutor | Acme | 2024\n- Tutored three students in algebra each week.\n- Tutored seventy-five students in calculus each term.\nVolunteer | Food Bank | 2023\n- Wrote onboarding guides for new volunteers.\n- Scheduled shifts and tracked attendance in Google Sheets.\n- Answered customer emails.\nCashier | Market | 2022\n- Answered customer emails.\n- Counted the till at closing.\n- Restocked shelves and checked prices.';
  const { kept, dropped } = screenResumeEdits(source, [
    { lineId: 'line-4', replacement: 'Tutored seventy-five students in calculus each term.' },
    { lineId: 'line-7', replacement: 'Scheduled volunteer shifts and tracked attendance in Google Sheets.' },
    { lineId: 'line-9', replacement: 'Answered customer emails promptly.' },
  ]);
  assert.deepEqual(dropped, [{ lineId: 'line-4', reason: 'copied_bullet' }, { lineId: 'line-7', reason: 'copied_bullet' }]);
  assert.deepEqual(kept.map(edit => edit.lineId), ['line-9']);
  assert.equal(screenResumeEdits(source, [{ lineId: 'line-7', replacement: 'Wrote clear onboarding guides for new volunteers.' }]).kept.length, 1);
  assert.throws(() => applyResumeEdits(source, [{ lineId: 'line-4', replacement: 'Tutored seventy-five students in calculus each term.' }]), /copies another bullet/);
});

test('quotes match whole words only, and a supported term is never attached to an unrelated bullet', () => {
  const resume = 'Sam Lee\nsam@example.com\nSKILLS\nJava, Excel\nEXPERIENCE\nDeveloper | Acme | 2024\n- Built JavaScript widgets for the support team.\n- Stored events in MongoDB (NoSQL).';
  const grounded = groundClaims([
    { id: 'c1', text: 'Java', type: 'skill', raw_phrase: 'Java' },
    { id: 'c2', text: 'SQL', type: 'skill', raw_phrase: 'SQL' },
  ], resume);
  assert.deepEqual(grounded.map(claim => claim.id), ['c1'], 'SQL appears only inside NoSQL');
  const requirements = [{ id: 'r1', text: 'Java development', priority: 'must_have', keywords: ['Java'] }];
  const matches = [{ requirement_id: 'r1', claim_ids: ['c1'], match_type: 'exact' }];
  const { dropped } = screenResumeEdits(resume, [{ lineId: 'line-6', replacement: 'Built Java and JavaScript widgets for the support team.' }], requirements, matches, grounded);
  assert.deepEqual(dropped, [{ lineId: 'line-6', reason: 'misplaced_keyword' }]);
});

test('the report keeps an edited evidence bullet only while it still states the fact, including PDF text', () => {
  const requirements = [{ id: 'r1', text: 'Python', priority: 'must_have', keywords: ['Python'] }];
  const claims = [{ id: 'c1', raw_phrase: 'Helped students debug Python programs' }];
  const matches = [{ requirement_id: 'r1', claim_ids: ['c1'], match_type: 'exact' }];
  const line = editableResumeLines(studentResume).find(item => item.text.includes('debug Python'));
  const kept = applyResumeEdits(studentResume, [{ lineId: line.id, replacement: 'Helped students debug Python programs in weekly labs.' }]);
  assert.equal(buildTailoringReport(requirements, matches, claims, kept, [], `${studentResume}\n\n`).items[0].status, 'included');
  const removed = applyResumeEdits(studentResume, [{ lineId: line.id, replacement: 'Helped students debug programs during weekly lab sessions.' }]);
  assert.equal(buildTailoringReport(requirements, matches, claims, removed, [], studentResume).items[0].status, 'expand');
});

test('transform keeps valid edits when one breaks a rule, keeps degrees labelled "education", and lists only kept edits', async () => {
  const resume = 'Sam Lee\nsam@example.com\nEDUCATION\nBachelor of Science, Statistics | Example University | 2023\nEXPERIENCE\nAnalyst | Acme | 2024\n- Built weekly sales dashboards in Excel for 12 managers.\n- Cleaned customer data and fixed reporting errors.\n- Presented findings to the operations team.';
  const answers = [
    { job: { valid: true, roleTitle: 'Junior Data Analyst', company: '', roleLevel: 'entry', requiredSkills: ['data visualization'], niceToHaveSkills: [], mustHaveKeywords: [],
      requirements: [
        { id: 'req1', text: 'Build data visualizations', type: 'skill', priority: 'must_have', keywords: ['data visualizations'] },
        { id: 'req2', text: "Bachelor's degree in a quantitative field", type: 'qualification', priority: 'must_have', keywords: ['Statistics'] },
      ] },
    claims: [
      { id: 'c1', text: 'Built weekly sales dashboards', type: 'tool', raw_phrase: 'Built weekly sales dashboards in Excel for 12 managers.' },
      { id: 'c2', text: 'Statistics degree', type: 'education', raw_phrase: 'Bachelor of Science, Statistics' },
    ] },
    { matches: [
      { requirement_id: 'req1', claim_ids: ['c1'], match_type: 'exact', explanation: 'Dashboards are data visualizations.' },
      { requirement_id: 'req2', claim_ids: ['c2'], match_type: 'exact', explanation: 'Listed degree.' },
    ] },
    { edits: [
      { lineId: 'line-6', replacement: 'Built weekly sales data visualizations in Excel for 12 managers.' },
      { lineId: 'line-7', replacement: 'Cleaned customer data and fixed reporting errors.' },
      { lineId: 'line-8', replacement: 'Presented findings to 3 operations leads.' },
    ],
    requirementFeedback: [],
    improvements: ['Named the dashboards as data visualizations.', 'Named the 3 leads you presented to.'] },
  ];
  let call = 0;
  const client = { messages: { create: async () => ({ content: [{ text: JSON.stringify(answers[call++]) }] }) } };
  const result = await transformResume({ client, resume, jobDescription: 'Junior Data Analyst: build data visualizations; quantitative degree.', step: (_id, _label, run) => run() });
  assert.deepEqual(result.changes, [{ original: '- Built weekly sales dashboards in Excel for 12 managers.', revised: 'Built weekly sales data visualizations in Excel for 12 managers.' }]);
  assert.deepEqual(result.droppedEdits, [{ lineId: 'line-8', reason: 'metrics_changed' }]);
  assert.deepEqual(result.improvements, ['Revised a bullet under Analyst.']);
  assert.equal(result.report.items.find(item => item.id === 'req2').status, 'included');
});
