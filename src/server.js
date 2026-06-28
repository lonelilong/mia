import 'dotenv/config';
import express from 'express';
import { nanoid } from 'nanoid';
import { findById, findByTg, findByContentHash, insert, updateReady } from './db.js';
import { save, read, contentHash } from './storage.js';
import { EXT_TO_MIME } from './telegram.js';
import { startWorker } from './worker.js';

const app = express();
const PORT = process.env.PORT || 3002;
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!AUTH_TOKEN || token === AUTH_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

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

// ─── POST /fetch — queue Telegram media download ────────────────────────────
app.post('/fetch', requireAuth, async (req, res) => {
  const { channel, message_id } = req.body;
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
    // Still queued or failed — return current status
    return res.json({
      ready: false,
      id: existing.id,
      status: existing.status,
    });
  }

  // Queue for background download
  const id = nanoid();
  await insert({ id, source: 'telegram', tg_channel: channel, tg_message_id: message_id });

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
        results.push({
          ready: false,
          id: existing.id,
          status: existing.status,
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
    return res.json({
      ready: true,
      id: record.id,
      url: `/media/${record.id}.${record.ext}`,
      type: record.type,
    });
  }

  res.json({
    ready: false,
    id: record.id,
    status: record.status,
    error: record.error || undefined,
  });
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

// Start worker and server
startWorker();

app.listen(PORT, () => {
  console.log(`[media-server] Listening on :${PORT}`);
});
