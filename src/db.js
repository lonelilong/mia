import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.LIBSQL_URL || 'file:media.db',
});

await client.execute(`
  CREATE TABLE IF NOT EXISTS media (
    id          TEXT PRIMARY KEY,
    status      TEXT NOT NULL DEFAULT 'queued',
    type        TEXT,
    ext         TEXT,
    source      TEXT NOT NULL,
    tg_channel  TEXT,
    tg_message_id INTEGER,
    content_hash TEXT,
    size        INTEGER,
    mime_type   TEXT,
    error       TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

await client.execute(`
  CREATE INDEX IF NOT EXISTS idx_media_tg
  ON media (tg_channel, tg_message_id)
`);

await client.execute(`
  CREATE INDEX IF NOT EXISTS idx_media_content_hash
  ON media (content_hash)
`);

await client.execute(`
  CREATE INDEX IF NOT EXISTS idx_media_status
  ON media (status)
`);

export default client;

export async function findByTg(channel, messageId) {
  const r = await client.execute({
    sql: 'SELECT * FROM media WHERE tg_channel = ? AND tg_message_id = ?',
    args: [channel, messageId],
  });
  return r.rows[0] || null;
}

export async function findByContentHash(hash) {
  const r = await client.execute({
    sql: "SELECT * FROM media WHERE content_hash = ? AND status = 'ready' LIMIT 1",
    args: [hash],
  });
  return r.rows[0] || null;
}

export async function findById(id) {
  const r = await client.execute({
    sql: 'SELECT * FROM media WHERE id = ?',
    args: [id],
  });
  return r.rows[0] || null;
}

export async function insert(record) {
  await client.execute({
    sql: `INSERT INTO media (id, status, type, ext, source, tg_channel, tg_message_id, content_hash, size, mime_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      record.id, record.status || 'queued',
      record.type || null, record.ext || null, record.source,
      record.tg_channel || null, record.tg_message_id || null,
      record.content_hash || null, record.size || null, record.mime_type || null,
    ],
  });
}

export async function updateReady(id, { type, ext, contentHash, size, mimeType, status = 'ready' }) {
  await client.execute({
    sql: "UPDATE media SET status = ?, type = ?, ext = ?, content_hash = ?, size = ?, mime_type = ? WHERE id = ?",
    args: [status, type, ext, contentHash, size, mimeType, id],
  });
}

export async function updateFailed(id, error) {
  await client.execute({
    sql: "UPDATE media SET status = 'failed', error = ? WHERE id = ?",
    args: [error, id],
  });
}

export async function requeue(id) {
  await client.execute({
    sql: "UPDATE media SET status = 'queued', error = NULL WHERE id = ?",
    args: [id],
  });
}

export async function getStats() {
  const counts = await client.execute(
    "SELECT status, COUNT(*) as cnt, COALESCE(SUM(size), 0) as total_size FROM media GROUP BY status"
  );
  const recent = await client.execute(
    "SELECT id, status, type, ext, tg_channel, tg_message_id, size, error, created_at FROM media ORDER BY created_at DESC LIMIT 50"
  );
  const byChannel = await client.execute(
    "SELECT tg_channel, status, COUNT(*) as cnt FROM media WHERE tg_channel IS NOT NULL GROUP BY tg_channel, status ORDER BY tg_channel"
  );
  return { counts: counts.rows, recent: recent.rows, byChannel: byChannel.rows };
}

export async function requeueAll() {
  const r = await client.execute("UPDATE media SET status = 'queued', error = NULL WHERE status = 'failed'");
  return r.rowsAffected;
}

export async function getQueued(limit = 10) {
  const r = await client.execute({
    sql: "SELECT * FROM media WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?",
    args: [limit],
  });
  return r.rows;
}

export async function getTranscoding(limit = 5) {
  const r = await client.execute({
    sql: "SELECT * FROM media WHERE status = 'transcoding' ORDER BY created_at ASC LIMIT ?",
    args: [limit],
  });
  return r.rows;
}

export async function updateStatus(id, status) {
  await client.execute({
    sql: 'UPDATE media SET status = ? WHERE id = ?',
    args: [status, id],
  });
}

// Videos larger than this go through HLS transcoding before becoming ready
export const HLS_SIZE_THRESHOLD = 10 * 1024 * 1024;
