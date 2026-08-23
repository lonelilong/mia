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
    force       INTEGER DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Added after the fact: whether an HLS playlist actually exists for this row, and why it
// doesn't if it doesn't. Before this, hls_url was inferred from size alone, which lied
// whenever a transcode failed.
//
// The ALTER only succeeds once, so the backfill rides along with it: without seeding
// hls_ready for rows that predate the column, every existing video would abruptly stop
// advertising hls_url on deploy. Seeding by the old size rule reproduces exactly the
// behaviour those rows already had; scripts/verify-hls-ready.mjs refines it against disk.
const addedHlsReady = await client
  .execute('ALTER TABLE media ADD COLUMN hls_ready INTEGER DEFAULT 0')
  .then(() => true, () => false);
await client.execute('ALTER TABLE media ADD COLUMN hls_error TEXT').catch(() => {});

if (addedHlsReady) {
  const r = await client.execute(
    "UPDATE media SET hls_ready = 1 WHERE status = 'ready' AND type = 'video' AND size > 10485760"
  );
  console.log(`[db] hls_ready backfilled for ${r.rowsAffected} existing videos`);
}

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
    sql: `INSERT INTO media (id, status, type, ext, source, tg_channel, tg_message_id, content_hash, size, mime_type, force)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      record.id, record.status || 'queued',
      record.type || null, record.ext || null, record.source,
      record.tg_channel || null, record.tg_message_id || null,
      record.content_hash || null, record.size || null, record.mime_type || null,
      record.force || 0,
    ],
  });
}

export async function updateReady(id, { type, ext, contentHash, size, mimeType, status = 'ready' }) {
  await client.execute({
    sql: "UPDATE media SET status = ?, type = ?, ext = ?, content_hash = ?, size = ?, mime_type = ? WHERE id = ?",
    args: [status, type, ext, contentHash, size, mimeType, id],
  });
}

export async function updateFailed(id, error, status = 'failed') {
  await client.execute({
    sql: "UPDATE media SET status = ?, error = ? WHERE id = ?",
    args: [status, error, id],
  });
}

export async function requeue(id, { force } = {}) {
  const sql = force
    ? "UPDATE media SET status = 'queued', error = NULL, force = 1 WHERE id = ?"
    : "UPDATE media SET status = 'queued', error = NULL WHERE id = ?";
  await client.execute({ sql, args: [id] });
}

export async function getStats() {
  const counts = await client.execute(
    "SELECT status, COUNT(*) as cnt, COALESCE(SUM(size), 0) as total_size FROM media GROUP BY status"
  );
  const recent = await client.execute(
    "SELECT id, status, type, ext, tg_channel, tg_message_id, size, error, hls_ready, hls_error, created_at FROM media ORDER BY created_at DESC LIMIT 50"
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
    sql: `SELECT * FROM media WHERE status = 'queued' ORDER BY
      CASE
        WHEN type = 'photo' OR (type IS NOT NULL AND type != 'video') THEN 0
        WHEN type = 'video' AND size <= 104857600 THEN 1
        WHEN type = 'video' AND size <= 209715200 THEN 2
        WHEN type = 'video' AND size > 209715200 THEN 3
        ELSE 4
      END,
      created_at ASC
      LIMIT ?`,
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

export async function updateHlsReady(id) {
  await client.execute({
    sql: "UPDATE media SET status = 'ready', hls_ready = 1, hls_error = NULL WHERE id = ?",
    args: [id],
  });
}

// Videos above HLS_SIZE_THRESHOLD are served as HLS only — never as a direct mp4 — so a
// failed transcode must NOT reach 'ready'. It parks in its own status instead of 'failed'
// for two reasons: 'failed' means the Telegram download failed, and /fetch re-queues that,
// which would re-download a file already sitting on disk. From here the only thing missing
// is the transcode, so requeue-hls.mjs can retry it without touching the network.
export async function updateHlsFailed(id, error) {
  await client.execute({
    sql: "UPDATE media SET status = 'hls_failed', hls_ready = 0, hls_error = ? WHERE id = ?",
    args: [error, id],
  });
}

/** Send hls_failed rows back to the HLS worker. Returns how many were requeued. */
export async function requeueHlsFailed(limit = null) {
  const sql = limit
    ? "UPDATE media SET status = 'transcoding' WHERE id IN (SELECT id FROM media WHERE status = 'hls_failed' ORDER BY size ASC LIMIT ?)"
    : "UPDATE media SET status = 'transcoding' WHERE status = 'hls_failed'";
  const r = await client.execute({ sql, args: limit ? [limit] : [] });
  return r.rowsAffected;
}

// Videos larger than this go through HLS transcoding before becoming ready
export const HLS_SIZE_THRESHOLD = 10 * 1024 * 1024;
