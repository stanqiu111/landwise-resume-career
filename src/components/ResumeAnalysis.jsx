import { useState } from 'react';

const PRIORITY_STYLES = {
  high:   { label: 'HIGH',   cls: 'priority-high' },
  medium: { label: 'MED',    cls: 'priority-med' },
  low:    { label: 'LOW',    cls: 'priority-low' },
};

function ScoreDot({ score }) {
  const color = score >= 8 ? 'var(--success)' : score >= 5 ? 'var(--warn)' : 'var(--error)';
  return <span className="section-score-dot" style={{ background: color }}>{score}</span>;
}

export default function ResumeAnalysis({ analysis, analyzing }) {
  const [open, setOpen] = useState(true);

  if (analyzing) {
    return (
      <div className="resume-analysis-wrap">
        <div className="resume-analysis-loading">
          <span className="spinner dark" />
          <span>Analyzing your resume...</span>
        </div>
      </div>
    );
  }

  if (!analysis) return null;

  const { overallScore, sections, strengths, improvements, suggestedLLMSkills, missingElements } = analysis;
  const scoreColor = overallScore >= 75 ? 'var(--success)' : overallScore >= 50 ? 'var(--warn)' : 'var(--error)';

  return (
    <div className="resume-analysis-wrap">
      <div className="resume-analysis-header" onClick={() => setOpen(o => !o)}>
        <div className="resume-analysis-header-left">
          <span className="resume-analysis-title">Resume Analysis</span>
          <div className="ra-score-pill" style={{ '--ra-color': scoreColor }}>
            {overallScore}/100
          </div>
        </div>
        <button className="ra-toggle">{open ? '▲' : '▼'}</button>
      </div>

      {open && (
        <div className="resume-analysis-body">
          {/* Sections row */}
          {sections?.length > 0 && (
            <div className="ra-section">
              <p className="ra-label">Sections</p>
              <div className="ra-sections-grid">
                {sections.map(s => (
                  <div className="ra-section-card" key={s.name} title={s.feedback}>
                    <ScoreDot score={s.score} />
                    <span className="ra-section-name">{s.name}</span>
                    {!s.present && <span className="ra-missing-badge">missing</span>}
                  </div>
                ))}
              </div>
              {/* Section feedbacks */}
              <div className="ra-feedbacks">
                {sections.filter(s => s.feedback).map(s => (
                  <div className="ra-feedback-row" key={s.name}>
                    <ScoreDot score={s.score} />
                    <span className="ra-feedback-name">{s.name}</span>
                    <span className="ra-feedback-text">{s.feedback}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Strengths */}
          {strengths?.length > 0 && (
            <div className="ra-section">
              <p className="ra-label">Strengths</p>
              <div className="chip-group">
                {strengths.map((s, i) => (
                  <span key={i} className="chip chip-success">{s}</span>
                ))}
              </div>
            </div>
          )}

          {/* Improvements */}
          {improvements?.length > 0 && (
            <div className="ra-section">
              <p className="ra-label">Improvements</p>
              <ul className="ra-improvements">
                {improvements.map((imp, i) => {
                  const ps = PRIORITY_STYLES[imp.priority] || PRIORITY_STYLES.medium;
                  return (
                    <li key={i} className="ra-imp-row">
                      <span className={`ra-priority-badge ${ps.cls}`}>{ps.label}</span>
                      <span className="ra-imp-area">{imp.area}</span>
                      <span className="ra-imp-text">{imp.suggestion}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Suggested LLM Skills */}
          {suggestedLLMSkills?.length > 0 && (
            <div className="ra-section">
              <p className="ra-label">Add for LLM / AI Roles</p>
              <div className="chip-group">
                {suggestedLLMSkills.map((s, i) => (
                  <span key={i} className="chip chip-accent">{s}</span>
                ))}
              </div>
              <p className="ra-note">Skills relevant to your background that would strengthen AI/LLM role applications.</p>
            </div>
          )}

          {/* Missing elements */}
          {missingElements?.length > 0 && (
            <div className="ra-section">
              <p className="ra-label">Missing Elements</p>
              <div className="chip-group">
                {missingElements.map((m, i) => (
                  <span key={i} className="chip chip-error">{m}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
