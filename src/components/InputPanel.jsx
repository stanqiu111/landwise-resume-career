import { useState, useRef, useEffect } from 'react';
import ResumeAnalysis from './ResumeAnalysis';

const wordCount = text => text.trim() ? text.trim().split(/\s+/u).length : 0;

export default function InputPanel({ resume, setResume, jobDescription, setJobDescription, analysis, analyzing, onAnalyze, aiReady, aiBusy, sourcePages, maxPages, setMaxPages, retryIn = 0, children }) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [fileName, setFileName] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef(null);
  const uploadRef = useRef(null);
  const disabled = aiBusy || uploading;

  useEffect(() => () => uploadRef.current?.abort(), []);

  async function handleFile(file) {
    if (!file || disabled) return;
    if (file.type !== 'application/pdf') {
      setUploadError('Only PDF files are supported. You can also paste your resume below.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setUploadError('PDF must be 10 MB or smaller.');
      return;
    }
    setUploadError('');
    setUploading(true);
    const controller = new AbortController();
    uploadRef.current = controller;
    const formData = new FormData();
    formData.append('resume', file);
    try {
      const response = await fetch('/api/parse-pdf', { method: 'POST', body: formData, signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not read this PDF.');
      if (!controller.signal.aborted) {
        setResume(data.text, { pageCount: data.pageCount });
        setFileName(file.name);
      }
    } catch (error) {
      if (!controller.signal.aborted) setUploadError(error.message || 'Failed to read PDF.');
    } finally {
      if (uploadRef.current === controller) {
        uploadRef.current = null;
        setUploading(false);
      }
    }
  }

  function clearResume() {
    setResume('');
    setFileName('');
    setUploadError('');
  }

  return (
    <section className="input-panel" aria-labelledby="input-panel-title">
      <header className="panel-heading">
        <div>
          <p className="panel-eyebrow">The starting point</p>
          <h2 id="input-panel-title">Your details</h2>
        </div>
        <span className="panel-index">01 / INPUT</span>
      </header>

      <div className="input-panel-body">
        <div className="field-group">
          <div className="field-heading">
            <label className="field-label" htmlFor="resume-text"><span className="label-badge">1</span>Your resume</label>
            <span className="field-hint">PDF or text</span>
          </div>
          <input ref={fileInputRef} type="file" accept=".pdf" hidden disabled={disabled}
            onChange={event => { handleFile(event.target.files[0]); event.target.value = ''; }} />
          <button
            type="button"
            className={'drop-zone' + (dragging ? ' drag-over' : '')}
            aria-label="Upload your resume as a PDF"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={event => { event.preventDefault(); if (!disabled) setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={event => { event.preventDefault(); setDragging(false); handleFile(event.dataTransfer.files[0]); }}
          >
            <span className="drop-icon" aria-hidden="true">
              {uploading ? <span className="spinner dark" /> : <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V3m-4 4 4-4 4 4M4 14v6h16v-6" /></svg>}
            </span>
            <span className="drop-copy">
              <span className="drop-text">{uploading ? 'Reading your PDF…' : 'Upload your resume'}</span>
              <span className="drop-hint">{fileName ? fileName + ' · Choose a file to replace' : 'Choose a file or drop it here · PDF, up to 10 MB'}</span>
            </span>
            <span className="drop-plus" aria-hidden="true">+</span>
          </button>
          {uploadError && <p className="upload-error" role="alert">{uploadError}</p>}
          <textarea
            id="resume-text"
            className="text-area resume-text"
            aria-label="Your resume text"
            placeholder="Paste your resume here, or upload a PDF above."
            value={resume}
            disabled={disabled}
            onChange={event => { setResume(event.target.value); setUploadError(''); }}
            spellCheck={false}
          />
          <div className="field-meta">
            <span>{wordCount(resume)} words{resume ? ' · Edit your text above' : ''}</span>
            <button className="clear-btn" onClick={clearResume} disabled={!resume || disabled} aria-label="Clear resume">Clear</button>
          </div>
          {resume && <div className="resume-review">
            {analysis || analyzing ? <ResumeAnalysis analysis={analysis} analyzing={analyzing} /> : <>
              <button className="resume-review-button" onClick={onAnalyze} disabled={!aiReady || disabled || retryIn > 0}>
                <span>Analyze my resume</span><span>{retryIn > 0 ? retryIn + 's' : '+'}</span>
              </button>
              {!aiReady && <p className="review-hint">Connect your ChatGPT plan for optional resume feedback.</p>}
            </>}
          </div>}
        </div>

        <div className="field-group">
          <div className="field-heading">
            <label className="field-label" htmlFor="job-description"><span className="label-badge">2</span>Job description</label>
            <span className="field-hint">The role you want</span>
          </div>
          <textarea
            id="job-description"
            className="text-area job-text"
            aria-label="Job description"
            placeholder="Paste the job description you’re applying for."
            value={jobDescription}
            disabled={aiBusy}
            onChange={event => setJobDescription(event.target.value)}
            spellCheck={false}
          />
          <div className="field-meta">
            <span>{wordCount(jobDescription)} words</span>
            <button className="clear-btn" onClick={() => setJobDescription('')} disabled={!jobDescription || aiBusy} aria-label="Clear job description">Clear</button>
          </div>
        </div>

        {resume && <div className="resume-length-control">
          <label htmlFor="resume-page-limit">Output length</label>
          <select id="resume-page-limit" value={maxPages} disabled={disabled} onChange={event => setMaxPages(Number(event.target.value))}>
            {Array.from({ length: Math.max(5, Math.min(20, maxPages)) }, (_, index) => index + 1).map(count => <option value={count} key={count}>Up to {count} {count === 1 ? 'page' : 'pages'}</option>)}
          </select>
          <p>{sourcePages ? 'Original PDF: ' + sourcePages + (sourcePages === 1 ? ' page.' : ' pages.') : 'Estimated from your text. Adjust to fit your original.'}</p>
        </div>}
        {typeof children === 'function' ? children(uploading) : children}
      </div>
    </section>
  );
}
