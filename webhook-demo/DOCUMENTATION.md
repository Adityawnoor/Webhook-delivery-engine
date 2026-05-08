# 📦 Webhook Delivery Engine — Complete Documentation

> A production-quality webhook delivery system built with **Node.js**, **Bull**, **Redis**, and **Express**. Supports automatic retries with exponential backoff, 10-concurrent workers, a real-time live dashboard, and toast notifications.

---

## 📁 Project Structure

```
webhook-demo/
├── server.js          ← Backend: Express server + Bull queue + worker
├── package.json       ← Dependencies, scripts, Node engine requirement
├── .gitignore         ← Excludes node_modules, .env, logs from git
├── public/
│   └── index.html     ← Frontend: Dashboard UI (HTML + CSS + JS)
└── node_modules/      ← Installed packages (auto-generated)
```

---

## 🔧 How It Works — Overview

```
Browser (index.html)
      │
      │  POST /webhook/send  { url, payload }
      ▼
Express Server (server.js)
      │
      │  Validates URL → adds job to Bull queue
      ▼
Bull Queue (Redis-backed)
      │
      │  Picks job → runs worker (up to 10 concurrent)
      ▼
Worker Function
      │
      ├─ 40%: throws "Simulated network failure" → Bull retries
      └─ 60%: axios.POST(url, payload) → returns { delivered, statusCode }
            │
            ├─ On success  → 'completed' event → logJob()
            ├─ On failure  → 'failed' event    → logJob()
            └─ On retry    → 'active' event    → logJob() again

Browser polls /stats and /jobs every 1.5s → updates dashboard live
```

---

## 🖥️ SERVER.JS — Complete Function Reference

### 1. Process-Level Error Guards
```js
process.on('uncaughtException', (err) => { ... process.exit(1) })
process.on('unhandledRejection', (reason) => { ... process.exit(1) })
```
**What it does:** Catches any unhandled crash or Promise rejection anywhere in the app. Logs the error then calls `process.exit(1)` to prevent the server running in a broken/undefined state. After an `uncaughtException`, Node.js docs say memory may be corrupt and continuing is unsafe.

---

### 2. Redis Configuration
```js
const REDIS_HOST   = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT   = parseInt(process.env.REDIS_PORT, 10) || 6379;
const REDIS_CONFIG = { redis: { host: REDIS_HOST, port: REDIS_PORT } };
```
Reads Redis connection details from environment variables. Falls back to `127.0.0.1:6379` (standard local Redis). Allows deployment to Docker, staging, or production without changing source code.

---

### 3. Bull Queue Creation
```js
const webhookQueue = new Bull('webhooks', REDIS_CONFIG);
```
Creates a named Bull queue called `'webhooks'` backed by Redis. Bull stores all jobs, states, retry counts, and backoff timers in Redis — jobs survive server restarts.

---

### 4. `logJob(entry)` — In-Memory Job Logger
```js
function logJob(entry) {
  jobLog.unshift({ ...entry, time: new Date().toISOString() });
  if (jobLog.length > MAX_LOG) jobLog.pop();
}
```
- Inserts new log entry at the **front** (most recent first)
- Auto-timestamps every entry with ISO 8601
- Caps log at 50 entries — oldest is dropped when limit exceeded
- Called by all 4 queue event listeners

**Entry shape:**
```json
{
  "id": "1",
  "status": "completed|failed|processing|stalled",
  "url": "https://...",
  "reason": "error message",
  "statusCode": 200,
  "time": "2026-05-08T06:00:00.000Z"
}
```

---

### 5. Worker — `webhookQueue.process(10, async (job) => { ... })`
Registers the function that processes each queued job. `10` = up to 10 jobs run simultaneously.

#### Step A — Extract job data
```js
const { url, payload } = job.data;
```

#### Step B — Log attempt number
```js
console.log('Job ' + job.id + ' attempt ' + (job.attemptsMade + 1));
```
`job.attemptsMade` is 0-indexed — add 1 for human-readable display.

#### Step C — Simulated failure (40% chance)
```js
const shouldFail = Math.random() < 0.4;
if (shouldFail) throw new Error('Simulated network failure to ' + url);
```
For demo purposes so retries are visible. Represents real-world DNS failures, connection refused, etc.

#### Step D — Real HTTP POST via axios
```js
response = await axios.post(url, payload, {
  timeout: 5000,
  headers: { 'Content-Type': 'application/json', 'X-Webhook-Source': 'webhook-delivery-engine' },
});
```
- 5 second timeout — gives up if target server doesn't respond
- Custom `X-Webhook-Source` header identifies the sender
- axios errors caught, formatted cleanly, re-thrown so Bull can retry

#### Step E — Return result
```js
return { delivered: true, url, statusCode: response.status };
```
This object becomes available in the `completed` event as `result`.

---

### 6. Queue Event Listeners

| Event | When it fires | What gets logged |
|---|---|---|
| `completed` | Worker returned successfully | `status: 'completed'`, url, statusCode |
| `failed` | An attempt failed (fires on every fail, not just final) | `status: 'failed'`, error reason |
| `active` | Worker picked up a job (including retries) | `status: 'processing'`, url |
| `stalled` | Worker died mid-job (crash/OOM) | `status: 'failed'`, stall message |

---

### 7. API Routes

#### `POST /webhook/send`
Accepts a webhook from the browser and enqueues it.

**Validation chain:**
1. Missing `url` → `400`
2. Malformed URL → `400`
3. Non-http/https protocol → `400`
4. Redis down → `503`

**Job options:**
```js
{ attempts: 5, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 50, removeOnFail: 50 }
```

**Success response:** `{ "jobId": "42", "status": "queued", "url": "..." }`

---

