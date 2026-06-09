import { useState, useEffect, useRef } from 'react';
import InputPanel from './components/InputPanel';
import OutputPanel from './components/OutputPanel';
import './App.css';

const LOADING_PHASES = [
  'Analyzing job description...',
  'Extracting key requirements...',
  'Tailoring your resume...',
  'Optimizing keywords...',
  'Finalizing...',
];

export default function App() {
  const [resume, setResumeRaw] = useState('');
  const [jobDescription, setJobDescription] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingPhase, setLoadingPhase] = useState(0);
  const [toast, setToast] = useState('');
  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const analyzeTimerRef = useRef(null);
  const lastAnalyzedRef = useRef('');

  // Wrap the raw setter so clearing the resume also resets analysis immediately,
  // avoiding a setState call inside the useEffect below.
  function setResume(text) {
    setResumeRaw(text);
    if (!text.trim()) {
      clearTimeout(analyzeTimerRef.current);
      setAnalysis(null);
      lastAnalyzedRef.current = '';
    }
  }

  useEffect(() => {
    if (!resume.trim()) return;
    if (resume === lastAnalyzedRef.current) return;
    clearTimeout(analyzeTimerRef.current);
    analyzeTimerRef.current = setTimeout(async () => {
      lastAnalyzedRef.current = resume;
      setAnalyzing(true);
      try {
        const res = await fetch('/api/analyze-resume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resume }),
        });
        const data = await res.json();
        if (res.ok) setAnalysis(data);
      } catch { /* silent */ } finally {
        setAnalyzing(false);
      }
    }, 800);
    return () => clearTimeout(analyzeTimerRef.current);
  }, [resume]);

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(''), 5000);
  }

  async function handleTransform() {
    if (!resume.trim()) { showToast('Please upload or paste your resume first.'); return; }
    if (!jobDescription.trim()) { showToast('Please fill out the job description.'); return; }
    setToast('');
    setLoading(true);
    setResult(null);
    setLoadingPhase(0);

    const phaseTimer = setInterval(() => {
      setLoadingPhase(p => Math.min(p + 1, LOADING_PHASES.length - 1));
    }, 3500);

    try {
      const res = await fetch('/api/transform', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resume, jobDescription }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      setResult(data);
    } catch (err) {
      showToast(err.message);
    } finally {
      clearInterval(phaseTimer);
      setLoading(false);
    }
  }

  return (
    <div className="app">
      {toast && (
        <div className="toast">
          <span>{toast}</span>
          <button className="toast-close" onClick={() => setToast('')}>✕</button>
        </div>
      )}

      <header className="app-header">
        <div className="header-left">
          <div className="header-logo">✦</div>
          <div className="header-title-wrap">
            <h1>Landwise</h1>
            <span className="header-sub">Land the job, wisely.</span>
          </div>
        </div>
      </header>

      <main className="app-main">
        <div className="panels">
          <InputPanel
            resume={resume}
            setResume={setResume}
            jobDescription={jobDescription}
            setJobDescription={setJobDescription}
            analysis={analysis}
            analyzing={analyzing}
          />

          <div className="transform-center">
            <div className="divider-line" />
            <button
              className={`transform-btn${loading ? ' loading' : ''}`}
              onClick={handleTransform}
              disabled={loading}
            >
              {loading ? (
                <><span className="spinner" /> Transforming...</>
              ) : (
                '✦ Transform'
              )}
            </button>
            <div className="divider-line" />
          </div>

          <OutputPanel
            result={result}
            loading={loading}
            loadingPhase={LOADING_PHASES[loadingPhase]}
          />
        </div>
      </main>
    </div>
  );
}
