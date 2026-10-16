import express from 'express';
import { createApplicationStore } from './server/application-store.js';
import multer from 'multer';
import { PDFParse } from 'pdf-parse';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { createChatGPTAuth } from './server/chatgpt-auth.js';
import { createChatGPTInference } from './server/chatgpt-inference.js';
import { transformResume } from './server/transform.js';
import { reviseResume, validateRevisionInput } from './server/revise.js';
import { transformProgress } from './server/transform-progress.js';
import { withDeadline } from './server/request-deadline.js';
import { createAIAdmission } from './server/ai-rate-limit.js';
import { estimateResumePages, validPageLimit } from './src/resumeLayout.js';

dotenv.config();

function sendAIError(res, error) {
  const known = Number.isInteger(error?.status) && typeof error?.code === 'string';
  if (error?.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
  res.status(known ? error.status : 502).json({
    error: known ? error.message : 'The AI request could not be completed. Please try again.',
    ...(known ? { code: error.code } : {}),
    ...(error?.manageUsageUrl ? { manageUsageUrl: 'https://chatgpt.com/settings/usage' } : {}),
    ...(error?.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
  });
}

export function createLandwiseApp({ auth, inference, appOrigin = 'http://127.0.0.1:5174', transformTimeoutMs = 240000, log = console.info, applications = null }) {
const app = express();
const admission = createAIAdmission(auth);
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!['GET', 'HEAD'].includes(req.method) && req.get('Origin') !== appOrigin) {
    return res.status(403).json({ error: 'Open Landwise in its local browser window and try again.', code: 'invalid_origin' });
  }
  next();
});
app.use('/api', (req, res, next) => {
  const controller = new AbortController();
  req.aiSignal = controller.signal;
  res.once('close', () => { if (!res.writableEnded) controller.abort(); });
  next();
});
app.use(auth.router);

// POST reads carry the same origin/session/CSRF protection as local AI actions.
if (applications) {
  for (const [action, operation] of Object.entries({
    list: () => applications.list(),
    get: body => applications.get(body.id),
    save: body => applications.save(body),
    update: body => applications.update(body.id, body.patch),
    remove: body => applications.remove(body.id),
  })) app.post(`/api/applications/${action}`, async (req, res) => {
    try { auth.requireSession(req); res.json(await operation(req.body)); }
    catch (error) {
      res.status(error.status || 500).json({ error: error.status ? error.message : 'Your application folder could not be accessed. Your current draft is still available.', code: error.code || 'application_storage_failed' });
    }
  });
}

app.post('/api/ai/models', async (req, res) => {
  try {
    admission.acquire(req, false);
    res.json({ models: await inference.listModels(req) });
  } catch (error) {
    admission.record(req, error);
    sendAIError(res, error);
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are accepted.'));
  },
});

app.post('/api/parse-pdf', upload.single('resume'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded.' });
  let parser;
  try {
    parser = new PDFParse({ data: req.file.buffer });
    const result = await parser.getText({ pageJoiner: '' });
    res.json({ text: result.text, pageCount: result.total });
  } catch {
    res.status(500).json({ error: 'Could not read the PDF. Please try a different file.' });
  } finally {
    await parser?.destroy();
  }
});

app.post('/api/analyze-resume', async (req, res) => {
  const { resume } = req.body;
  if (typeof resume !== 'string' || !resume.trim()) return res.status(400).json({ error: 'Resume text is required.' });

  let release;
  try {
    release = admission.acquire(req);
    const client = await inference.getClient(req, req.body.model);
    const msg = await client.messages.create({
      system: 'You are an expert resume coach. Give specific, actionable feedback. Respond with valid JSON only — no markdown fences.',
      messages: [{
        role: 'user',
        content: `Analyze this resume and return exactly this JSON shape:
{
  "overallScore": <integer 0-100>,
  "sections": [
    { "name": "Summary",    "present": <bool>, "score": <1-10>, "feedback": "<one actionable sentence>" },
    { "name": "Experience", "present": <bool>, "score": <1-10>, "feedback": "<one actionable sentence>" },
    { "name": "Skills",     "present": <bool>, "score": <1-10>, "feedback": "<one actionable sentence>" },
    { "name": "Education",  "present": <bool>, "score": <1-10>, "feedback": "<one actionable sentence>" },
    { "name": "Metrics",    "present": <bool - are quantified achievements present?>, "score": <1-10>, "feedback": "<one actionable sentence about numbers/impact>" }
  ],
  "strengths": ["<2-3 genuine strengths, each under 8 words>"],
  "improvements": [
    { "priority": "high"|"medium"|"low", "area": "<section or aspect>", "suggestion": "<specific 1-2 sentence fix>" }
  ],
  "suggestedLLMSkills": ["<0-4 AI/LLM skills to consider learning only if this resume already shows relevant AI work; otherwise return []>"],
  "missingElements": ["<things completely absent, e.g. GitHub/portfolio URL, quantified achievements, professional summary, certifications>"]
}

Rules:
- improvements: max 5, ordered high → medium → low
- suggestedLLMSkills: context-appropriate only, not a generic list
- Never suggest putting an unverified skill on the resume
- Return ONLY valid JSON

RESUME:
${resume}`,
      }],
    });

    let analysis;
    try { analysis = JSON.parse(msg.content[0].text); }
    catch { return res.status(500).json({ error: 'Could not parse analysis result.' }); }

    res.json(analysis);
  } catch (err) {
    admission.record(req, err);
    sendAIError(res, err);
  } finally {
    release?.();
  }
});

