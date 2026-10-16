import { mkdir, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

export const APPLICATION_STAGES = ['resume', 'applied', 'interview', 'offer', 'closed'];
const Patch = z.object({ company: z.string().trim().max(160).optional(), roleTitle: z.string().trim().min(1).max(160).optional(),
  stage: z.enum(APPLICATION_STAGES).optional(), notes: z.string().max(12000).optional(),
  practice: z.array(z.object({ id: z.string().max(100), title: z.string().max(1000), done: z.boolean() })).max(100).optional() }).strict();
const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
const fail = (message, status = 400) => Object.assign(new Error(message), { status, code: 'application_error' });
const summary = app => ({ id: app.id, company: app.company, roleTitle: app.roleTitle, stage: app.stage,
  updatedAt: app.updatedAt, createdAt: app.createdAt, versionCount: app.versions.length,
  score: app.versions.at(-1)?.result.matchScore, practiceDone: app.practice.filter(item => item.done).length, practiceTotal: app.practice.length });

// One local operating-system user's library, independent of provider sign-in.
// Sequential atomic writes avoid lost updates from multiple browser tabs.
export function createApplicationStore({ root = join(homedir(), 'Documents', 'Landwise', 'Applications') } = {}) {
  let queue = Promise.resolve();
  async function init() { await mkdir(root, { recursive: true, mode: 0o700 }); }
  function folder(id) { if (!validId(id)) throw fail('Invalid application folder.'); return join(root, id); }
  async function read(id) {
    try { return JSON.parse(await readFile(join(folder(id), 'application.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw fail('This application folder no longer exists.', 404); throw error; }
  }
  async function list() {
    await init();
    const entries = await readdir(root, { withFileTypes: true });
    const apps = [];
    for (const entry of entries) if (entry.isDirectory() && validId(entry.name)) {
      try { apps.push(await read(entry.name)); }
      catch (error) { if (error.status !== 404) throw error; } // Ignore uncommitted folders from an interrupted write.
    }
    return apps.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async function write(app) {
    const dir = folder(app.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, `.${randomUUID()}.tmp`);
    try { await writeFile(temp, JSON.stringify(app, null, 2), { mode: 0o600 }); await rename(temp, join(dir, 'application.json')); }
    finally { await rm(temp, { force: true }); }
  }
  function mutate(operation) { const task = queue.then(operation); queue = task.catch(() => {}); return task; }
  return {
    list: async () => { await queue; return { applications: (await list()).map(summary), folder: root }; },
    get: async id => { await queue; return { ...await read(id), folder: folder(id) }; },
    save: inputs => mutate(async () => {
      const { resume, jobDescription, maxPages, result } = inputs;
      if (typeof resume !== 'string' || !resume.trim() || typeof jobDescription !== 'string' || !jobDescription.trim()
        || typeof result?.transformedResume !== 'string' || !result.transformedResume.trim()) throw fail('A completed resume and job description are required.');
      if (JSON.stringify(inputs).length > 220000) throw fail('This application is too large to save.');
      const key = createHash('sha256').update(jobDescription.trim()).digest('hex');
      const now = new Date().toISOString();
      let app = (await list()).find(item => item.jobKey === key);
      if (!app) app = { id: randomUUID(), jobKey: key, company: String(result.job?.company || '').slice(0, 160),
        roleTitle: String(result.job?.roleTitle || 'Untitled role').slice(0, 160), stage: 'resume', notes: '',
        createdAt: now, updatedAt: now, versions: [], history: [{ at: now, text: 'First resume prepared' }], practice: (result.report?.items || []).filter(item => item.status !== 'included')
          .slice(0, 30).map(item => ({ id: randomUUID(), title: `${item.requirement}: ${item.nextStep}`.slice(0, 1000), done: false })) };
      // Idempotent retry after an interrupted save response; don't duplicate a version.
      const latest = app.versions.at(-1);
      const same = latest && latest.resume === resume && latest.result.transformedResume === result.transformedResume
        && JSON.stringify(latest.result.report) === JSON.stringify(result.report) && latest.maxPages === maxPages;
      const version = same ? latest : { id: randomUUID(), createdAt: now, resume, jobDescription, maxPages, result };
      if (!same) {
        const dir = join(folder(app.id), version.id);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(join(dir, 'original-resume.txt'), resume, { mode: 0o600 });
        await writeFile(join(dir, 'job-description.txt'), jobDescription, { mode: 0o600 });
        await writeFile(join(dir, 'tailored-resume.txt'), result.transformedResume, { mode: 0o600 });
        await writeFile(join(dir, 'report.json'), JSON.stringify(result.report || {}, null, 2), { mode: 0o600 });
        app.versions.push(version);
      }
      app.updatedAt = now;
      await write(app);
      return { ...summary(app), versionId: version.id, folder: folder(app.id) };
    }),
    update: (id, patch) => mutate(async () => {
      const parsed = Patch.safeParse(patch);
      if (!parsed.success) throw fail('Check the company, role, progress and notes before saving.');
      const previous = await read(id);
      const app = { ...previous, ...parsed.data, updatedAt: new Date().toISOString() };
      app.history = [...(previous.history || [])];
      if (app.stage !== previous.stage) app.history.push({ at: app.updatedAt, text: `Progress changed to ${app.stage}` });
      const completed = app.practice.filter(item => item.done).length;
      if (completed !== previous.practice.filter(item => item.done).length) app.history.push({ at: app.updatedAt, text: `${completed} practice tasks completed` });
      await write(app);
      return { ...app, folder: folder(id) };
    }),
    remove: id => mutate(async () => { await read(id); await rm(folder(id), { recursive: true }); return { removed: true }; }),
  };
}
