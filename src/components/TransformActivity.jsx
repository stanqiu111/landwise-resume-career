import { useEffect, useState } from 'react';
import FlapText from './FlapText';
import './TransformActivity.css';

const tasks = [
  {
    id: 'extraction', name: 'Read', title: 'Reading your story',
    notes: ['Getting to know your experience, skills, and achievements.', 'Reading what the role is looking for.', 'Gathering the facts that make your experience yours.'],
    detail: 'Your experience + the role',
  },
  {
    id: 'matching', name: 'Match', title: 'Finding the connections',
    notes: ['Connecting your experience to the job requirements.', 'Looking for strengths you can back up with experience.', 'Separating supported skills from gaps to work on.'],
    detail: 'Strengths that fit',
  },
  {
    id: 'writing', name: 'Build', title: 'Shaping your next chapter',
    notes: ['Building a tailored draft from your real experience.', 'Putting relevant skills and achievements into focus.', 'Working on clear wording while keeping your story intact.'],
    detail: 'A clearer, tailored draft',
  },
  {
    id: 'checking', name: 'Check', title: 'Giving it a final check',
    notes: ['Checking that the draft keeps your important details.', 'Checking completeness and numbers against your source.'],
    detail: 'Details worth keeping',
  },
];

const preparation = {
  id: 'connection', title: 'Preparing for departure',
  notes: ['Connecting to your ChatGPT account. Your story is up next.'],
};

function ActivityNote({ notes }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (notes.length < 2) return;
    const timer = setInterval(() => setIndex(value => (value + 1) % notes.length), 5500);
    return () => clearInterval(timer);
  }, [notes]);
  return <p className="workbench-note" key={index}>{notes[index]}</p>;
}

export default function TransformActivity({ progress, hosted = false }) {
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
    ? { ...tasks[2], title: 'Making every line count', notes: ['Tightening the wording to fit your original page limit.'] }
    : tasks.find(item => item.id === currentId) || (hosted ? { ...preparation, notes: ['Preparing your resume request. Your story is up next.'] } : preparation);
  const elapsed = Math.floor(Math.max(now - startedAt, progress?.elapsedMs || 0) / 1000);
  const time = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  const states = tasks.map(item => currentId === 'shortening' && item.id === 'writing' ? 'running'
    : currentId === 'shortening' && item.id === 'checking' ? 'pending'
    : steps.find(step => step.id === item.id)?.status || 'pending');
  const runningIndex = states.indexOf('running');
  const doneCount = states.filter(state => state === 'completed').length;
  // The train waits before the first station until work starts, then sits at the active station.
  const trainAt = runningIndex >= 0 ? runningIndex : Math.min(doneCount, tasks.length - 1);

  return <section className={`transform-workbench workbench-${task.id}`} aria-label="Resume transformation progress">
    <div className="workbench-topline">
      <span className="workbench-eyebrow">Now boarding · AI at work</span>
      <span className="workbench-live"><i aria-hidden="true" /> <span className="workbench-time">{time}</span></span>
    </div>

    <h3 className="workbench-title" role="status" aria-live="polite" aria-atomic="true"><FlapText text={task.title} key={task.title} /></h3>
    <ActivityNote key={task.id} notes={task.notes} />

    <div className="workbench-route" aria-hidden="true" style={{ '--train': trainAt, '--stops': tasks.length }}>
      <span className="workbench-line" />
      {tasks.map((item, index) => <span className={`workbench-stop is-${states[index]}`} key={item.id}><i />{item.name}</span>)}
      <span className={`workbench-train${task.id === 'connection' ? ' is-waiting' : ''}`} />
    </div>

    <ol className="workbench-tasks" aria-label="Transform steps">
      {tasks.map((item, index) => {
        const state = states[index];
        const label = state === 'completed' ? 'Done' : state === 'running' ? 'Working' : state === 'failed' ? 'Stopped' : 'Up next';
        return <li className={`workbench-task is-${state}`} key={item.id} aria-current={state === 'running' ? 'step' : undefined}>
          <span className="workbench-task-code">{String(index + 1).padStart(2, '0')}</span>
          <div className="workbench-task-copy"><strong>{item.name}</strong><span>{item.detail}</span></div>
          <span className="workbench-task-state">{label}</span>
        </li>;
      })}
    </ol>

    <div className="workbench-footer">
      <span>{time} elapsed</span>
      <span>Cancel anytime. Your inputs stay here.</span>
    </div>
  </section>;
}
