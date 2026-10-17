import { build } from 'vite';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Public hosting must never bundle the local single-user AI/account workspace.
process.env.VITE_LANDWISE_PUBLIC_PREVIEW = 'true';
await build({ build: { outDir: 'dist-public', emptyOutDir: true, sourcemap: false } });

const htmlPath = 'dist-public/index.html';
const html = await readFile(htmlPath, 'utf8');
await writeFile(htmlPath, html
  .replace(/<title>.*?<\/title>/, '<title>Landwise — Career events &amp; your next opportunity</title>')
  .replace(/(<meta\s+name="description"\s+content=")[^"]*(")/, '$1Explore student career fairs and public hiring events in Canada and the United States. Free to browse, no signup. Resume tailoring is coming soon.$2'));

const forbidden = [
  '/api/auth/', '/api/transform', '/api/storage/', '/api/applications',
  'sb_publishable_', 'sb_secret_', 'supabase.co', 'chatgpt.json',
];
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await inspect(filename);
    else {
      if (!/\.(?:html|js|css|svg)$/.test(entry.name)) {
        throw new Error(`Unexpected public build file: ${filename}`);
      }
      const source = await readFile(filename, 'utf8');
      for (const value of forbidden) {
        if (source.includes(value)) throw new Error(`Private workspace reference in ${filename}: ${value}`);
      }
    }
  }
}
await inspect('dist-public');
console.log('Public build verified: no local AI/account routes or Supabase configuration.');
