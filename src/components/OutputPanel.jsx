import { useState, useEffect } from 'react';
import { jsPDF } from 'jspdf';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import ClaimCoverage from './ClaimCoverage';
import UnsupportedRequirements from './UnsupportedRequirements';

function MatchScore({ score }) {
  const color = score >= 75 ? 'var(--success)' : score >= 50 ? '#facc15' : 'var(--error)';
  const label = score >= 75 ? 'Strong Match' : score >= 50 ? 'Moderate Match' : 'Weak Match';
  return (
    <div className="match-score-wrap">
      <div className="match-circle" style={{ '--score-color': color }}>
        <span className="match-number">{score}%</span>
      </div>
      <div className="match-info">
        <span className="match-label" style={{ color }}>{label}</span>
        <span className="match-sub">Estimated ATS keyword match</span>
      </div>
    </div>
  );
}

export default function OutputPanel({ result, loading, loadingPhase }) {
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState('resume');
  const [expanded, setExpanded] = useState(false);

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
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const margin = 50;
    const lineHeight = 13;
    const pageHeight = doc.internal.pageSize.getHeight();
    const pageWidth = doc.internal.pageSize.getWidth();

    doc.setFont('Courier', 'normal');
    doc.setFontSize(10);

    const lines = doc.splitTextToSize(result.transformedResume, pageWidth - margin * 2);
    let y = margin;
    for (const line of lines) {
      if (y + lineHeight > pageHeight - margin) {
        doc.addPage();
        y = margin;
      }
      doc.text(line, margin, y);
      y += lineHeight;
    }
    doc.save('tailored-resume.pdf');
  }

  async function handleDownloadDOCX() {
    const paragraphs = result.transformedResume.split('\n').map(
      line => new Paragraph({
        children: [new TextRun({ text: line, font: 'Calibri', size: 22 })],
        spacing: { after: 0 },
      })
    );

    const docx = new Document({
      sections: [{ properties: {}, children: paragraphs }],
    });

    const blob = await Packer.toBlob(docx);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tailored-resume.docx';
    a.click();
    URL.revokeObjectURL(url);
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
            <pre className="resume-modal-body">{result.transformedResume}</pre>
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
              <button className="download-btn" onClick={handleDownloadDOCX}>
                ↓ DOCX
              </button>
            </div>
          )}
        </div>

        <div className={`output-area${loading ? ' output-loading' : ''}`}>
          {loading && (
            <div className="output-placeholder">
              <div className="pulse-dots">
                <span className="pulse-dot" />
                <span className="pulse-dot" />
                <span className="pulse-dot" />
              </div>
              <p className="loading-label">{loadingPhase}</p>
            </div>
          )}

          {!loading && !hasResult && (
            <div className="output-placeholder empty">
              <span className="empty-icon">✦</span>
              <p>Your tailored resume will appear here after you click Transform.</p>
            </div>
          )}

          {!loading && hasResult && tab === 'resume' && (
            <pre className="output-text">{result.transformedResume}</pre>
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
