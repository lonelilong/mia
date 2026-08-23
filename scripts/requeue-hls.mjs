/**
 * Send hls_failed videos back to the HLS worker.
 *
 * These have their mp4 on disk but no playlist, so they are unservable (videos above
 * HLS_SIZE_THRESHOLD are HLS-only). Most failed against the old flat 600s ffmpeg timeout,
 * which now scales with duration — so a retry is likely to succeed without any re-download.
 *
 * Transcoding is CPU-heavy and competes with the download worker, so requeue in batches
 * rather than releasing hundreds at once.
 *
 *   node scripts/requeue-hls.mjs            # report only
 *   node scripts/requeue-hls.mjs --apply    # requeue all
 *   node scripts/requeue-hls.mjs --apply 20 # requeue the 20 smallest
 */
import client, { requeueHlsFailed } from '../src/db.js';

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find(a => /^\d+$/.test(a));
const limit = limitArg ? Number(limitArg) : null;

const stats = await client.execute(
  "SELECT COUNT(*) n, COALESCE(ROUND(SUM(size)/1073741824.0, 1), 0) gb FROM media WHERE status = 'hls_failed'"
);
const { n, gb } = stats.rows[0];
console.log(`hls_failed: ${n} videos, ${gb} GB`);
if (!Number(n)) process.exit(0);

if (!APPLY) {
  console.log(`\nDRY RUN — would requeue ${limit ?? n}. Re-run with --apply${limit ? ` ${limit}` : ''}.`);
  process.exit(0);
}

const requeued = await requeueHlsFailed(limit);
console.log(`requeued ${requeued} for transcoding`);
