// Recaptures the README screenshots in docs/images from an invented demo run.
// The real hosted frontend runs against a stand-in API on loopback, so no AI
// provider or account is called. Needs Google Chrome or Chromium in a usual
// install location, or CHROME_PATH. Pass a directory to write elsewhere.
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { job, result, resume } from './readme-demo.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(root, process.argv[2] || 'docs/images');
const { env } = process;
const chromePath = env.CHROME_PATH || ({
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
  win32: [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(Boolean).map(base => path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe')),
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
}[process.platform] || []).find(candidate => existsSync(candidate));
if (!chromePath) throw new Error('Could not find Chrome or Chromium. Set CHROME_PATH to the browser binary.');
// Career events are sorted from downtown Toronto, where the demo student lives.
const TORONTO = { latitude: 43.6532, longitude: -79.3832, accuracy: 100 };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Answers only what the guest studio needs. Transform holds on Build until the
// progress screenshot is taken; elapsed times are fixed so the board reads alike each run.
function mockApi() {
  let release;
  const buildHeld = new Promise(resolve => { release = resolve; });
  const server = http.createServer(async (req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    if (pathname === '/api/storage/config') return json(200, { storage: 'unavailable', mode: 'hosted', signInEnabled: false });
    if (pathname === '/api/session') return json(200, { mode: 'hosted', csrfToken: 'demo', authenticated: false, available: true, guestEligible: true, remaining: 14, limit: 15 });
    if (pathname !== '/api/transform' || req.method !== 'POST') return json(404, { error: 'Not part of the screenshot demo.' });
    req.resume();
    await new Promise(resolve => req.once('end', resolve));
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const send = event => res.write(`${JSON.stringify(event)}\n`);
    const done = (id, elapsedMs) => ({ id, status: 'completed', elapsedMs });
    const running = (id, elapsedMs = 0) => ({ id, status: 'running', elapsedMs });
    const read = done('extraction', 9200), match = done('matching', 10200), build = done('writing', 11600);
    send({ type: 'progress', elapsedMs: 800, steps: [running('extraction', 800)] });
    await pause(800);
    send({ type: 'progress', elapsedMs: 9200, steps: [read, running('matching')] });
    await pause(800);
    send({ type: 'progress', elapsedMs: 21000, steps: [read, match, running('writing', 1600)] });
    await buildHeld;
    send({ type: 'progress', elapsedMs: 31000, steps: [read, match, build, running('checking')] });
    await pause(400);
    send({ type: 'result', result, elapsedMs: 38000, steps: [read, match, build, done('checking', 7000)] });
    res.end();
  });
  return { server, release: () => release() };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function launchChrome() {
  const profile = await mkdtemp(path.join(tmpdir(), 'landwise-screenshots-'));
  const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  // A failed spawn emits only 'error', so treat it as an exit too.
  const exited = new Promise(resolve => { chrome.once('exit', resolve); chrome.once('error', resolve); });
  // Ctrl+C, SIGTERM (Vite exits on it) or a crash skip the async cleanup; exit handlers must be synchronous.
  const forceClose = () => { chrome.kill('SIGKILL'); rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); };
  process.once('exit', forceClose);
  async function close() {
    process.off('exit', forceClose);
    if (chrome.pid && chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill();
      const graceful = await Promise.race([exited.then(() => true), new Promise(resolve => setTimeout(resolve, 5000, false).unref())]);
      if (!graceful) {
        chrome.kill('SIGKILL');
        await exited;
      }
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  let timer;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Chrome did not open its DevTools port within 30 seconds.')), 30000);
      chrome.once('error', () => reject(new Error(`Could not start Chrome at ${chromePath}. Set CHROME_PATH to a Chrome or Chromium binary.`)));
      exited.then(code => reject(new Error(`Chrome exited early (${code}).`)));
      let output = '';
      chrome.stderr.on('data', chunk => {
        if (output === null) return; // Keep draining so Chrome never blocks on a full pipe.
        output += chunk;
        const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { output = null; resolve(match[1]); }
      });
    });
    return { endpoint, close };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// A minimal Chrome DevTools Protocol client over Node's built-in WebSocket.
async function connect(endpoint) {
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('Could not connect to Chrome.'));
  });
  let nextId = 0;
  const pending = new Map();
  // Fail every waiting command if Chrome goes away, instead of hanging.
  socket.onclose = () => {
    for (const request of pending.values()) request.reject(new Error(`${request.method}: Chrome closed the DevTools connection.`));
    pending.clear();
  };
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
    else request.resolve(message.result);
  };
  return {
    send(method, params = {}, sessionId) {
      if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`${method}: Chrome is not connected.`));
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: no reply from Chrome within 30 seconds.`)); }, 30000);
        const settle = callback => value => { clearTimeout(timer); callback(value); };
        pending.set(id, { method, resolve: settle(resolve), reject: settle(reject) });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
    connected: () => socket.readyState === WebSocket.OPEN,
    close: () => socket.close(),
  };
}

async function openPage(cdp, origin) {
  await cdp.send('Browser.grantPermissions', { origin, permissions: ['geolocation'] });
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }] });
  await send('Emulation.setGeolocationOverride', TORONTO);
  async function evaluate(expression) {
    const { result: value, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return value.value;
  }
  return {
    evaluate,
    // Keeps polling through transient errors such as a page reload, up to the deadline.
    async waitFor(expression, timeout = 15000) {
      const deadline = Date.now() + timeout;
      let lastError;
      while (Date.now() < deadline) {
        try {
          if (await evaluate(`Boolean(${expression})`)) return;
          lastError = null;
        } catch (error) {
          if (!cdp.connected()) throw error;
          lastError = error;
        }
        await pause(100);
      }
      throw new Error(`Timed out waiting for: ${expression}${lastError ? ` (${lastError.message})` : ''}`);
    },
    goto: url => send('Page.navigate', { url }),
    // Crops are measured at scroll 0 inside a tall viewport, so page and viewport coordinates match.
    async viewport(width, height) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
      await evaluate('scrollTo(0, 0)');
      await pause(300);
    },
    rect: selector => evaluate(`(() => {
      const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.floor(box.height) };
    })()`),
    async screenshot(name, clip) {
      await evaluate('document.fonts.ready.then(() => true)');
      const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
      const file = path.join(outDir, `${name}.png`);
      await writeFile(file, Buffer.from(data, 'base64'));
      const shown = path.relative(root, file);
      console.info(`Saved ${shown.startsWith('..') ? file : shown}`);
    },
  };
}

async function captureStudio(page, origin, api) {
  await page.viewport(1440, 3200);
  await page.goto(`${origin}/#resume`);
  await page.waitFor(`document.querySelector('.transform-btn')?.disabled === false`);
  await page.evaluate(`(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    for (const [selector, text] of ${JSON.stringify([['#resume-text', resume], ['#job-description', job]])}) {
      const area = document.querySelector(selector);
      setter.call(area, text);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);
  await pause(300);
  await page.evaluate(`document.querySelector('.transform-btn').click()`);
  await page.waitFor(`document.querySelector('.workbench-writing')`);
  await pause(300);
  // The three "How a tailoring works" images share the progress panel's size.
  const panel = await page.rect('.output-panel');
  await page.screenshot('tailor-progress', panel);

  api.release();
  await page.waitFor(`document.querySelector('.result-tabs')`);
  await page.evaluate(`document.activeElement?.blur(); document.querySelectorAll('textarea').forEach(area => { area.scrollTop = 0; })`);
  await page.viewport(1440, 1360);
  await page.screenshot('hero', { x: 0, y: 0, width: 1440, height: 1360 });

  await page.viewport(1440, 3200);
  await page.evaluate(`[...document.querySelectorAll('[role="tab"]')].find(tab => tab.textContent.trim() === 'Fit report').click()`);
  await page.waitFor(`document.querySelector('.fit-report')`);
  await pause(300);
  await page.screenshot('tailor-fit-report', panel);
  await page.evaluate(`document.querySelectorAll('.fit-group').forEach(group => {
    group.open = group.querySelector('summary').textContent.includes('Compare the edited bullets');
    if (group.open) group.dataset.screenshot = 'compare';
  })`);
  await pause(300);
  const compare = await page.rect('[data-screenshot="compare"]');
  await page.screenshot('tailor-compare', { ...panel, y: compare.y - 28 });
}

async function captureEvents(page, origin) {
  await page.viewport(1324, 3600);
  await page.goto(`${origin}/#career-events`);
  await page.waitFor(`document.querySelector('.career-location-request')?.textContent.includes('Update location')`);
  await pause(500);
  const directory = await page.rect('.career-directory');
  await page.screenshot('career-events', { x: 0, y: directory.y + 6, width: 1324, height: 1063 });
}

// Exit (rather than die) on Ctrl+C or SIGTERM so the exit hook in launchChrome runs.
process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));

await mkdir(outDir, { recursive: true });
const api = mockApi();
const apiPort = await listen(api.server);
env.VITE_LANDWISE_HOSTED = 'true';
const vite = await createServer({
  root, logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: true, proxy: { '/api': `http://127.0.0.1:${apiPort}` } },
});
let chrome, cdp;
try {
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  chrome = await launchChrome();
  cdp = await connect(chrome.endpoint);
  const page = await openPage(cdp, origin);
  await captureStudio(page, origin, api);
  await captureEvents(page, origin);
} finally {
  // Each step runs even if an earlier one fails.
  for (const step of [
    () => cdp?.send('Browser.close').catch(() => {}),
    () => cdp?.close(),
    () => chrome?.close(),
    () => vite.close(),
    () => { api.server.closeAllConnections(); return new Promise(resolve => api.server.close(resolve)); },
  ]) {
    try { await step(); } catch (error) { console.warn(`Cleanup: ${error.message}`); }
  }
}
