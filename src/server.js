import 'dotenv/config';
import path from 'path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { nanoid } from 'nanoid';
import { findById, findByTg, findByContentHash, insert, updateReady, requeue, requeueOneHlsFailed, getStats, requeueAll, resolveStored, HLS_SIZE_THRESHOLD } from './db.js';
import { save, getPath, contentHash } from './storage.js';
import { faststartStored } from './faststart.js';
import { generateThumbnail } from './thumbnail.js';
import fsp from 'fs/promises';
import { writePart, listParts, discard, maybeSweep, renameStaging } from './chunk-store.js';
import { EXT_TO_MIME } from './telegram.js';
import { verifyTicket } from './tickets.js';
import { startWorker } from './worker.js';
import { startHlsWorker, hlsDir } from './hls-worker.js';
import { startAssembleWorker } from './assemble-worker.js';

const app = express();
const PORT = process.env.PORT || 3002;
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const CDN_BASE = (process.env.CDN_URL || '').replace(/\/+$/, '');

// Media is content-addressed (or an immutable archive of a Telegram message),
// so it can be cached forever. Without this the CDN falls back to its own
// default TTL and revalidates against us on every play.
const MEDIA_CACHE_CONTROL = 'public, max-age=31536000, immutable';

// Browsers upload directly and cannot hold AUTH_TOKEN, so /upload/* also accepts a ticket
// minted by chigua and scoped to a single upload id. Server-to-server callers keep using
// the token, so both paths stay open.
function requireUploadAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (AUTH_TOKEN && token === AUTH_TOKEN) return next();

  const uploadId = req.headers['x-upload-id'] || req.body?.uploadId;
  const ticket = verifyTicket(req.headers['x-upload-ticket'], uploadId);
  if (ticket) {
    req.uploadTicket = ticket;
    return next();
  }
  if (!AUTH_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// Uploads arrive cross-origin from the admin, which is served from several domains. No
// cookies are involved — the ticket is the access control — so reflecting the origin does
// not widen what a caller can do.
function uploadCors(req, res, next) {
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Upload-Ticket, X-Upload-Id, X-Chunk-Index, X-Filename');
  res.set('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

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

  // A de-duplicated row has no file of its own; the bytes sit under the row it
  // duplicates. Resolving here means URLs already stored by callers keep working.
  const stored = await resolveStored(record);

  const mime = record.mime_type || EXT_TO_MIME[ext] || 'application/octet-stream';
  // Stream from disk rather than reading the whole file into a Buffer: these
  // are routinely 40 MB+ videos, and a Range request for the first few KB
  // should not cost a full-file read. sendFile also answers Range with 206,
  // which is what players need to seek.
  res.sendFile(getPath(stored.type, stored.id, stored.ext), {
    headers: { 'Content-Type': mime, 'Cache-Control': MEDIA_CACHE_CONTROL },
  }, (err) => {
    if (!err) return;
    if (res.headersSent) return res.end();
    res.status(404).json({ error: 'File not found' });
  });
});

// ─── HLS streaming — serve m3u8 playlist and .ts segments ──────────────────
app.get('/hls/:id/index.m3u8', async (req, res) => {
  const record = await findById(req.params.id);
  if (!record || record.type !== 'video' || record.status !== 'ready') {
    return res.status(404).json({ error: 'HLS not available' });
  }
  const stored = await resolveStored(record);
  const fp = path.join(hlsDir(stored.id), 'index.m3u8');
  // Headers go through sendFile's options so they are only applied on a
  // successful transfer — setting them up front made 404s cacheable for a year.
  res.sendFile(fp, {
    headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': MEDIA_CACHE_CONTROL },
  }, (err) => {
    if (!err) return;
    if (res.headersSent) return res.end();
    res.status(404).end();
  });
});

app.get('/hls/:id/:segment', async (req, res) => {
  const { id, segment } = req.params;
  if (!/^seg\d+\.ts$/.test(segment)) return res.status(400).end();
  // Segment URLs in the playlist are relative, so they arrive under whichever id the
  // caller used — resolve the same way the playlist did.
  const stored = await resolveStored(await findById(id));
  const fp = path.join(hlsDir(stored?.id ?? id), segment);
  res.sendFile(fp, {
    headers: { 'Content-Type': 'video/mp2t', 'Cache-Control': MEDIA_CACHE_CONTROL },
  }, (err) => {
    if (!err) return;
    if (res.headersSent) return res.end();
    res.status(404).end();
  });
});

// ─── Legacy media fallback — serve old chigua downloads ─────────────────────
const LEGACY_MEDIA_DIR = process.env.LEGACY_MEDIA_DIR
  ? path.resolve(process.env.LEGACY_MEDIA_DIR)
  : '';
if (LEGACY_MEDIA_DIR) {
  // Only serve paths that look like files (have an extension)
  app.get(/^\/[^/]+\/.*\.\w+$/, (req, res, next) => {
    if (req.path.startsWith('/media/')) return next();
    const safePath = path.normalize(req.path).replace(/^(\.\.[/\\])+/, '');
    const fp = path.join(LEGACY_MEDIA_DIR, safePath);
    // Trailing separator matters: a bare prefix check also accepts a sibling
    // directory whose name merely starts with LEGACY_MEDIA_DIR.
    if (!fp.startsWith(LEGACY_MEDIA_DIR + path.sep)) return res.status(403).end();
    res.sendFile(fp, { headers: { 'Cache-Control': MEDIA_CACHE_CONTROL } }, (err) => {
      if (!err) return;
      if (res.headersSent) return res.end();
      next();
    });
  });
}

// ─── POST /fetch — queue Telegram media download ────────────────────────────
app.post('/fetch', requireAuth, async (req, res) => {
  const { channel, message_id, force, type: hintType, size: hintSize, mime_type: hintMime } = req.body;
  if (!channel || !message_id) {
    return res.status(400).json({ error: 'channel and message_id required' });
  }

  // Already exists?
  const existing = await findByTg(channel, message_id);
  if (existing) {
    if (existing.status === 'ready') {
      const stored = await resolveStored(existing);
      return res.json({
        ready: true,
        id: existing.id,
        url: `/media/${stored.id}.${stored.ext}`,
        type: existing.type,
      });
    }
    // Re-queue failed jobs for retry
    if (existing.status === 'failed' || existing.status === 'too_large') {
      await requeue(existing.id, { force });
      return res.json({ ready: false, id: existing.id, status: 'queued' });
    }
    // The mp4 is already on disk — only the transcode needs another attempt, not the download.
    if (existing.status === 'hls_failed') {
      await requeueOneHlsFailed(existing.id);
      return res.json({ ready: false, id: existing.id, status: 'transcoding' });
    }
    return res.json({
      ready: false,
      id: existing.id,
      status: existing.status,
    });
  }

  // Queue for background download
  const id = nanoid();
  await insert({
    id, source: 'telegram', tg_channel: channel, tg_message_id: message_id, force: force ? 1 : 0,
    type: hintType || null, size: hintSize || null, mime_type: hintMime || null,
  });

  res.json({ ready: false, id, status: 'queued' });
});

// ─── POST /fetch-batch — queue multiple Telegram media downloads ─────────────
app.post('/fetch-batch', requireAuth, async (req, res) => {
  const items = req.body;
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'Expected array of {channel, message_id}' });
  }

  const results = [];
  for (const { channel, message_id, type: hintType, size: hintSize, mime_type: hintMime } of items) {
    if (!channel || !message_id) {
      results.push({ channel, message_id, error: 'channel and message_id required' });
      continue;
    }

    const existing = await findByTg(channel, message_id);
    if (existing) {
      if (existing.status === 'ready') {
        const stored = await resolveStored(existing);
        results.push({
          ready: true,
          id: existing.id,
          url: `/media/${stored.id}.${stored.ext}`,
          type: existing.type,
          channel, message_id,
        });
      } else {
        if (existing.status === 'failed') await requeue(existing.id);
        else if (existing.status === 'hls_failed') await requeueOneHlsFailed(existing.id);
        results.push({
          ready: false,
          id: existing.id,
          status: existing.status === 'failed' ? 'queued'
            : existing.status === 'hls_failed' ? 'transcoding'
            : existing.status,
          channel, message_id,
        });
      }
      continue;
    }

    const id = nanoid();
    await insert({
      id, source: 'telegram', tg_channel: channel, tg_message_id: message_id,
      type: hintType || null, size: hintSize || null, mime_type: hintMime || null,
    });
    results.push({ ready: false, id, status: 'queued', channel, message_id });
  }

  res.json(results);
});

