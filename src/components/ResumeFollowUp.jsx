import { useId, useRef, useState } from 'react';
import './ResumeFollowUp.css';

const MAX_INSTRUCTION_LENGTH = 2000;
const EXAMPLES = [
  { label: 'Shorten the bullets', instruction: 'Make the longest bullets more concise while keeping the important details and results.' },
  { label: 'Keep the project purpose', instruction: 'Keep the original purpose of each project clear. Only adjust wording that helps explain how my experience fits this role.' },
  { label: 'Make it sound natural', instruction: 'Make the wording sound more natural and like me. Keep it professional, direct, and close to my original experience.' },
];

function revisionKey(revision) {
  return JSON.stringify([revision?.createdAt, revision?.instruction, revision?.reply]);
}

export default function ResumeFollowUp({
  result, onSubmit, busy = false, disabled = false, disabledReason = '',
  retryIn = 0, error = null, progress, onCancel,
}) {
  const id = useId();
  const textareaRef = useRef(null);
  const submittingRef = useRef(false);
  const [instruction, setInstruction] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState('');
  const working = busy || submitting;
  const unavailable = disabled || retryIn > 0;
  const latest = result?.revision;
  const seen = new Set(latest ? [revisionKey(latest)] : []);
  const history = (Array.isArray(result?.revisionHistory) ? result.revisionHistory : []).filter(item => {
    if (!item || (!item.instruction && !item.reply)) return false;
    const key = revisionKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const exchanges = [...history, ...(latest ? [latest] : [])].reverse();
  const activeStep = progress?.steps?.find(step => step.status === 'running');
  const progressLabel = activeStep?.label || 'Updating your draft…';
  const visibleError = error?.message || submissionError;
  const descriptionIds = [`${id}-help`, `${id}-count`, ...(disabledReason ? [`${id}-disabled`] : []), ...(retryIn > 0 ? [`${id}-retry`] : [])].join(' ');

  async function handleSubmit(event) {
    event.preventDefault();
    const request = instruction.trim();
    if (submittingRef.current || working || unavailable || !request || request.length > MAX_INSTRUCTION_LENGTH || !onSubmit) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmissionError('');
    try {
      const success = await onSubmit(request);
      if (success === true) setInstruction('');
    } catch {
      setSubmissionError('Your update could not be completed. Your request is still here. Please try again.');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function chooseExample(value) {
    setInstruction(value);
    setSubmissionError('');
    textareaRef.current?.focus();
  }

  return <section className="resume-follow-up" aria-labelledby={`${id}-title`}>
    <header className="follow-up-header">
      <span className="follow-up-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-3 3V11.5A7.5 7.5 0 0 1 9.5 4H13" /><path d="m17 2 1.2 3.8L22 7l-3.8 1.2L17 12l-1.2-3.8L12 7l3.8-1.2L17 2Z" /></svg>
      </span>
      <div>
        <h3 id={`${id}-title`}>Refine this draft</h3>
        <p>A small change, a different tone, or something we missed? Tell us.</p>
      </div>
    </header>

    {latest?.reply && <div className="follow-up-reply" role="status" aria-live="polite">
      <strong>What changed</strong>
      <p>{latest.reply}</p>
    </div>}

    <form onSubmit={handleSubmit} className="follow-up-form">
      <label htmlFor={`${id}-instruction`}>What would you like to change?</label>
      <p id={`${id}-help`} className="follow-up-help">Tell us which bullet or wording to adjust. Your experience and page limit stay the starting point.</p>
      <div className="follow-up-examples" aria-label="Example requests">
        {EXAMPLES.map(example => <button type="button" key={example.label} disabled={working || disabled} onClick={() => chooseExample(example.instruction)}>{example.label}<span aria-hidden="true"> ↗</span></button>)}
      </div>
      <textarea
        ref={textareaRef}
        id={`${id}-instruction`}
        name="resumeRevisionInstruction"
        value={instruction}
        onChange={event => { setInstruction(event.target.value); setSubmissionError(''); }}
        maxLength={MAX_INSTRUCTION_LENGTH}
        rows={4}
        disabled={working || disabled}
        aria-describedby={descriptionIds}
        placeholder="For example: Keep the purpose of my campus project, but make its second bullet shorter."
      />
      <div className="follow-up-field-meta">
        <p id={`${id}-count`}>{instruction.length.toLocaleString()} / {MAX_INSTRUCTION_LENGTH.toLocaleString()} characters</p>
        <span>Review the updated draft before applying.</span>
      </div>
      {disabledReason && <p id={`${id}-disabled`} className="follow-up-disabled">{disabledReason}</p>}
      {retryIn > 0 && <p id={`${id}-retry`} className="follow-up-disabled">You can try again in {retryIn}s. Your request stays here.</p>}
      {!working && visibleError && <div className="follow-up-error" role="alert">
        <p>{visibleError}</p>
        {error?.manageUsage && <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage ChatGPT usage <span aria-hidden="true">↗</span></a>}
      </div>}
      <div className="follow-up-actions">
        <button className="follow-up-submit" type="submit" disabled={working || unavailable || !instruction.trim() || !onSubmit}>{working ? 'Updating…' : 'Update my resume'}</button>
        {working && onCancel && <button className="follow-up-cancel" type="button" onClick={onCancel}>Cancel update</button>}
        {working && <span className="follow-up-progress" role="status" aria-live="polite"><span aria-hidden="true" />{progressLabel}</span>}
      </div>
    </form>

    {exchanges.length > 0 && <details className="follow-up-history">
      <summary>Revision history <span>({exchanges.length})</span></summary>
      <ol>
        {exchanges.map((exchange, index) => <li key={`${revisionKey(exchange)}-${index}`}>
          <p className="follow-up-history-label">{index === 0 ? 'Latest request' : 'Earlier request'}</p>
          {exchange.instruction && <p className="follow-up-request">{exchange.instruction}</p>}
          {exchange.reply && <p className="follow-up-history-reply">{exchange.reply}</p>}
        </li>)}
      </ol>
    </details>}
  </section>;
}
