import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkExistingHooks, privateFile, safeFindings, snapshotSource, verifyArchive } from '../scripts/secret-scan.mjs';

async function fixture(t, withGit = true) {
  const directory = await mkdtemp(path.join(tmpdir(), 'landwise-security-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  const output = path.join(directory, 'snapshot');
  await mkdir(source);
  await mkdir(output);
  if (withGit) execFileSync('git', ['init', '--quiet'], { cwd: source });
  return { source, output };
}

test('private exports and credential paths are blocked while code and safe examples are allowed', () => {
  for (const filename of ['.env', '.env.local', 'server/.env.production', 'Private/report.txt', 'backups/data.sql',
    '.auth/session.json', 'chatgpt.json', '.chatgpt-session.tmp', 'credentials.json', 'secrets.json', '.netrc',
    '.npmrc', 'id_ed25519', 'server.pem', 'resume.pdf', 'Resume.DOCX', 'data.sqlite3', 'test-results/result.png']) {
    assert.equal(privateFile(filename), true, filename);
  }
  for (const filename of ['.env.example', 'server/chatgpt-auth.js', 'tests/fixtures/resumes.js',
    'supabase/migrations/202610170002_landwise_ai_budget.sql', 'scripts/secret-scan.mjs', 'docs/SUPABASE.md']) {
    assert.equal(privateFile(filename), false, filename);
  }
});

test('commit scan reads the staged version, including spaces, rather than a cleaned working copy', async t => {
  const { source, output } = await fixture(t);
  const filename = 'sample settings.txt';
  await writeFile(path.join(source, filename), 'staged content');
  execFileSync('git', ['add', '--', filename], { cwd: source });
  await writeFile(path.join(source, filename), 'unstaged replacement');
  assert.equal(await snapshotSource(source, output, true), 1);
  assert.equal(await readFile(path.join(output, filename), 'utf8'), 'staged content');
});

test('ignored local secrets stay out of source scans but force-added secrets block commits', async t => {
  const { source, output } = await fixture(t);
  await writeFile(path.join(source, '.gitignore'), '.env\n');
  await writeFile(path.join(source, '.env'), 'synthetic private content');
  await writeFile(path.join(source, 'source.js'), 'export const safe = true;');
  execFileSync('git', ['add', '.gitignore', 'source.js'], { cwd: source });
  assert.equal(await snapshotSource(source, output), 2);
  await assert.rejects(readFile(path.join(output, '.env')), { code: 'ENOENT' });
  execFileSync('git', ['add', '--force', '.env'], { cwd: source });
  await assert.rejects(snapshotSource(source, output, true), /Private file must stay outside Git/);
});

test('source scans include untracked non-ignored files', async t => {
  const { source, output } = await fixture(t);
  await writeFile(path.join(source, 'new.js'), 'untracked content');
  assert.equal(await snapshotSource(source, output), 1);
  assert.equal(await readFile(path.join(output, 'new.js'), 'utf8'), 'untracked content');
});

test('deployment source without Git is scanned and private files are rejected', async t => {
  const { source, output } = await fixture(t, false);
  await writeFile(path.join(source, 'source.js'), 'safe source');
  await mkdir(path.join(source, 'node_modules'));
  await writeFile(path.join(source, 'node_modules', 'ignored.js'), 'dependency');
  assert.equal(await snapshotSource(source, output), 1);
  await writeFile(path.join(source, '.env'), 'private');
  await assert.rejects(snapshotSource(source, output), /Private file must stay outside Git/);
  await assert.rejects(snapshotSource(source, output, true), /requires a Git checkout/);
});

test('symlinks cannot copy a credential file into the scan or publication', async t => {
  const { source, output } = await fixture(t);
  await symlink('/outside-private-file', path.join(source, 'innocent.txt'));
  execFileSync('git', ['add', 'innocent.txt'], { cwd: source });
  await assert.rejects(snapshotSource(source, output), /Symlinks and submodules/);
  await assert.rejects(snapshotSource(source, output, true), /Symlinks and submodules/);
});

test('a tampered scanner archive is never accepted', () => {
  assert.throws(() => verifyArchive(Buffer.from('tampered binary'), '0'.repeat(64)), /checksum mismatch/);
});

test('installing guards does not bypass existing hooks or configured hook directories', async t => {
  const { source } = await fixture(t);
  await writeFile(path.join(source, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
  await assert.rejects(checkExistingHooks(source), /Existing Git hooks/);
  await rm(path.join(source, '.git', 'hooks', 'pre-commit'));
  execFileSync('git', ['config', 'core.hooksPath', 'custom-hooks'], { cwd: source });
  await assert.rejects(checkExistingHooks(source), /Existing Git hooks/);
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: source });
  await checkExistingHooks(source);
});

test('reported findings contain only location and rule, never secrets or source snippets', () => {
  const findings = [{ File: 'source.js', StartLine: 4, RuleID: 'example', Secret: 'must-not-print', Match: 'private source', Author: 'private name', Email: 'private email' }];
  assert.deepEqual(safeFindings(findings), ['source.js:4 (example)']);
});
