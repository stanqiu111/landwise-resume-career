import { lstat, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const generated = ['dist', 'dist-hosted', 'dist-public', 'dist-ssr', '.vercel/output', '.vercel/node', '.vercel/static-build'];
const vercel = await lstat(new URL('.vercel', root)).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});
for (const name of generated) {
  // Never traverse an externally linked configuration directory.
  if (name.startsWith('.vercel/') && vercel?.isSymbolicLink()) continue;
  await rm(new URL(name, root), { recursive: true, force: true });
  console.info(`Cleaned ${fileURLToPath(new URL(name, root))}`);
}
console.info('Kept environment files, Vercel project link, dependencies, credentials and application data.');
