import 'dotenv/config';
import path from 'path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { nanoid } from 'nanoid';
import { findById, findByTg, findByContentHash, insert, updateReady, requeue, getStats, requeueAll, HLS_SIZE_THRESHOLD } from './db.js';
import { save, read, contentHash } from './storage.js';
import { EXT_TO_MIME } from './telegram.js';
import { startWorker } from './worker.js';
import { startHlsWorker, hlsDir } from './hls-worker.js';

const app = express();
const PORT = process.env.PORT || 3002;
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!AUTH_TOKEN || token === AUTH_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.use(cookieParser());
app.use(express.json({ limit: '100mb' }));

// ─── GET /media/:id.ext — serve media file ──────────────────────────────────
app.get('/media/:filename', async (req, res) => {
  const match = req.params.filename.match(/^(.+)\.(\w+)$/);
  if (!match) return res.status(400).json({ error: 'Invalid filename' });

  const [, id, ext] = match;
  const record = await findById(id);
  if (!record || record.status !== 'ready' || record.ext !== ext) {
    return res.status(404).json({ error: 'Not found' });
  }

  const buffer = await read(record.type, id, ext);
  if (!buffer) return res.status(404).json({ error: 'File not found' });

  const mime = record.mime_type || EXT_TO_MIME[ext] || 'application/octet-stream';
  res.set({
    'Content-Type': mime,
    'Content-Length': buffer.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  res.send(buffer);
});

// ─── HLS streaming — serve m3u8 playlist and .ts segments ──────────────────
app.get('/hls/:id/index.m3u8', async (req, res) => {
  const record = await findById(req.params.id);
  if (!record || record.type !== 'video' || record.status !== 'ready') {
    return res.status(404).json({ error: 'HLS not available' });
  }
  const fp = path.join(hlsDir(record.id), 'index.m3u8');
  res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'public, max-age=31536000, immutable' });
  res.sendFile(fp, err => { if (err) res.status(404).end(); });
});

app.get('/hls/:id/:segment', (req, res) => {
  const { id, segment } = req.params;
  if (!/^seg\d+\.ts$/.test(segment)) return res.status(400).end();
  const fp = path.join(hlsDir(id), segment);
  res.set({ 'Content-Type': 'video/mp2t', 'Cache-Control': 'public, max-age=31536000, immutable' });
  res.sendFile(fp, err => { if (err) res.status(404).end(); });
});

// ─── Legacy media fallback — serve old chigua downloads ─────────────────────
const LEGACY_MEDIA_DIR = process.env.LEGACY_MEDIA_DIR || '';
if (LEGACY_MEDIA_DIR) {
  // Only serve paths that look like files (have an extension)
  app.get(/^\/[^/]+\/.*\.\w+$/, (req, res, next) => {
    if (req.path.startsWith('/media/')) return next();
    const safePath = path.normalize(req.path).replace(/^(\.\.[/\\])+/, '');
    const fp = path.join(LEGACY_MEDIA_DIR, safePath);
    if (!fp.startsWith(LEGACY_MEDIA_DIR)) return res.status(403).end();
    res.sendFile(fp, (err) => {
      if (err) return next();
    });
  });
}

// ─── POST /fetch — queue Telegram media download ────────────────────────────
app.post('/fetch', requireAuth, async (req, res) => {
  const { channel, message_id, force } = req.body;
  if (!channel || !message_id) {
    return res.status(400).json({ error: 'channel and message_id required' });
  }

  // Already exists?
  const existing = await findByTg(channel, message_id);
  if (existing) {
    if (existing.status === 'ready') {
      return res.json({
        ready: true,
        id: existing.id,
        url: `/media/${existing.id}.${existing.ext}`,
        type: existing.type,
      });
    }
    // Re-queue failed jobs for retry
    if (existing.status === 'failed' || existing.status === 'too_large') {
      await requeue(existing.id, { force });
      return res.json({ ready: false, id: existing.id, status: 'queued' });
    }
    return res.json({
      ready: false,
      id: existing.id,
      status: existing.status,
    });
  }

  // Queue for background download
  const id = nanoid();
  await insert({ id, source: 'telegram', tg_channel: channel, tg_message_id: message_id, force: force ? 1 : 0 });

  res.json({ ready: false, id, status: 'queued' });
});

