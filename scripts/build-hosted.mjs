import { build } from 'vite';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

process.env.VITE_LANDWISE_HOSTED = 'true';
await build({ build: { outDir: 'dist-hosted', emptyOutDir: true, sourcemap: false } });

// No private server credentials or local account files may reach a browser.
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await inspect(filename);
    else if (/\.(?:html|js|css|svg)$/.test(entry.name)) {
      const source = await readFile(filename, 'utf8');
      for (const value of ['/api/auth/', 'SUPABASE_SERVICE_ROLE_KEY', 'Supabase_Key', 'OPENAI_API_KEY', 'chatgpt.json']) {
        if (source.includes(value)) throw new Error(`Server credential reference in hosted output: ${filename}`);
      }
      if (/(?:sb_secret_|sk-(?:proj|svcacct)-)[A-Za-z0-9_-]{20,}/.test(source)) throw new Error(`Secret-shaped value in hosted output: ${filename}`);
      // Self-hosted fonts are binary files from the font packages; the CSP only allows fonts from this site.
    } else if (!/\.woff2?$/.test(entry.name)) throw new Error(`Unexpected hosted build file: ${filename}`);
  }
}
await inspect('dist-hosted');
console.log('Hosted build verified: no server credentials or local account files.');
