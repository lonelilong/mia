/**
 * Requeue already-ready videos under the old HLS_SIZE_THRESHOLD for transcoding.
 *
 * These were exempted from HLS under the old policy (serve small videos as a direct mp4)
 * and have no playlist. The mp4 stays on disk and keeps serving as-is throughout — chigua
 * only re-polls mia for media it has no file_path for yet, so this is invisible to already
 * -published pages until their HLS is actually ready.
 *
 * Transcoding is CPU-heavy and competes with the download worker, so requeue in batches
 * rather than releasing thousands at once.
 *
 *   node scripts/backfill-hls-small-videos.mjs                # report only
 *   node scripts/backfill-hls-small-videos.mjs --apply         # requeue all
 *   node scripts/backfill-hls-small-videos.mjs --apply 50      # requeue the 50 smallest
 */
import client from '../src/db.js';

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find(a => /^\d+$/.test(a));
const limit = limitArg ? Number(limitArg) : null;

const stats = await client.execute(`
  SELECT COUNT(*) n, COALESCE(ROUND(SUM(size)/1073741824.0, 2), 0) gb
  FROM media
  WHERE status = 'ready' AND type = 'video' AND hls_ready = 0 AND duplicate_of IS NULL
`);
const { n, gb } = stats.rows[0];
console.log(`ready videos with no HLS: ${n}, ${gb} GB`);
if (!Number(n)) process.exit(0);

if (!APPLY) {
  console.log(`\nDRY RUN — would requeue ${limit ?? n}. Re-run with --apply${limit ? ` ${limit}` : ''}.`);
  process.exit(0);
}

const sql = limit
  ? "UPDATE media SET status = 'transcoding' WHERE id IN (SELECT id FROM media WHERE status = 'ready' AND type = 'video' AND hls_ready = 0 AND duplicate_of IS NULL ORDER BY size ASC LIMIT ?)"
  : "UPDATE media SET status = 'transcoding' WHERE status = 'ready' AND type = 'video' AND hls_ready = 0 AND duplicate_of IS NULL";
const r = await client.execute({ sql, args: limit ? [limit] : [] });
console.log(`requeued ${r.rowsAffected} for transcoding`);