// ─── POST /fetch-batch — queue multiple Telegram media downloads ─────────────
app.post('/fetch-batch', requireAuth, async (req, res) => {
  const items = req.body;
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'Expected array of {channel, message_id}' });
  }

  const results = [];
  for (const { channel, message_id } of items) {
    if (!channel || !message_id) {
      results.push({ channel, message_id, error: 'channel and message_id required' });
      continue;
    }

    const existing = await findByTg(channel, message_id);
    if (existing) {
      if (existing.status === 'ready') {
        results.push({
          ready: true,
          id: existing.id,
          url: `/media/${existing.id}.${existing.ext}`,
          type: existing.type,
          channel, message_id,
        });
      } else {
        if (existing.status === 'failed') await requeue(existing.id);
        results.push({
          ready: false,
          id: existing.id,
          status: existing.status === 'failed' ? 'queued' : existing.status,
          channel, message_id,
        });
      }
      continue;
    }

    const id = nanoid();
    await insert({ id, source: 'telegram', tg_channel: channel, tg_message_id: message_id });
    results.push({ ready: false, id, status: 'queued', channel, message_id });
  }

  res.json(results);
});

// ─── GET /status/:id — check media status ───────────────────────────────────
app.get('/status/:id', async (req, res) => {
  const record = await findById(req.params.id);
  if (!record) return res.status(404).json({ error: 'Not found' });

  if (record.status === 'ready') {
    const result = {
      ready: true,
      id: record.id,
      url: `/media/${record.id}.${record.ext}`,
      type: record.type,
    };
    if (record.type === 'video' && record.size > HLS_SIZE_THRESHOLD) {
      result.hls_url = `/hls/${record.id}/index.m3u8`;
    }
    return res.json(result);
  }

  res.json({
    ready: false,
    id: record.id,
    status: record.status,
    error: record.error || undefined,
  });
});

// ─── POST /status-batch — check status of multiple media by channel+message_id
app.post('/status-batch', requireAuth, async (req, res) => {
  const items = req.body;
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'Expected array of {channel, message_id}' });
  }

  const results = [];
  for (const { channel, message_id } of items) {
    const record = await findByTg(channel, message_id);
    if (!record) {
      results.push({ channel, message_id, status: 'unknown' });
      continue;
    }
    if (record.status === 'ready') {
      const result = {
        ready: true,
        id: record.id,
        url: `/media/${record.id}.${record.ext}`,
        type: record.type,
        channel, message_id,
      };
      if (record.type === 'video' && record.size > HLS_SIZE_THRESHOLD) {
        result.hls_url = `/hls/${record.id}/index.m3u8`;
      }
      results.push(result);
    } else {
      results.push({
        ready: false,
        id: record.id,
        status: record.status,
        error: record.error || undefined,
        channel, message_id,
      });
    }
  }

  res.json(results);
});

// ─── POST /upload — upload media file ────────────────────────────────────────
app.post('/upload', requireAuth, async (req, res) => {
  const contentType = req.headers['content-type'] || '';
  let buffer, originalName, mime;

  if (contentType.includes('application/json')) {
    const { filename, data, mime_type } = req.body;
    if (!filename || !data) {
      return res.status(400).json({ error: 'filename and data required' });
    }
    buffer = Buffer.from(data, 'base64');
    originalName = filename;
    mime = mime_type;
  } else {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    buffer = Buffer.concat(chunks);
    originalName = req.headers['x-filename'] || 'upload';
    mime = contentType;
  }

  if (!buffer.length) {
    return res.status(400).json({ error: 'Empty file' });
  }

  const hash = contentHash(buffer);

  // Dedup by content
  const dupe = await findByContentHash(hash);
  if (dupe) {
    return res.json({
      ready: true,
      id: dupe.id,
      url: `/media/${dupe.id}.${dupe.ext}`,
      type: dupe.type,
      deduplicated: true,
    });
  }

  const ext = originalName.split('.').pop()?.toLowerCase() || 'bin';
  const isVideo = mime?.startsWith('video/') || ['mp4', 'mov', 'webm'].includes(ext);
  const type = isVideo ? 'video' : 'photo';

  if (!mime) {
    const EXT_MIME = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      gif: 'image/gif', webp: 'image/webp',
      mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
    };
    mime = EXT_MIME[ext] || 'application/octet-stream';
  }

  const id = nanoid();
  await save(type, id, ext, buffer);
  await insert({
    id, status: 'ready', type, ext, source: 'upload',
    content_hash: hash, size: buffer.length, mime_type: mime,
  });

  res.json({
    ready: true,
    id,
    url: `/media/${id}.${ext}`,
    type,
  });
});

