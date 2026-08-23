/**
 * Reconcile hls_ready against what is actually on disk.
 *
 * The migration in db.js seeds hls_ready from the old size rule, which reproduces the
 * previous (inferred) behaviour but over-claims for rows whose playlist was never built —
 * notably videos uploaded via POST /upload before uploads were wired into the HLS worker.
 * This checks each row for a real index.m3u8 and corrects both directions.
 *
 * Dry-run by default. Pass --apply to write.
 *
 *   node scripts/verify-hls-ready.mjs
 *   node scripts/verify-hls-ready.mjs --apply
 */
import fs from 'fs/promises';
import path from 'path';
import client from '../src/db.js';

const APPLY = process.argv.includes('--apply');
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');

function hlsPlaylist(id) {
  return path.join(DATA_DIR, 'hls', id.slice(0, 2), id.slice(2, 4), id, 'index.m3u8');
}

const r = await client.execute(
  "SELECT id, hls_ready FROM media WHERE type = 'video' AND status = 'ready'"
);
console.log(`checking ${r.rows.length} ready videos against ${DATA_DIR}/hls`);

const toSet = [];
const toClear = [];

for (const row of r.rows) {
  const exists = await fs.access(hlsPlaylist(row.id)).then(() => true, () => false);
  if (exists && !row.hls_ready) toSet.push(row.id);
  if (!exists && row.hls_ready) toClear.push(row.id);
}

console.log(`  playlist present but flag unset: ${toSet.length}`);
console.log(`  flag set but playlist missing:   ${toClear.length}`);

if (!APPLY) {
  console.log('\nDRY RUN — re-run with --apply to write.');
  process.exit(0);
}

for (const id of toSet) {
  await client.execute({ sql: 'UPDATE media SET hls_ready = 1 WHERE id = ?', args: [id] });
}
for (const id of toClear) {
  await client.execute({ sql: 'UPDATE media SET hls_ready = 0 WHERE id = ?', args: [id] });
}
console.log(`\nupdated ${toSet.length + toClear.length} rows`);
