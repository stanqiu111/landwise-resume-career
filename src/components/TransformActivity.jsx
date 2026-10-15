import { useEffect, useState } from 'react';
import './TransformActivity.css';

const tasks = [
  {
    id: 'extraction', name: 'Read', title: 'Reading your story.',
    notes: ['Getting to know your experience, skills, and achievements.', 'Reading what the role is looking for.', 'Gathering the facts that make your experience yours.'],
    detail: 'Your experience + the role',
  },
  {
    id: 'matching', name: 'Match', title: 'Finding the connections.',
    notes: ['Connecting your experience to the job requirements.', 'Looking for strengths you can back up with experience.', 'Separating supported skills from gaps to work on.'],
    detail: 'Strengths that fit',
  },
  {
    id: 'writing', name: 'Build', title: 'Shaping your next chapter.',
    notes: ['Building a tailored draft from your real experience.', 'Putting relevant skills and achievements into focus.', 'Working on clear wording while keeping your story intact.'],
    detail: 'A clearer, tailored draft',
  },
  {
    id: 'checking', name: 'Check', title: 'Giving it a final check.',
    notes: ['Checking that the draft keeps your important details.', 'Checking completeness and numbers against your source.'],
    detail: 'Details worth keeping',
  },
];

const preparation = {
  id: 'connection', title: 'Setting up your workbench.',
  notes: ['Connecting to your ChatGPT account. Your story is up next.'],
};

function TaskIcon({ type }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {type === 'extraction' && <><path d="M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1v14" /><path d="M6 9h3m-3 4h3m6-4h3m-3 4h3" /></>}
    {type === 'matching' && <><rect x="2" y="3" width="7" height="7" rx="2" /><rect x="15" y="14" width="7" height="7" rx="2" /><path d="M9 6h7a3 3 0 0 1 3 3v5M5 10v5a3 3 0 0 0 3 3h7" /></>}
    {type === 'writing' && <><path d="M14 4H5a2 2 0 0 0-2 2v14h15v-8M7 16h5" /><path d="m10 10 9-9 4 4-9 9-5 1 1-5Zm7-7 4 4" /></>}
    {type === 'checking' && <><path d="m12 2 8 3v7c0 5-8 10-8 10S4 17 4 12V5l8-3Z" /><path d="m8 12 3 3 5-6" /></>}
  </svg>;
}

function ActivityNote({ notes }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (notes.length < 2) return;
    const timer = setInterval(() => setIndex(value => (value + 1) % notes.length), 5500);
    return () => clearInterval(timer);
  }, [notes]);
  return <p className="workbench-note" key={index}>{notes[index]}</p>;
}

export default function TransformActivity({ progress }) {
  const [startedAt] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const steps = progress?.steps || [];
  const running = steps.find(step => step.status === 'running');
  // Keep the last real stage visible between server messages. Time alone never
  // advances a task or marks it complete.
  const currentId = running?.id || steps.at(-1)?.id || 'connection';
  const task = currentId === 'shortening'
    ? { ...tasks[2], title: 'Making every line count.', notes: ['Tightening the wording to fit your original page limit.'] }
    : tasks.find(item => item.id === currentId) || preparation;
  const elapsed = Math.floor(Math.max(now - startedAt, progress?.elapsedMs || 0) / 1000);
  const time = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;

  return <section className={`transform-workbench workbench-${task.id}`} aria-label="Resume transformation progress">
    <div className="workbench-topline">
      <span className="workbench-eyebrow"><span aria-hidden="true">✦</span> AI at work</span>
      <span className="workbench-live"><i aria-hidden="true" /> In progress</span>
    </div>

    <div className="workbench-art" aria-hidden="true">
      <div className="workbench-orbit" />
      <div className="workbench-paper">
        <span className="workbench-paper-star">✦</span>
        <div className="workbench-paper-heading" />
        <div className="workbench-paper-line short" />
        <div className="workbench-paper-divider" />
        {[0, 1, 2, 3].map(line => <div className="workbench-paper-line" style={{ '--line': line }} key={line} />)}
        <div className="workbench-paper-divider" />
        <div className="workbench-paper-line" />
        <div className="workbench-paper-line short" />
        <div className="workbench-scan" />
      </div>
      <span className="workbench-float workbench-source"><TaskIcon type="extraction" /> Your experience</span>
      <span className="workbench-float workbench-target"><TaskIcon type={task.id === 'connection' ? 'matching' : task.id} /> {task.id === 'writing' ? 'Finding the words' : task.id === 'checking' ? 'Checking the details' : 'The right fit'}</span>
      <span className="workbench-spark">✧</span>
    </div>

    <div className="workbench-caption">
      <h3 role="status" aria-live="polite" aria-atomic="true">{task.title}</h3>
      <ActivityNote key={task.id} notes={task.notes} />
    </div>

    <ol className="workbench-tasks" aria-label="Transform steps">
      {tasks.map(item => {
        const state = currentId === 'shortening' && item.id === 'writing' ? 'running'
          : currentId === 'shortening' && item.id === 'checking' ? 'pending'
          : steps.find(step => step.id === item.id)?.status || 'pending';
        const label = state === 'completed' ? 'Done' : state === 'running' ? 'Working' : state === 'failed' ? 'Stopped' : 'Up next';
        return <li className={`workbench-task is-${state}`} key={item.id} aria-current={state === 'running' ? 'step' : undefined}>
          <span className="workbench-task-icon"><TaskIcon type={item.id} /></span>
          <div className="workbench-task-copy"><strong>{item.name}</strong><span>{item.detail}</span></div>
          <span className="workbench-task-state"><span aria-hidden="true">{state === 'completed' ? '✓' : state === 'running' ? <span className="workbench-task-pulse" /> : null}</span>{label}</span>
        </li>;
      })}
    </ol>

    <div className="workbench-footer">
      <span><span className="workbench-time">{time}</span> elapsed</span>
      <span>Cancel anytime. Your inputs stay here.</span>
    </div>
  </section>;
}
