import { useEffect, useState } from 'react';
import { applicationRequest } from '../applicationApi';
import OutputPanel from './OutputPanel';
import './Applications.css';

const STAGES = [['resume', 'Resume ready'], ['applied', 'Applied'], ['interview', 'Interview'], ['offer', 'Offer'], ['closed', 'Closed']];
const date = value => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function ApplicationDetail({ application, onUpdate, onRestore, onRemove, busy }) {
  const [company, setCompany] = useState(application.company);
  const [roleTitle, setRoleTitle] = useState(application.roleTitle);
  const [stage, setStage] = useState(application.stage);
  const [notes, setNotes] = useState(application.notes);
  const [practice, setPractice] = useState(application.practice);
  const [newTask, setNewTask] = useState('');
  const [versionId, setVersionId] = useState(application.versions.at(-1).id);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const version = application.versions.find(item => item.id === versionId) || application.versions.at(-1);
  function addTask() {
    if (!newTask.trim() || practice.length >= 100) return;
    setPractice([...practice, { id: crypto.randomUUID(), title: newTask.trim(), done: false }]); setNewTask('');
  }
  return <div className="application-detail">
    <form className="application-card" onSubmit={event => { event.preventDefault(); onUpdate({ company, roleTitle, stage, notes, practice }); }}>
      <div className="application-fields">
        <label>Company<input maxLength={160} value={company} placeholder="Company not named in the job description" onChange={e => setCompany(e.target.value)} /></label>
        <label>Role<input required maxLength={160} value={roleTitle} onChange={e => setRoleTitle(e.target.value)} /></label>
        <label>Application progress<select value={stage} onChange={e => setStage(e.target.value)}>{STAGES.map(([value, text]) => <option value={value} key={value}>{text}</option>)}</select></label>
      </div>
      <label className="application-notes">Interview & application notes<textarea maxLength={12000} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Interview dates, recruiter feedback, what to practise next…" /></label>
      <div className="application-practice">
        <h3>Learning & coding practice</h3>
        <p>Start with the gaps from your first fit report. Update this list as you prepare.</p>
        {practice.map(item => <div className="practice-task" key={item.id}><label className="practice-task-label"><input type="checkbox" checked={item.done} onChange={e => setPractice(practice.map(task => task.id === item.id ? { ...task, done: e.target.checked } : task))} /><span>{item.title}</span></label><button type="button" aria-label={`Remove task: ${item.title}`} onClick={() => setPractice(practice.filter(task => task.id !== item.id))}>×</button></div>)}
        <div className="practice-add"><input aria-label="New practice task" value={newTask} maxLength={1000} placeholder="Add an interview or coding exercise" onChange={e => setNewTask(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTask(); } }} /><button type="button" onClick={addTask} disabled={!newTask.trim() || practice.length >= 100}>Add task</button></div>
      </div>
      <div className="application-controls"><button className="application-primary" disabled={busy}>Save progress</button><span>Changes to notes and tasks are saved when you click Save progress.</span></div>
      {application.history?.length > 0 && <details className="application-history"><summary>Progress history</summary><ul>{application.history.slice().reverse().map((entry, i) => <li key={i}>{date(entry.at)} · {entry.text}</li>)}</ul></details>}
    </form>
    <div className="application-card application-version">
      <label>Saved version<select value={versionId} onChange={e => setVersionId(e.target.value)}>{application.versions.map((item, index) => <option key={item.id} value={item.id}>Version {index + 1} · {date(item.createdAt)} · {item.result.matchScore ?? '—'}/100</option>)}</select></label>
      <button onClick={() => onRestore(version)} disabled={busy}>Open original & job in studio</button>
      <details><summary>Saved job description</summary><pre>{version.jobDescription}</pre></details>
      <details><summary>Original resume</summary><pre>{version.resume}</pre></details>
    </div>
    <OutputPanel key={version.id} result={{ ...version.result, savedApplication: { id: application.id } }}>
      <div className="saved-follow-up"><h3>Want to refine this version?</h3><p>Open this draft in the studio to ask AI for small changes. Your original resume and saved versions stay together.</p><button onClick={() => onRestore(version)} disabled={busy}>Refine this saved draft</button></div>
    </OutputPanel>
    <div className="application-folder"><p>Local folder: <code>{application.folder}</code></p><p>Stored on this computer for your local user. No cloud sync. Export PDF or Word from the saved version above.</p>
      {confirmDelete ? <div role="alert"><p>Delete this application folder, all saved versions and progress?</p><button className="application-delete" disabled={busy} onClick={onRemove}>Delete folder</button><button onClick={() => setConfirmDelete(false)}>Keep it</button></div>
        : <button onClick={() => setConfirmDelete(true)}>Delete application…</button>}
    </div>
  </div>;
}

