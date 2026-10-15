import { useState, useRef } from 'react';
import ResumeAnalysis from './ResumeAnalysis';

export default function InputPanel({ resume, setResume, jobDescription, setJobDescription, analysis, analyzing, onAnalyze, aiReady, aiBusy, sourcePages, maxPages, setMaxPages, retryIn = 0 }) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [fileName, setFileName] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef(null);

  async function handleFile(file) {
    if (!file) return;
    if (file.type !== 'application/pdf') {
      setUploadError('Only PDF files are supported.');
      return;
    }
    setUploadError('');
    setUploading(true);
    setFileName(file.name);

    const formData = new FormData();
    formData.append('resume', file);

    try {
      const res = await fetch('/api/parse-pdf', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setResume(data.text, { pageCount: data.pageCount });
    } catch (err) {
      setUploadError(err.message || 'Failed to read PDF.');
      setFileName('');
    } finally {
      setUploading(false);
    }
  }

  function onFileInput(e) {
    handleFile(e.target.files[0]);
    e.target.value = '';
  }

  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    handleFile(e.dataTransfer.files[0]);
  }

  function clearResume() {
    setResume('');
    setFileName('');
    setUploadError('');
  }

  return (
    <div className="input-panel">

      {/* Resume upload */}
      <div className="field-group">
        <label className="field-label">
          <span className="label-badge">1</span> Your Resume
        </label>

        {!resume && (
          <div
            className={`drop-zone${dragging ? ' drag-over' : ''}${uploading ? ' uploading' : ''}`}
            role="button"
            tabIndex={0}
            aria-label="Upload your resume as a PDF"
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              style={{ display: 'none' }}
              onChange={onFileInput}
            />
            {uploading ? (
              <><span className="spinner dark" /> Reading PDF...</>
            ) : (
              <>
                <span className="drop-icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M12 17v-5m-3 3 3-3 3 3" /></svg></span>
                <span className="drop-text">Click to upload or drag & drop</span>
                <span className="drop-hint">PDF only · max 10 MB</span>
              </>
            )}
          </div>
        )}
        {resume && (
            <div className="resume-preview-bar">
              <span className="file-name">✓ {fileName || 'Resume loaded'}</span>
              <button className="clear-btn" onClick={clearResume}>✕ Remove</button>
            </div>
        )}
        <textarea
          className="text-area resume-text"
          aria-label="Your resume text"
          placeholder="Or paste your resume text here..."
          value={resume}
          onChange={(e) => setResume(e.target.value)}
          spellCheck={false}
        />
        {resume && (
          <div className="resume-preview-wrap">
            <div className="char-count">{resume.length} chars — you can edit the text above</div>
            <div className="resume-length-control">
              <label htmlFor="resume-page-limit">Output length
                <select id="resume-page-limit" value={maxPages} disabled={aiBusy} onChange={event => setMaxPages(Number(event.target.value))}>
                  {Array.from({ length: Math.max(5, Math.min(20, maxPages)) }, (_, index) => index + 1).map(count => <option value={count} key={count}>Up to {count} {count === 1 ? 'page' : 'pages'}</option>)}
                </select>
              </label>
              <span>{sourcePages ? `Original PDF: ${sourcePages} ${sourcePages === 1 ? 'page' : 'pages'}.` : 'Estimated from pasted text. Adjust to match your original.'}</span>
            </div>
            <div className="resume-analysis-action">
              <button onClick={onAnalyze} disabled={!aiReady || analyzing || aiBusy || retryIn > 0}>
                {analyzing ? 'Analyzing…' : 'Analyze my resume'}
              </button>
              <span>{retryIn > 0 ? `Try again in ${retryIn}s.` : aiBusy ? 'Wait for Transform to finish, or cancel it.' : aiReady ? 'Uses your ChatGPT plan when you click.' : 'Connect your ChatGPT plan to get feedback.'}</span>
            </div>
            <ResumeAnalysis analysis={analysis} analyzing={analyzing} />
          </div>
        )}

        {uploadError && <div className="upload-error">{uploadError}</div>}
      </div>

      {/* Job description */}
      <div className="field-group">
        <label className="field-label">
          <span className="label-badge">2</span> Job Description
        </label>
        <textarea
          className="text-area"
          aria-label="Job description"
          placeholder="Paste the job posting or description here..."
          value={jobDescription}
          onChange={(e) => setJobDescription(e.target.value)}
          spellCheck={false}
        />
        <div className="char-count">{jobDescription.length} chars</div>
      </div>

    </div>
  );
}