// ─── GET /status/:id — check media status ───────────────────────────────────
app.get('/status/:id', async (req, res) => {
  const record = await findById(req.params.id);
  if (!record) return res.status(404).json({ error: 'Not found' });

  if (record.status === 'ready') {
    const stored = await resolveStored(record);
    const result = {
      ready: true,
      id: record.id,
      // A de-duplicated row has no file of its own — the bytes, and therefore the URL,
      // belong to whatever resolveStored() points at.
      url: `/media/${stored.id}.${stored.ext}`,
      type: record.type,
      ext: record.ext,
      size: record.size,
      mime_type: record.mime_type,
    };
    // Whether a playlist exists is a property of the stored file, not of this pointer.
    if (record.type === 'video' && stored.hls_ready) {
      result.hls_url = `/hls/${stored.id}/index.m3u8`;
    }
    // Same for the poster: a de-duplicated row has none of its own and borrows the
    // original's, which is the same image by definition.
    if (stored.thumb_id) {
      result.thumb_url = `/media/${stored.thumb_id}.jpg`;
    }
    return res.json(result);
  }

  // Not ready yet, but chigua needs these to build the media row up front — an upload is
  // referenced before it has finished assembling.
  res.json({
    ready: false,
    id: record.id,
    status: record.status,
    type: record.type,
    ext: record.ext,
    size: record.size,
    mime_type: record.mime_type,
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
      const stored = await resolveStored(record);
      const result = {
        ready: true,
        id: record.id,
        url: `/media/${stored.id}.${stored.ext}`,
        type: record.type,
        channel, message_id,
      };
      if (record.type === 'video' && stored.hls_ready) {
        result.hls_url = `/hls/${stored.id}/index.m3u8`;
      }
      if (stored.thumb_id) {
        result.thumb_url = `/media/${stored.thumb_id}.jpg`;
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

  // Uploads get the same post-processing as Telegram downloads (worker.js): relocate the
  // moov atom so the file is seekable before it is ever served, then hand large videos to
  // the HLS worker. Previously uploads were inserted straight as 'ready', so they were
  // never faststarted and never transcoded.
  await faststartStored(type, id, ext);

  const needsHls = type === 'video' && buffer.length > HLS_SIZE_THRESHOLD;
  await insert({
    id, status: needsHls ? 'transcoding' : 'ready', type, ext, source: 'upload',
    content_hash: hash, size: buffer.length, mime_type: mime,
  });

  // `ready` here means "the mp4 is serveable", which is true either way — a transcoding
  // row already has its file on disk. Callers that need to know whether the streaming
  // variant exists should look at hls_ready via /status.
  res.json({
    ready: !needsHls,
    id,
    url: `/media/${id}.${ext}`,
    type,
    status: needsHls ? 'transcoding' : 'ready',
  });
});

// ─── POST /upload/chunk — one piece of a chunked upload ─────────────────────
// Callers reach this server through Cloudflare, which rejects bodies over 100MB at the
// edge, so large files have to arrive in pieces and be reassembled here.
app.options('/upload/chunk', uploadCors);
app.post('/upload/chunk', uploadCors, requireUploadAuth, async (req, res) => {
  const uploadId = req.headers['x-upload-id'];
  const index = Number(req.headers['x-chunk-index']);
  if (!uploadId || !Number.isInteger(index)) {
    return res.status(400).json({ error: 'x-upload-id and x-chunk-index required' });
  }
  maybeSweep();
  try {
    // A ticket caps the total it may stage, so a caller cannot fill the disk with one id.
    const size = await writePart(uploadId, index, req, req.uploadTicket?.maxSize ?? Infinity);
    res.json({ ok: true, index, size });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── POST /upload/finalize — accept the staged chunks and assemble in the background ──
app.options('/upload/finalize', uploadCors);
app.post('/upload/finalize', uploadCors, requireUploadAuth, async (req, res) => {
  const { uploadId, totalChunks, filename, mime_type } = req.body || {};

  let names;
  try {
    names = await listParts(uploadId);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  // A hole in the sequence would assemble into a silently corrupt file that only fails
  // later, at playback — refuse instead.
  if (!names.length || names.length !== Number(totalChunks)) {
    await discard(uploadId);
    return res.status(400).json({ error: `incomplete upload (${names.length}/${totalChunks} chunks)` });
  }

  const originalName = filename || 'upload';
  const ext = originalName.split('.').pop()?.toLowerCase() || 'bin';
  const isVideo = mime_type?.startsWith('video/') || ['mp4', 'mov', 'webm'].includes(ext);
  const type = isVideo ? 'video' : 'photo';
  const mime = mime_type || EXT_TO_MIME[ext] || 'application/octet-stream';

  // Assembling here would copy the whole file into place over NFS and then remux it —
  // minutes for a large upload, inside a browser request that Cloudflare cuts at ~100s.
  // Record the intent and let the assemble worker do it.
  const id = nanoid();
  try {
    // The staging directory takes the media id, so the row is all the worker needs to
    // find its bytes.
    await renameStaging(uploadId, id);
  } catch (err) {
    await discard(uploadId);
    return res.status(500).json({ error: `could not stage upload: ${err.message}` });
  }

  await insert({
    id, status: 'assembling', type, ext, source: 'upload', mime_type: mime,
  });

  res.status(202).json({
    ready: false,
    id,
    ext,
    url: `/media/${id}.${ext}`,
    type,
    status: 'assembling',
  });
});

// ─── POST /thumb/:id — generate a poster for an existing video ───────────────
// Only needed to backfill videos stored before thumbnails existed; new ones get theirs
// at ingest. Ordering is the caller's business — chigua prioritises by category, which
// this server knows nothing about.
app.post('/thumb/:id', requireAuth, async (req, res) => {
  const record = await findById(req.params.id);
  if (!record) return res.status(404).json({ error: 'Not found' });
  if (record.type !== 'video') return res.status(400).json({ error: 'not a video' });

  const stored = await resolveStored(record);
  if (stored.thumb_id) {
    return res.json({ id: record.id, thumb_url: `/media/${stored.thumb_id}.jpg`, generated: false });
  }
  if (stored.status !== 'ready' && stored.status !== 'transcoding') {
    return res.status(409).json({ error: `not available (${stored.status})` });
  }

  const thumbId = await generateThumbnail(stored.id, stored.ext);
  if (!thumbId) return res.status(500).json({ error: 'could not extract a frame' });
  res.json({ id: record.id, thumb_url: `/media/${thumbId}.jpg`, generated: true });
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
  <td>${r.status === 'ready' && r.ext ? (r.type === 'video' && r.hls_ready ? '<a class="file-link" href="' + (CDN_BASE || '') + '/hls/' + r.id + '/index.m3u8" target="_blank">' + r.id.slice(0,6) + '.m3u8</a>' : '<a class="file-link" href="' + (CDN_BASE || '') + '/media/' + r.id + '.' + r.ext + '" target="_blank">' + r.id.slice(0,6) + '.' + r.ext + '</a>') : '-'}</td>
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
startAssembleWorker();

app.listen(PORT, () => {
  console.log(`[media-server] Listening on :${PORT}`);
});
