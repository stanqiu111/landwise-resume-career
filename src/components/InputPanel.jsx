import { useState, useRef } from 'react';
import ResumeAnalysis from './ResumeAnalysis';

export default function InputPanel({ resume, setResume, jobDescription, setJobDescription, analysis, analyzing }) {
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
      setResume(data.text);
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

        {!resume ? (
          <div
            className={`drop-zone${dragging ? ' drag-over' : ''}${uploading ? ' uploading' : ''}`}
            onClick={() => fileInputRef.current?.click()}
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
                <span className="drop-icon">📄</span>
                <span className="drop-text">Click to upload or drag & drop</span>
                <span className="drop-hint">PDF only · max 10 MB</span>
              </>
            )}
          </div>
        ) : (
          <div className="resume-preview-wrap">
            <div className="resume-preview-bar">
              <span className="file-name">✓ {fileName || 'Resume loaded'}</span>
              <button className="clear-btn" onClick={clearResume}>✕ Remove</button>
            </div>
            <textarea
              className="text-area resume-text"
              value={resume}
              onChange={(e) => setResume(e.target.value)}
              spellCheck={false}
            />
            <div className="char-count">{resume.length} chars — you can edit the text above</div>
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
