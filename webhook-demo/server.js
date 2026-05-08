const express = require('express');
const Bull    = require('bull');
const axios   = require('axios');
const path    = require('path');

// ── Process-level error guards ─────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[Fatal] Uncaught Exception:', err.message);
  process.exit(1); // Process is in undefined state after uncaughtException — must exit
});
process.on('unhandledRejection', (reason) => {
  console.error('[Fatal] Unhandled Rejection:', reason);
  process.exit(1); // Consistent with uncaughtException — exit on unrecoverable state
});

const app = express();
app.use(express.json({ limit: '16kb' })); // Prevent oversized payload attacks
app.use(express.static(path.join(__dirname, 'public')));

// ── Redis Connection ───────────────────────────────────────────────────────
// Support environment-configurable Redis (Docker, staging, production)
const REDIS_HOST     = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT     = parseInt(process.env.REDIS_PORT, 10) || 6379;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const REDIS_TLS      = process.env.REDIS_TLS === 'true';
const REDIS_CONFIG   = {
  redis: {
    host:     REDIS_HOST,
    port:     REDIS_PORT,
    password: REDIS_PASSWORD,
    tls:      REDIS_TLS ? {} : undefined,
  }
};

// ── Bull Queue ────────────────────────────────────────────────────────────
const webhookQueue = new Bull('webhooks', REDIS_CONFIG);

// Handle Redis / Queue connection errors gracefully
webhookQueue.on('error', (err) => {
  console.error('[Queue] Redis error:', err.message);
});

// ── In-memory job log ─────────────────────────────────────────────────────
const jobLog = [];
const MAX_LOG = 50; // Aligned with /jobs route limit
function logJob(entry) {
  jobLog.unshift({ ...entry, time: new Date().toISOString() });
  if (jobLog.length > MAX_LOG) jobLog.pop();
}

// ── Worker: actually deliver webhook via HTTP POST ─────────────────────────
// Process up to 10 jobs concurrently so batch jobs don't queue sequentially
webhookQueue.process(10, async (job) => {
  const { url, payload } = job.data;
  console.log('[Worker] Job ' + job.id + ' -> ' + url + ' (attempt ' + (job.attemptsMade + 1) + ')');

  // Demo: simulate a 40% pre-flight network failure so retries are visible in the dashboard.
  // This represents cases where the target server is unreachable before a connection is made.
  const shouldFail = Math.random() < 0.4;
  if (shouldFail) {
    throw new Error('Simulated network failure to ' + url);
  }

  // Perform the actual HTTP POST to the target URL
  let response;
  try {
    response = await axios.post(url, payload, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Source': 'webhook-delivery-engine' },
    });
  } catch (axiosErr) {
    // Format axios errors into clean, readable messages for the job log
    const status  = axiosErr.response ? axiosErr.response.status : null;
    const message = status
      ? 'HTTP ' + status + ' from ' + url
      : 'Network error: ' + axiosErr.message;
    throw new Error(message);
  }

  return { delivered: true, url, statusCode: response.status };
});

// ── Event listeners ────────────────────────────────────────────────────────
webhookQueue.on('completed', (job, result) => {
  logJob({
    id:         job.id,
    status:     'completed',
    url:        result && result.url,
    statusCode: result && result.statusCode,
  });
});

webhookQueue.on('failed', (job, err) => {
  logJob({ id: job.id, status: 'failed', reason: err.message });
});

webhookQueue.on('active', (job) => {
  logJob({ id: job.id, status: 'processing', url: job.data && job.data.url });
});

// Stalled jobs: worker crashed mid-processing — Bull will auto-retry, log it for visibility
webhookQueue.on('stalled', (job) => {
  console.warn('[Queue] Job ' + job.id + ' stalled — re-queuing automatically');
  logJob({ id: job.id, status: 'failed', reason: 'Job stalled (worker crash?) — will retry automatically' });
});

// ── API Routes ─────────────────────────────────────────────────────────────

// POST /webhook/send
app.post('/webhook/send', async (req, res) => {
  const { url, payload } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  // Validate that url is a real HTTP/HTTPS URL before wasting a job slot
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return res.status(400).json({ error: 'url must use http or https protocol' });
    }
  } catch {
    return res.status(400).json({ error: 'url is not a valid URL (e.g. https://example.com/hook)' });
  }

  try {
    const job = await webhookQueue.add(
      { url, payload: payload || {} },
      {
        attempts:         5,
        backoff:          { type: 'exponential', delay: 1000 },
        removeOnComplete: 50,
        removeOnFail:     50,
      }
    );
    res.json({ jobId: job.id, status: 'queued', url });
  } catch (err) {
    console.error('[API] Failed to enqueue job:', err.message);
    res.status(503).json({ error: 'Queue unavailable. Is Redis running? ' + err.message });
  }
});

// GET /stats
app.get('/stats', async (req, res) => {
  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      webhookQueue.getWaitingCount(),
      webhookQueue.getActiveCount(),
      webhookQueue.getCompletedCount(),
      webhookQueue.getFailedCount(),
      webhookQueue.getDelayedCount(),
    ]);
    res.json({ waiting, active, completed, failed, delayed });
  } catch (err) {
    console.error('[API] Failed to fetch stats:', err.message);
    res.status(503).json({ error: 'Stats unavailable. Is Redis running? ' + err.message });
  }
});

// GET /jobs
app.get('/jobs', (req, res) => {
  res.json(jobLog.slice(0, 50));
});

// ── Start Server ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log('');
  console.log('  Webhook Delivery Engine');
  console.log('  -----------------------------------------');
  console.log('  Dashboard -> http://localhost:' + PORT);
  console.log('  Redis     -> ' + REDIS_HOST + ':' + REDIS_PORT);
  console.log('  Queue lib -> Bull (Redis 3.x compatible)');
  console.log('  Retries   -> 5 attempts, exponential backoff');
  console.log('  Delivery  -> Real HTTP POST via axios');
  console.log('  -----------------------------------------');
  console.log('');
});

// ── Graceful Shutdown ──────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log('\n[Server] ' + signal + ' received — shutting down gracefully...');

  // Force-exit after 10 s in case active connections keep server.close() from firing
  const forceExit = setTimeout(() => {
    console.error('[Server] Forced exit after 10 s timeout.');
    process.exit(1);
  }, 10000);
  forceExit.unref(); // Don't let the timer itself prevent normal exit

  server.close(async () => {
    try {
      await webhookQueue.close();
      console.log('[Server] Queue and HTTP server closed. Goodbye.');
    } catch (err) {
      console.error('[Server] Error during queue close:', err.message);
    } finally {
      clearTimeout(forceExit);
      process.exit(0);
    }
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