app.post('/api/transform', async (req, res) => {
  const { resume, jobDescription } = req.body;

  if (typeof resume !== 'string' || !resume.trim()) return res.status(400).json({ error: 'Resume text is required.' });
  if (typeof jobDescription !== 'string' || !jobDescription.trim()) return res.status(400).json({ error: 'Job description is required.' });

  // --- Guardrail: deterministic pre-checks (zero cost, zero latency) ---
  const jd = jobDescription.trim();
  if (jd.length < 50) {
    return res.status(400).json({ error: 'Job description is too short. Please paste a real job posting.' });
  }
  if (/^\d+$/.test(jd)) {
    return res.status(400).json({ error: 'Job description cannot be only numbers.' });
  }
  const alphaRatio = (jd.match(/[a-zA-Z]/g) || []).length / jd.length;
  if (alphaRatio < 0.4) {
    return res.status(400).json({ error: 'Job description appears to contain non-text content. Please paste a real job posting.' });
  }
  const maxPages = req.body.maxPages ?? estimateResumePages(resume);
  if (!validPageLimit(maxPages)) return res.status(400).json({ error: 'Choose a page limit between 1 and 20.', code: 'invalid_page_limit' });

  const progress = transformProgress(req, res, log);
  let release;
  try {
    release = admission.acquire(req);
    const result = await withDeadline(req.aiSignal, transformTimeoutMs,
      Object.assign(new Error('Transform took too long. Your inputs are still here. Please try again or choose another model.'), { status: 504, code: 'transform_timeout' }),
      async signal => {
        req.aiSignal = signal;
        const client = await progress.step('connection', 'Connecting to ChatGPT', () => inference.getClient(req, req.body.model));
        return transformResume({ client, resume, jobDescription, maxPages, step: progress.step });
      });
    if (applications) {
      try { result.savedApplication = await applications.save({ resume, jobDescription, maxPages, result }); }
      catch { result.saveError = 'Your draft is ready, but it could not be saved to your local application folder. Download it or retry saving.'; }
    }
    progress.complete(result);
  } catch (error) {
    admission.record(req, error);
    progress.fail(error);
  } finally {
    release?.();
  }
});

app.post('/api/revise', async (req, res) => {
  let input;
  try { input = validateRevisionInput(req.body); }
  catch (error) { return sendAIError(res, error); }
  const progress = transformProgress(req, res, log);
  let release;
  try {
    release = admission.acquire(req);
    const result = await withDeadline(req.aiSignal, Math.min(transformTimeoutMs, 120000),
      Object.assign(new Error('This follow-up took too long. Your previous draft is unchanged. Please try a smaller edit or choose another model.'), { status: 504, code: 'revision_timeout' }),
      async signal => {
        req.aiSignal = signal;
        const client = await progress.step('connection', 'Connecting to ChatGPT', () => inference.getClient(req, req.body.model));
        return reviseResume({ client, input, step: progress.step });
      });
    if (applications && result.revision.changed) {
      try { result.savedApplication = await applications.save({ resume: input.resume, jobDescription: input.jobDescription, maxPages: input.maxPages, result }); }
      catch { result.saveError = 'Your revised draft is ready, but it could not be saved to your local application folder. Download it or retry saving.'; }
    }
    progress.complete(result);
  } catch (error) {
    admission.record(req, error);
    progress.fail(error);
  } finally {
    release?.();
  }
});

app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const tooLarge = error?.type === 'entity.too.large' || error?.code === 'LIMIT_FILE_SIZE';
  res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'This file or text is too large.' : 'Could not read this request. Please check the input and try again.' });
});
return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3001);
  const appOrigin = process.env.LANDWISE_APP_ORIGIN || 'http://127.0.0.1:5174';
  const auth = await createChatGPTAuth({ appOrigin, port });
  const inference = createChatGPTInference({ getAccessToken: auth.getAccessToken });
  const app = createLandwiseApp({ auth, inference, appOrigin, applications: createApplicationStore() });
  const server = app.listen(port, '127.0.0.1', () => console.log(`Landwise API running on http://127.0.0.1:${port}`));
  async function shutdown() {
    server.close();
    await auth.close();
    process.exit(0);
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
