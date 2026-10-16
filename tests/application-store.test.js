import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplicationStore } from '../server/application-store.js';
import { studentResume } from './fixtures/resumes.js';

const inputs = { resume: studentResume, jobDescription: 'Northstar is hiring a frontend engineer to build React dashboards.', maxPages: 1,
  result: { transformedResume: studentResume, matchScore: 60, job: { company: 'Northstar', roleTitle: 'Frontend engineer' },
    report: { items: [{ id: 'r1', requirement: 'Cloud', status: 'learn', nextStep: 'Build a deployment demo.' }] } } };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'landwise-applications-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: createApplicationStore({ root }) };
}

test('applications survive a new store instance with exact original, JD, report and readable folder files', async t => {
  const { root, store } = await fixture(t);
  const saved = await store.save(inputs);
  const reloaded = await createApplicationStore({ root }).get(saved.id);
  assert.equal(reloaded.versions[0].resume, studentResume);
  assert.equal(reloaded.versions[0].jobDescription, inputs.jobDescription);
  assert.equal(reloaded.versions[0].result.matchScore, 60);
  assert.equal(await readFile(join(saved.folder, saved.versionId, 'tailored-resume.txt'), 'utf8'), studentResume);
  assert.equal((await stat(join(saved.folder, 'application.json'))).mode & 0o777, 0o600);
  assert.equal(reloaded.practice.length, 1);
  assert.equal((await store.list()).applications[0].versionCount, 1);
});

test('repeat save is idempotent while changed versions keep all originals and prior progress', async t => {
  const { store } = await fixture(t);
  const first = await store.save(inputs);
  await store.update(first.id, { stage: 'interview', notes: 'Prepare component design examples.' });
  const repeat = await store.save(inputs);
  assert.equal(repeat.versionCount, 1);
  const next = await store.save({ ...inputs, result: { ...inputs.result, transformedResume: studentResume.replace('Built React', 'Developed React') } });
  assert.equal(next.id, first.id);
  assert.equal(next.versionCount, 2);
  const app = await store.get(first.id);
  assert.equal(app.stage, 'interview');
  assert.equal(app.notes, 'Prepare component design examples.');
  assert.equal(app.versions[0].result.transformedResume, studentResume);
  assert.match(app.history.at(-1).text, /interview/);
  const other = await store.save({ ...inputs, jobDescription: `${inputs.jobDescription} Another location.` });
  assert.notEqual(other.id, first.id);
});

test('concurrent saves keep distinct versions; practice and names update without touching snapshots', async t => {
  const { store } = await fixture(t);
  const results = await Promise.all([store.save(inputs), store.save({ ...inputs, result: { ...inputs.result, transformedResume: studentResume + '\nAdditional source detail.' } })]);
  assert.equal(results[0].id, results[1].id);
  const app = await store.get(results[0].id);
  const changed = await store.update(app.id, { company: 'Northstar Canada', practice: app.practice.map(item => ({ ...item, done: true })) });
  assert.equal(changed.versions.length, 2);
  assert.equal(changed.practice[0].done, true);
  assert.equal(changed.versions[0].result.job.company, 'Northstar');
  assert.match(changed.history.at(-1).text, /1 practice/);
});

test('invalid paths and patches are rejected; deletion removes only the selected folder', async t => {
  const { root, store } = await fixture(t);
  const saved = await store.save(inputs);
  await assert.rejects(store.get('../outside'));
  await assert.rejects(store.update(saved.id, { stage: 'made-up' }));
  await assert.rejects(store.update(saved.id, { versions: [] }));
  await assert.rejects(store.save({ resume: studentResume }));
  await writeFile(join(root, 'keep.txt'), 'unrelated');
  await store.remove(saved.id);
  assert.equal((await store.list()).applications.length, 0);
  assert.equal(await readFile(join(root, 'keep.txt'), 'utf8'), 'unrelated');
  await assert.rejects(store.get(saved.id), error => error.status === 404);
});