export default function Applications({ active, selectedId, csrfToken, revision, onRestore, onNotify }) {
  const [library, setLibrary] = useState({ applications: [], folder: '' });
  const [detail, setDetail] = useState(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!active || !csrfToken) return;
    let cancelled = false;
    async function load() {
      setLoading(true); setError('');
      try {
        const [list, app] = await Promise.all([applicationRequest('list', {}, csrfToken), selectedId ? applicationRequest('get', { id: selectedId }, csrfToken) : null]);
        if (!cancelled) { setLibrary(list); setDetail(app); }
      } catch (failure) { if (!cancelled) setError(failure.message); }
      finally { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [active, csrfToken, selectedId, revision, refresh]);
  async function update(patch) {
    setBusy(true); setError('');
    try { const app = await applicationRequest('update', { id: detail.id, patch }, csrfToken); setDetail(app); setRefresh(value => value + 1); onNotify('Application progress saved.'); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setError('');
    try { await applicationRequest('remove', { id: detail.id }, csrfToken); setDetail(null); window.location.hash = '#applications'; setRefresh(value => value + 1); onNotify('Application folder deleted.'); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  const visible = library.applications.filter(app => `${app.company} ${app.roleTitle}`.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || app.stage === filter));
  return <div className="applications-page">
    <div className="studio-hero"><div><p className="studio-eyebrow">From resume to your next step</p><h1>My applications</h1><p className="studio-description">Your drafts, fit reports and preparation, organized by company and role. Saved on this computer.</p></div><a className="application-button" href="#resume">Tailor a resume</a></div>
    {error && <div className="application-error" role="alert">{error}<button onClick={() => setRefresh(value => value + 1)}>Retry</button></div>}
    {selectedId && <a className="application-back" href="#applications">← All applications</a>}
    {loading || !csrfToken ? <p role="status">Opening application folders…</p> : selectedId ? detail?.id === selectedId && <ApplicationDetail key={detail.id} application={detail} busy={busy} onUpdate={update} onRemove={remove} onRestore={onRestore} /> : <>
      <div className="application-filters"><input aria-label="Search applications" placeholder="Search company or role" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="Filter by application progress" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All stages</option>{STAGES.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select><span>{visible.length} {visible.length === 1 ? 'application' : 'applications'}</span></div>
      <div className="application-grid">{visible.map(app => <a className="application-card application-tile" href={`#applications/${app.id}`} key={app.id}><span className="application-company">{app.company || 'Company not specified'}</span><h2>{app.roleTitle}</h2><span className="application-stage">{STAGES.find(([value]) => value === app.stage)?.[1]}</span><div className="application-stats"><strong>{app.score ?? '—'}<small>/100 match</small></strong><span>{app.versionCount} saved {app.versionCount === 1 ? 'version' : 'versions'}<br />{app.practiceDone}/{app.practiceTotal} practice tasks</span></div><p>Updated {date(app.updatedAt)} <span className="application-button">Open folder</span></p></a>)}</div>
      {!visible.length && <div className="application-card application-empty"><h2>{library.applications.length ? 'No matching applications' : 'Your next opportunity starts here'}</h2><p>{library.applications.length ? 'Try a different search or stage.' : 'Tailor a resume to create your first folder. The original, job description, draft and fit report will stay together here.'}</p><a href="#resume">Go to resume studio ↗</a></div>}
      {library.folder && <p className="application-folder">Saved in <code>{library.folder}</code></p>}
    </>}
  </div>;
}