// ─── Dashboard ──────────────────────────────────────────────────────────────
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || AUTH_TOKEN || 'admin';

app.get('/dashboard/login', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>mia login</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh}
form{background:#18181b;border:1px solid #27272a;border-radius:12px;padding:32px;width:300px}
h1{font-size:18px;margin-bottom:16px;color:#fff}
input{width:100%;padding:10px;border-radius:8px;border:1px solid #27272a;background:#0a0a0a;color:#fff;font-size:14px;margin-bottom:12px}
button{width:100%;padding:10px;border-radius:8px;border:none;background:#fff;color:#000;font-size:14px;font-weight:600;cursor:pointer}
button:hover{background:#e4e4e7}
.err{color:#f87171;font-size:13px;margin-bottom:8px}
</style></head><body>
<form method="POST" action="/dashboard/login">
<h1>mia dashboard</h1>
${req.query.err ? '<div class="err">Wrong password</div>' : ''}
<input type="password" name="password" placeholder="Password" autofocus>
<button type="submit">Login</button>
</form></body></html>`);
});

app.post('/dashboard/login', express.urlencoded({ extended: false }), (req, res) => {
  if (req.body.password === DASHBOARD_PASSWORD) {
    res.cookie('mia_token', DASHBOARD_PASSWORD, { httpOnly: true, maxAge: 86400000 });
    return res.redirect('/dashboard');
  }
  res.redirect('/dashboard/login?err=1');
});

function requireDashboardAuth(req, res, next) {
  if (req.cookies?.mia_token === DASHBOARD_PASSWORD) return next();
  res.redirect('/dashboard/login');
}

app.get('/dashboard', requireDashboardAuth, async (req, res) => {
  const stats = await getStats();
  const countsMap = {};
  let totalSize = 0;
  for (const r of stats.counts) {
    countsMap[r.status] = r.cnt;
    totalSize += Number(r.total_size);
  }
  const total = Object.values(countsMap).reduce((a, b) => a + b, 0);

  const channelMap = {};
  for (const r of stats.byChannel) {
    if (!channelMap[r.tg_channel]) channelMap[r.tg_channel] = {};
    channelMap[r.tg_channel][r.status] = r.cnt;
  }

  const fmtSize = (b) => {
    if (!b) return '0';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  };

  const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>mia dashboard</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#e4e4e7;padding:24px;max-width:900px;margin:0 auto}
  h1{font-size:20px;font-weight:700;margin-bottom:20px;color:#fff}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px}
  .card{background:#18181b;border:1px solid #27272a;border-radius:12px;padding:16px}
  .card .label{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#71717a;margin-bottom:4px}
  .card .value{font-size:28px;font-weight:700}
  .queued .value{color:#facc15} .ready .value{color:#4ade80} .failed .value{color:#f87171} .transcoding .value{color:#818cf8}
  .total .value{color:#fff}
  h2{font-size:14px;font-weight:600;color:#a1a1aa;margin:20px 0 10px;text-transform:uppercase;letter-spacing:.5px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;padding:8px 10px;border-bottom:1px solid #27272a;color:#71717a;font-weight:500}
  td{padding:7px 10px;border-bottom:1px solid #18181b}
  tr:hover td{background:#18181b}
  .st{display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600}
  .st-queued{background:#422006;color:#facc15} .st-ready{background:#052e16;color:#4ade80} .st-failed{background:#450a0a;color:#f87171} .st-transcoding{background:#1e1b4b;color:#818cf8}
  .ch-row td{padding:5px 10px}
  .btn{display:inline-block;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:600;border:none;cursor:pointer;text-decoration:none}
  .btn-warn{background:#422006;color:#facc15;border:1px solid #713f12}
  .btn-warn:hover{background:#713f12}
  .btn-sm{padding:3px 8px;font-size:11px;border-radius:6px}
  .btn-retry{background:#1e1b4b;color:#818cf8;border:1px solid #312e81}
  .btn-retry:hover{background:#312e81}
  .actions{margin-bottom:20px;display:flex;gap:8px}
  .mono{font-family:ui-monospace,monospace;font-size:12px;color:#a1a1aa}
  a.file-link{color:#4ade80;text-decoration:none}
  a.file-link:hover{text-decoration:underline}
  .err{color:#f87171;font-size:11px}
  .err-full{display:none;white-space:pre-wrap;word-break:break-all;padding:6px 0}
  .err-toggle{color:#f87171;cursor:pointer;text-decoration:underline;font-size:11px}
</style>
</head><body>
<h1>mia dashboard</h1>
<div class="cards">
  <div class="card total"><div class="label">Total</div><div class="value">${total}</div></div>
  <div class="card queued"><div class="label">Queued</div><div class="value">${countsMap.queued || 0}</div></div>
  <div class="card transcoding"><div class="label">Transcoding</div><div class="value">${countsMap.transcoding || 0}</div></div>
  <div class="card ready"><div class="label">Ready</div><div class="value">${countsMap.ready || 0}</div></div>
  <div class="card failed"><div class="label">Failed</div><div class="value">${countsMap.failed || 0}</div></div>
  <div class="card"><div class="label">Total Size</div><div class="value" style="font-size:20px">${fmtSize(totalSize)}</div></div>
</div>

<div class="actions">
  <form method="POST" action="/dashboard/retry-all" style="display:inline">
    <button class="btn btn-warn" onclick="return confirm('Retry all failed jobs?')">Retry All Failed</button>
  </form>
</div>

<h2>By Channel</h2>
<table>
<tr><th>Channel</th><th>Queued</th><th>Ready</th><th>Failed</th></tr>
${Object.entries(channelMap).map(([ch, s]) => `<tr class="ch-row"><td>${ch}</td><td>${s.queued||0}</td><td>${s.ready||0}</td><td>${s.failed||0}</td></tr>`).join('')}
</table>

<h2>Recent Jobs</h2>
<table>
<tr><th>ID</th><th>Status</th><th>File</th><th>Channel</th><th>Msg</th><th>Type</th><th>Size</th><th>Error</th><th>Created</th><th></th></tr>
${stats.recent.map((r, i) => `<tr>
  <td class="mono">${r.id.slice(0,8)}...</td>
  <td><span class="st st-${r.status}">${r.status}</span></td>
  <td>${r.status === 'ready' && r.ext ? (r.type === 'video' && r.size > HLS_SIZE_THRESHOLD ? '<a class="file-link" href="/hls/' + r.id + '/index.m3u8" target="_blank">' + r.id.slice(0,6) + '.m3u8</a>' : '<a class="file-link" href="/media/' + r.id + '.' + r.ext + '" target="_blank">' + r.id.slice(0,6) + '.' + r.ext + '</a>') : '-'}</td>
  <td>${r.tg_channel||'-'}</td>
  <td>${r.tg_message_id||'-'}</td>
  <td>${r.type||'-'}</td>
  <td>${r.size ? fmtSize(r.size) : '-'}</td>
  <td>${r.error ? `<span class="err-toggle" onclick="var el=document.getElementById('err-${i}');el.style.display=el.style.display==='block'?'none':'block'">${r.error.slice(0,40)}${r.error.length>40?'...':''}</span><div class="err-full" id="err-${i}">${r.error}</div>` : ''}</td>
  <td class="mono">${r.created_at||''}</td>
  <td>${r.status === 'failed' ? `<form method="POST" action="/dashboard/retry/${r.id}" style="display:inline"><button class="btn btn-sm btn-retry">retry</button></form>` : ''}</td>
</tr>`).join('')}
</table>

<script>setTimeout(()=>location.reload(), 10000)</script>
</body></html>`;
  res.type('html').send(html);
});

app.post('/dashboard/retry-all', requireDashboardAuth, async (req, res) => {
  const count = await requeueAll();
  res.redirect(`/dashboard`);
});

app.post('/dashboard/retry/:id', requireDashboardAuth, async (req, res) => {
  await requeue(req.params.id);
  res.redirect('/dashboard');
});

// Start workers and server
startWorker();
startHlsWorker();

app.listen(PORT, () => {
  console.log(`[media-server] Listening on :${PORT}`);
});