#### `GET /stats`
Returns all 5 queue counts in one response. Uses `Promise.all()` for parallel fetching. Returns `503` if Redis is down.

```json
{ "waiting": 3, "active": 2, "completed": 47, "failed": 5, "delayed": 1 }
```

---

#### `GET /jobs`
Returns the last 50 job log entries (newest first) from the in-memory `jobLog` array.

---

### 8. `shutdown(signal)` — Graceful Shutdown
Called on `SIGTERM` (Docker/kill) or `SIGINT` (Ctrl+C).

**Sequence:**
1. Sets **10-second force-exit timer** (prevents hanging forever on active connections)
2. `server.close()` — stops accepting new connections
3. `await webhookQueue.close()` — cleanly disconnects Redis
4. `clearTimeout(forceExit)` — cancels force-exit since shutdown was clean
5. `process.exit(0)` — clean exit

---

## 🌐 INDEX.HTML — Complete Function Reference

### JS Functions

#### `setConnected(ok)`
Updates the Live/Offline badge in the header.
- `ok = true` → green badge, "Live", dot pulses
- `ok = false` → red badge, "Offline", dot stops pulsing (`.offline` CSS class applied)

---

#### `toast(msg, type)`
Shows a temporary notification in the bottom-right corner.
- **Types:** `'info'` (gray) · `'success'` (green) · `'error'` (red)
- Auto-dismisses after 3 seconds with fade-out slide animation
- Multiple toasts stack vertically

---

#### `refreshStats()`
Fetches `GET /stats` and updates all 5 stat cards plus the success rate bar.

**Extra logic:**
- Compares new vs previous `completed`/`failed` counts → fires toasts when they change
- Calculates success rate: `completed / (completed + failed) × 100`
- Progress bar color: green ≥70% · yellow ≥40% · red <40%
- `setConnected(true/false)` based on response

---

#### `refreshJobs()`
Fetches `GET /jobs` and re-renders the Live Job Log panel.

- Uses `DocumentFragment` for efficient batch DOM insertion
- Each row: colored status badge with emoji + URL/reason + timestamp
- `log.replaceChildren(fragment)` — atomic clear + insert (no layout thrash)
- Empty array → shows 📭 empty state
- Updates `#log-count` badge

**Status icons:** ✅ completed · ❌ failed · ⚡ processing · ⏳ queued · ⚠️ stalled

---

#### `pollLoop()`
```js
async function pollLoop() {
  await refreshStats();
  await refreshJobs();
  setTimeout(pollLoop, 1500);
}
```
Drives real-time updates. Uses recursive `setTimeout` (not `setInterval`) so the next poll only starts after the current one finishes — prevents overlapping calls if the server is slow.

---

#### `sendWebhook()`
Handles "Send Webhook" button click.

1. Reads URL + payload from form
2. Validates URL not empty
3. Parses JSON — shows warning if invalid (no silent fallback to `{}`)
4. Auto-appends `timestamp` to payload
5. Disables button to prevent double-click
6. POSTs to `/webhook/send`
7. Checks `res.ok` — HTTP errors shown in red with status code
8. Success → shows queued JSON in green + info toast
9. `finally` always re-enables button

---

#### `batchSend(count)`
Fires `count` jobs simultaneously (5, 10, or 25).

1. Disables all 3 batch buttons immediately
2. Builds `count` parallel fetch Promises
3. Each payload: `{ event: 'batch.test', index: i+1, timestamp: ... }`
4. `Promise.all()` waits for all to be accepted
5. Shows success + fires toast
6. `finally` always re-enables all buttons

---

## 🔄 Complete Data Flow

```
User clicks "Send Webhook"
  → sendWebhook() validates → POST /webhook/send
  → server validates URL → webhookQueue.add(job)
  → responds { jobId, status: 'queued' }

Bull picks job (async):
  → 'active' event → logJob({ processing })
  → worker runs:
      40% → throw → 'failed' event → logJob({ failed })
                  → if attempts < 5: exponential delay → retry
                  → if attempts = 5: permanently failed
      60% → axios.post(url, payload)
              → error → throw → retry cycle
              → success → 'completed' event → logJob({ completed })

Every 1.5s (pollLoop):
  → GET /stats → update 5 stat cards + success rate bar
  → GET /jobs  → re-render job log + trigger toasts
```

---

## ⚙️ Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `REDIS_HOST` | `127.0.0.1` | Redis server hostname |
| `REDIS_PORT` | `6379` | Redis server port |

---

## 🔁 Retry Schedule (Exponential Backoff)

| Attempt | Delay before retry |
|---|---|
| 1st try | Immediate |
| 2nd try | 1 second |
| 3rd try | 2 seconds |
| 4th try | 4 seconds |
| 5th try | 8 seconds |
| After 5th | Permanently failed |

Formula: `1000ms × 2^(attemptNumber - 1)`

---

## 📦 Dependencies

| Package | Version | Purpose |
|---|---|---|
| `express` | ^4.21.2 | HTTP server and API routes |
| `bull` | ^4.16.5 | Redis-backed job queue with retries |
| `axios` | 1.16.0 | Real HTTP POST delivery to webhook URLs |
| `ioredis` | ^5.3.2 | Redis client used internally by Bull |
| `nodemon` | ^3.1.0 | Dev-only: auto-restart on file changes |

---

## 🔐 Security Features

| Feature | How |
|---|---|
| Body size limit | `express.json({ limit: '16kb' })` |
| URL validation | `new URL()` + protocol check |
| XSS prevention | `.textContent` only, never `innerHTML` with user data |
| Prototype pollution | axios 1.16.0 patches all known CVEs |
| No accidental publish | `"private": true` in package.json |
| Git safety | `.gitignore` covers `node_modules`, `.env`, logs |
