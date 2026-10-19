import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = '8.30.1';
// Official release checksums. Update version and checksums together after review.
const checksums = {
  darwin_arm64: 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5',
  darwin_x64: 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709',
  linux_arm64: 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080',
  linux_x64: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
};
const generated = new Set(['.git', '.vercel', 'node_modules', 'dist', 'dist-hosted', 'dist-public', 'dist-ssr']);

export function privateFile(filename) {
  const parts = filename.replaceAll('\\', '/').split('/');
  const basename = parts.at(-1).toLowerCase();
  return parts.some(part => /^(?:private|secrets|backups|uploads|exports|\.auth|playwright-report|test-results)$/i.test(part))
    || (basename !== '.env.example' && /^\.env(?:\.|$)/.test(basename))
    || /^(?:chatgpt(?:\.json|\.json\..*)|\.chatgpt-.*\.tmp|credentials(?:\..*)?|secrets?\.json|\.npmrc|\.netrc|\.pypirc|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?)$/.test(basename)
    || /\.(?:pem|key|p12|pfx|jks|keystore|pdf|docx|sqlite3?|db|dump|bak)$/.test(basename);
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

async function listWithoutGit(directory, relative = '') {
  const files = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    if (generated.has(entry.name)) continue;
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await listWithoutGit(directory, name));
    else files.push(name);
  }
  return files;
}

// Snapshot the index for commits, rather than reading unstaged replacements.
// In a deployment without .git, inspect the supplied source tree instead.
export async function snapshotSource(directory, destination, staged = false) {
  const inGit = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: directory, encoding: 'utf8' });
  const hasGit = inGit.status === 0 && await realpath(inGit.stdout.trim()) === await realpath(directory);
  if (staged && !hasGit) throw new Error('A staged scan requires a Git checkout.');
  const entries = staged
    ? git(['ls-files', '--stage', '-z'], directory).split('\0').filter(Boolean).map(line => {
      const match = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(line);
      if (!match || match[3] !== '0') throw new Error('Resolve the Git index conflict before scanning.');
      return { mode: match[1], oid: match[2], name: match[4] };
    })
    : (hasGit ? git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], directory).split('\0').filter(Boolean)
      : await listWithoutGit(directory)).map(name => ({ name }));
  let count = 0;
  for (const entry of entries) {
    if (privateFile(entry.name)) throw new Error(`Private file must stay outside Git: ${JSON.stringify(entry.name)}`);
    if (entry.name.split('/').some(part => part === '..') || path.isAbsolute(entry.name)) throw new Error('Unsafe source path.');
    const source = path.join(directory, entry.name);
    const target = path.join(destination, entry.name);
    if (staged) {
      if (!['100644', '100755'].includes(entry.mode)) throw new Error('Symlinks and submodules require a separate security review.');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, execFileSync('git', ['cat-file', 'blob', entry.oid], { cwd: directory, maxBuffer: 32 * 1024 * 1024 }), { mode: 0o600 });
    } else {
      const stat = await lstat(source).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!stat) continue; // A tracked file intentionally deleted from the worktree.
      if (!stat.isFile()) throw new Error('Symlinks and submodules require a separate security review.');
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
      await chmod(target, 0o600);
    }
    count += 1;
  }
  if (!count) throw new Error('No source files were scanned.');
  return count;
}

export function verifyArchive(bytes, expected) {
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Gitleaks checksum mismatch; refusing to execute.');
}

async function scanner() {
  const platform = `${process.platform}_${process.arch}`;
  if (!checksums[platform]) throw new Error('Secret scanning supports macOS/Linux arm64/x64; use WSL on Windows.');
  const cache = path.join(homedir(), '.cache', 'landwise-security', `${version}-${platform}`);
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const archive = path.join(cache, 'release.tar.gz');
  let bytes;
  try { bytes = await readFile(archive); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const url = `https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_${platform}.tar.gz`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error('Cannot download the pinned Gitleaks release; scan did not run.', { cause: error });
    bytes = Buffer.from(await response.arrayBuffer());
    verifyArchive(bytes, checksums[platform]);
    await writeFile(archive, bytes, { mode: 0o600 });
  }
  verifyArchive(bytes, checksums[platform]);
  // Re-extract the verified archive; do not trust a cached executable alone.
  const directory = await mkdtemp(path.join(cache, 'run-'));
  try {
    execFileSync('tar', ['-xzf', archive, '-C', directory, 'gitleaks'], { stdio: 'pipe' });
    await chmod(path.join(directory, 'gitleaks'), 0o700);
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function safeFindings(findings) {
  return findings.map(item => `${item.File}:${item.StartLine} (${item.RuleID})`);
}

export async function checkExistingHooks(directory) {
  const current = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: directory, encoding: 'utf8' });
  if (current.status !== 0 && current.status !== 1) throw new Error('Cannot inspect existing Git hooks.');
  if (current.stdout.trim()) {
    if (current.stdout.trim() !== '.githooks') throw new Error('Existing Git hooks found; integrate the two Landwise hooks manually.');
    return;
  }
  for (const name of ['pre-commit', 'pre-push']) {
    const hook = git(['rev-parse', '--git-path', `hooks/${name}`], directory).trim();
    const existing = await lstat(path.resolve(directory, hook)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (existing) throw new Error('Existing Git hooks found; integrate the two Landwise hooks manually.');
  }
}

async function main() {
  const mode = process.argv[2] || '--source';
  if (process.argv.length > 3 || !['--source', '--staged', '--history', '--setup'].includes(mode)) throw new Error('Unknown secret-scan mode.');
  if (mode === '--setup') {
    await checkExistingHooks(root);
  }
  const temporary = await mkdtemp(path.join(tmpdir(), 'landwise-scan-'));
  let executable;
  try {
    const snapshot = path.join(temporary, 'source');
    await mkdir(snapshot);
    if (mode !== '--history') await snapshotSource(root, snapshot, mode === '--staged');
    else {
      const names = git(['log', '--all', '--format=', '--name-only', '-z'], root).split('\0').map(name => name.replace(/^\n+/, '')).filter(Boolean);
      if (names.some(privateFile)) throw new Error('Private file paths exist in Git history; review before publishing.');
    }
    executable = await scanner();
    const report = path.join(temporary, 'report.json');
    const args = mode === '--history' ? ['git', '--log-opts=--all', root] : ['dir', snapshot];
    args.push('--config', path.join(root, '.gitleaks.toml'), '--gitleaks-ignore-path', temporary,
      '--ignore-gitleaks-allow', '--redact=100', '--no-banner', '--no-color', '--log-level=error',
      '--max-archive-depth=2', '--report-format=json', '--report-path', report, '--timeout=120');
    const result = spawnSync(path.join(executable, 'gitleaks'), args, { cwd: root, encoding: 'utf8', timeout: 130_000 });
    const findings = JSON.parse(await readFile(report, 'utf8').catch(() => '[]'));
    if (findings.length) throw new Error(`Possible secrets found (values withheld):\n${safeFindings(findings).join('\n')}`);
    if (result.status !== 0) throw new Error('Gitleaks could not complete; scan failed closed.');
    if (mode === '--setup') {
      git(['config', '--local', 'core.hooksPath', '.githooks'], root);
      console.log('Installed local commit and push guards. Run security:setup in every new clone.');
    }
    console.log(`Secret scan passed (${mode.slice(2)}, Gitleaks ${version}).`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
    if (executable) await rm(executable, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Never forward scanner stderr, source snippets, environment values or tokens.
    console.error(error.message.startsWith('Command failed') ? 'Secret scan tooling failed; no source contents printed.' : error.message);
    process.exitCode = 1;
  });
}
