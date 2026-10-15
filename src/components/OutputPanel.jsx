import { useState, useEffect } from 'react';
import { resumePDF, estimateResumePages } from '../resumeLayout';
import { resumeDOCXBlob } from '../resumeDocx';
import ClaimCoverage from './ClaimCoverage';
import UnsupportedRequirements from './UnsupportedRequirements';
import TransformActivity from './TransformActivity';
import { parseResumeLines } from '../resumeDocument';

function ResumePreview({ text, className = '' }) {
  return <div className={`resume-document ${className}`}>
    {parseResumeLines(text).map((line, i) => {
      if (line.type === 'name') return <h2 key={i}>{line.text}</h2>;
      if (line.type === 'section') return <h3 key={i}>{line.text}</h3>;
      if (line.type === 'bullet') return <p className="resume-bullet" key={i}>{line.text}</p>;
      return <p className={line.type === 'contact' ? 'resume-contact' : ''} key={i}>{line.text}</p>;
    })}
  </div>;
}

function MatchScore({ score }) {
  const color = score >= 75 ? 'var(--success)' : score >= 50 ? 'var(--warn)' : 'var(--error)';
  const label = score >= 75 ? 'Strong Match' : score >= 50 ? 'Moderate Match' : 'Weak Match';
  return (
    <div className="match-score-wrap">
      <div className="match-circle" style={{ '--score-color': color }}>
        <span className="match-number">{score}%</span>
      </div>
      <div className="match-info">
        <span className="match-label" style={{ color }}>{label}</span>
        <span className="match-sub">Estimated keyword overlap</span>
      </div>
    </div>
  );
}

export default function OutputPanel({ result, loading, progress, error, retryIn = 0 }) {
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState('resume');
  const [expanded, setExpanded] = useState(false);
  const [exportError, setExportError] = useState('');

  useEffect(() => {
    if (!expanded) return;
    function onKey(e) { if (e.key === 'Escape') setExpanded(false); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  function handleCopy() {
    navigator.clipboard.writeText(result.transformedResume);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleDownloadPDF() {
    try {
      setExportError('');
      resumePDF(result.transformedResume, result.pageLimit ?? estimateResumePages(result.transformedResume)).save('tailored-resume.pdf');
    } catch (error) {
      setExportError(error.message);
    }
  }

  async function handleDownloadDOCX() {
    try {
      setExportError('');
      const blob = await resumeDOCXBlob(result.transformedResume, result.pageLimit ?? estimateResumePages(result.transformedResume));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'tailored-resume.docx';
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportError(error.message);
    }
  }

  const hasResult = result && result.transformedResume;

  return (
    <>
      {/* Expand modal */}
      {expanded && (
        <div className="resume-modal-overlay" onClick={() => setExpanded(false)}>
          <div className="resume-modal" onClick={e => e.stopPropagation()}>
            <div className="resume-modal-header">
              <span className="resume-modal-title">Tailored Resume</span>
              <button className="resume-modal-close" onClick={() => setExpanded(false)}>✕ Close</button>
            </div>
            <ResumePreview text={result.transformedResume} className="resume-modal-body" />
          </div>
        </div>
      )}

      <div className="output-panel">
        <div className="output-header">
          <label className="field-label">
            <span className="label-badge">3</span> Tailored Resume
          </label>
          {hasResult && (
            <div className="output-header-actions">
              <div className="tab-group">
                <button
                  className={`tab-btn${tab === 'resume' ? ' active' : ''}`}
                  onClick={() => setTab('resume')}
                >
                  Resume
                </button>
                <button
                  className={`tab-btn${tab === 'analysis' ? ' active' : ''}`}
                  onClick={() => setTab('analysis')}
                >
                  Analysis
                </button>
                <button
                  className={`tab-btn${tab === 'claims' ? ' active' : ''}`}
                  onClick={() => setTab('claims')}
                >
                  Claims
                </button>
              </div>
              <button className="expand-btn" onClick={() => setExpanded(true)} title="Expand (Esc to close)">
                ⤢ Expand
              </button>
              <button className="copy-btn" onClick={handleCopy}>
                {copied ? '✓ Copied' : '⎘ Copy'}
              </button>
              <button className="download-btn" onClick={handleDownloadPDF}>
                ↓ PDF
              </button>
              <button className="download-btn" onClick={handleDownloadDOCX} title="Editable Word document. Fonts and later edits can change pagination.">
                ↓ DOCX
              </button>
            </div>
          )}
        </div>

        {!loading && error && <div className="transform-error" role="alert">
          <strong>Transform didn’t finish</strong>
          <p>{error.message}</p>
          {retryIn > 0 && <p>Retry available in {retryIn}s. Your resume and job description are still here.</p>}
          {error.manageUsage && <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage ChatGPT usage ↗</a>}
        </div>}
        {!loading && !error && hasResult && progress?.complete && <p className="transform-duration">Ready in {Math.round(progress.elapsedMs / 1000)} seconds</p>}
        {!loading && hasResult && result.pageCount && <p className="resume-page-count">{result.pageCount} {result.pageCount === 1 ? 'page' : 'pages'} · Within your {result.pageLimit}-page limit</p>}
        {exportError && <p className="upload-error" role="alert">{exportError}</p>}
        <div className={`output-area${loading ? ' output-loading' : ''}`}>
          {loading && <TransformActivity progress={progress} />}

          {!loading && !hasResult && !error && (
            <div className="output-placeholder empty">
              <div className="empty-document" aria-hidden="true"><span className="empty-document-star">✦</span><span /><span /><span /><span /></div>
              <strong>Your next chapter, on paper.</strong>
              <p>Your tailored resume will appear here after you click Transform.</p>
            </div>
          )}

          {!loading && hasResult && tab === 'resume' && (
            <ResumePreview text={result.transformedResume} className="output-text" />
          )}

          {!loading && hasResult && tab === 'analysis' && (
            <div className="analysis-content">
              {result.matchScore != null && <MatchScore score={result.matchScore} />}

              {result.keywordsAdded?.length > 0 && (
                <div className="analysis-section">
                  <h4 className="analysis-title">Keywords Added</h4>
                  <div className="chip-group">
                    {result.keywordsAdded.map(k => (
                      <span key={k} className="chip chip-success">{k}</span>
                    ))}
                  </div>
                </div>
              )}

              {result.missingSkills?.length > 0 && (
                <div className="analysis-section">
                  <h4 className="analysis-title">Skills Gap</h4>
                  <div className="chip-group">
                    {result.missingSkills.map(k => (
                      <span key={k} className="chip chip-warn">{k}</span>
                    ))}
                  </div>
                  <p className="analysis-note">
                    Required by the job but not in your resume. Consider addressing these in a cover letter or upskilling plan.
                  </p>
                </div>
              )}

              {result.improvements?.length > 0 && (
                <div className="analysis-section">
                  <h4 className="analysis-title">Changes Made</h4>
                  <ul className="improvements-list">
                    {result.improvements.map((imp, i) => (
                      <li key={i}>{imp}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {!loading && hasResult && tab === 'claims' && (
            <div className="claims-content">
              {result.claim_coverage != null && <ClaimCoverage coverage={result.claim_coverage} />}
              <UnsupportedRequirements items={result.unsupported_requirements} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
