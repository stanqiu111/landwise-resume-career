import FlapText from './FlapText';

const STAMPS = { included: 'Cleared', expand: 'Add evidence', learn: 'Learn next' };

const GROUPS = [
  ['included', 'Already shown in your resume', 'Direct evidence is present in the draft. Prepare to explain your contribution at interview.'],
  ['expand', 'Build on your existing experience', 'Related evidence exists. Strengthen it with accurate detail, practice or a clearer example.'],
  ['learn', 'Learn or gather evidence first', 'These requirements are not supported by the source resume. They were not added as new experience. If you already have them, add real evidence to your original resume.'],
];

export default function FitReport({ result }) {
  const report = result?.report;
  if (!report) return <p className="analysis-note">This older draft has no detailed fit report. Tailor it again to create one.</p>;
  return <div className="fit-report">
    <div className="result-match">
      <span className="result-match-number"><FlapText text={String(report.score)} key={report.score} /><small>/100</small></span>
      <div><strong>Job match estimate</strong><span>{result.job?.roleTitle}{result.job?.company ? ` · ${result.job.company}` : ''}</span></div>
    </div>
    <p className="analysis-note">{report.scoreExplanation}</p>
    <p className="fit-edit-note">{result.editCount ?? 0} targeted bullet edits. Your original roles, projects and their order are preserved.</p>
    {GROUPS.map(([status, title, description]) => {
      const items = report.items.filter(item => item.status === status);
      return <details className={`fit-group fit-${status}`} key={status} open={status !== 'included'}>
        <summary><h3><span className="fit-stamp" aria-hidden="true">{STAMPS[status]}</span>{title} <span>{items.length}</span></h3></summary>
        <p className="analysis-note">{description}</p>
        {items.length ? items.map(item => <article className="fit-item" key={item.id}>
          <div className="fit-item-heading"><h4>{item.requirement}</h4><span>{item.priority === 'must_have' ? 'Required' : 'Preferred'}</span></div>
          <p>{item.explanation}</p>
          {item.resumeQuote ? <blockquote><small>In your draft</small>{item.resumeQuote}</blockquote>
            : item.evidence.length > 0 && <p className="fit-placement">Related source evidence exists; an exact supporting passage in this draft was not verified.</p>}
          <p className="fit-next"><strong>Next step</strong> {item.nextStep}</p>
          {item.evidence.length > 0 && <details><summary>Original evidence</summary>{item.evidence.map((quote, index) => <blockquote key={index}>{quote}</blockquote>)}</details>}
        </article>) : <p className="fit-empty">No requirements in this group.</p>}
      </details>;
    })}
    {result.changes?.length > 0 && <details className="fit-group"><summary>Compare the edited bullets</summary>{result.changes.map((change, index) => <article className="fit-item" key={index}><small>Original</small><p>{change.original}</p><small>Revised</small><p>{change.revised}</p></article>)}</details>}
    {result.improvements?.length > 0 && <section className="analysis-section">
      <h3 className="analysis-title">Edits made</h3><ul className="improvements-list">{result.improvements.map((text, i) => <li key={i}>{text}</li>)}</ul>
    </section>}
  </div>;
}
