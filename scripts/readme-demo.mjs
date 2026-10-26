// Invented student, job and Transform result for the README screenshots.
// No real person, employer or AI output.
export const resume = `Jordan Lee
Toronto, ON | jordan.lee@example.com
SUMMARY
Computer science graduate who builds accessible web apps and data dashboards.
EDUCATION
BSc Computer Science, Lakeshore University | 2026
EXPERIENCE
Software Developer Intern | Maplewood Analytics | May 2025 - Aug 2025
- Built React components for an internal reporting dashboard used by 40 analysts.
- Reduced page load time by 30% by lazy-loading charts and caching API responses.
- Wrote Jest tests for 12 components and fixed 18 accessibility issues.
IT Help Desk Assistant | Lakeshore University Library | Sep 2024 - Apr 2026
- Resolved about 25 student and staff tickets a week for laptops, printers and Wi-Fi.
- Wrote 6 step-by-step guides that cut repeat questions at the front desk.
PROJECTS
Campus Study Room Finder | React, Node.js, PostgreSQL
- Built a web app that shows free study rooms in real time, used by 300 students in its first month.
- Added keyboard navigation and screen reader labels to every form.
SKILLS
JavaScript, TypeScript, React, HTML, CSS, Node.js, PostgreSQL, Git, Jest`;

export const job = `Junior Frontend Developer - Riverstone Software (Toronto, hybrid)

Riverstone Software builds scheduling tools for community health clinics. We are hiring a Junior Frontend Developer to join our product team.

What you will do
- Build accessible, responsive user interfaces with React and TypeScript
- Improve page performance and fix front-end bugs
- Write unit tests for shared components
- Work with designers and back-end developers in code reviews

What you bring
- Experience with JavaScript, React, HTML and CSS
- Understanding of web accessibility (WCAG)
- Nice to have: GraphQL, experience with a design system
- New graduates welcome`;

const edits = [
  ['- Built React components for an internal reporting dashboard used by 40 analysts.',
    '- Built accessible, responsive React components for an internal reporting dashboard used by 40 analysts.'],
  ['- Reduced page load time by 30% by lazy-loading charts and caching API responses.',
    '- Improved page performance by cutting load time 30% with lazy-loaded charts and cached API responses.'],
  ['- Wrote Jest tests for 12 components and fixed 18 accessibility issues.',
    '- Wrote Jest unit tests for 12 shared components and fixed 18 accessibility issues.'],
];

const items = [
  { id: 'r1', requirement: 'Build user interfaces with React', priority: 'must_have', status: 'included', explanation: 'Your internship dashboard is direct React interface work.', resumeQuote: 'Built accessible, responsive React components for an internal reporting dashboard used by 40 analysts.', evidence: ['Built React components for an internal reporting dashboard used by 40 analysts.'], nextStep: 'Be ready to walk through one component you built and who used it.' },
  { id: 'r2', requirement: 'Understanding of web accessibility (WCAG)', priority: 'must_have', status: 'included', explanation: 'You fixed accessibility issues and added keyboard and screen reader support.', resumeQuote: 'Wrote Jest unit tests for 12 shared components and fixed 18 accessibility issues.', evidence: ['Wrote Jest tests for 12 components and fixed 18 accessibility issues.', 'Added keyboard navigation and screen reader labels to every form.'], nextStep: 'Pick one accessibility fix and explain the problem and how you tested it.' },
  { id: 'r3', requirement: 'Write unit tests for shared components', priority: 'must_have', status: 'included', explanation: 'You wrote Jest tests for components during your internship.', resumeQuote: 'Wrote Jest unit tests for 12 shared components and fixed 18 accessibility issues.', evidence: ['Wrote Jest tests for 12 components and fixed 18 accessibility issues.'], nextStep: 'Prepare an example of a bug one of your tests caught.' },
  { id: 'r4', requirement: 'Improve page performance', priority: 'must_have', status: 'included', explanation: 'You cut dashboard load time by 30%.', resumeQuote: 'Improved page performance by cutting load time 30% with lazy-loaded charts and cached API responses.', evidence: ['Reduced page load time by 30% by lazy-loading charts and caching API responses.'], nextStep: 'Know how you measured the 30% and what you tried first.' },
  { id: 'r5', requirement: 'Build interfaces with TypeScript', priority: 'must_have', status: 'expand', explanation: 'TypeScript is in your skills list, but no role or project shows it in use.', resumeQuote: 'JavaScript, TypeScript, React, HTML, CSS, Node.js, PostgreSQL, Git, Jest', evidence: ['JavaScript, TypeScript, React, HTML, CSS, Node.js, PostgreSQL, Git, Jest'], nextStep: 'If you used TypeScript in a project, say where in your original resume.' },
  { id: 'r6', requirement: 'Work with designers and back-end developers in code reviews', priority: 'must_have', status: 'expand', explanation: 'Your dashboard served other teams, but your resume does not mention reviews or design handoffs.', resumeQuote: 'Built accessible, responsive React components for an internal reporting dashboard used by 40 analysts.', evidence: ['Built React components for an internal reporting dashboard used by 40 analysts.'], nextStep: 'Add a real example of a code review or design handoff, if you have one.' },
  { id: 'r7', requirement: 'GraphQL', priority: 'nice_to_have', status: 'learn', explanation: 'Your resume has no GraphQL evidence.', resumeQuote: '', evidence: [], nextStep: 'Try a short GraphQL tutorial, then add a query layer to a small project.' },
  { id: 'r8', requirement: 'Experience with a design system', priority: 'nice_to_have', status: 'learn', explanation: 'Your resume does not mention a design system.', resumeQuote: '', evidence: [], nextStep: 'Read through a public design system and rebuild one component from it.' },
];

// server/tailoring-report.js credits each requirement by match type (exact 1, related 0.5,
// none 0) and counts required ones twice. Here every included requirement is an exact match,
// every expand one a related match and every learn one unmatched, so status gives the credit.
const weight = item => item.priority === 'must_have' ? 2 : 1;
const credit = { included: 1, expand: 0.5, learn: 0 };
const score = Math.round(100 * items.reduce((sum, item) => sum + weight(item) * credit[item.status], 0)
  / items.reduce((sum, item) => sum + weight(item), 0));

export const result = {
  transformedResume: edits.reduce((text, [before, after]) => text.replace(before, after), resume),
  job: { roleTitle: 'Junior Frontend Developer', company: 'Riverstone Software' },
  editCount: edits.length, pageCount: 1, pageLimit: 1,
  claim_coverage: Math.round(100 * items.filter(item => item.evidence.length).length / items.length),
  unsupported_requirements: items.filter(item => item.status === 'learn').map(item => item.requirement),
  changes: edits.map(([original, revised]) => ({ original, revised: revised.replace(/^- /, '') })),
  improvements: ['Highlighted accessible, responsive React work for this role.', 'Framed the load-time result as performance work.', 'Named unit testing explicitly.'],
  report: {
    score,
    scoreExplanation: 'Source-evidence estimate: must-have requirements count twice. Direct evidence earns full credit, related evidence half, and missing evidence zero. This is not an ATS score or a hiring prediction.',
    items,
  },
};
