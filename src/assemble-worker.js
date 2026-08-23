import fsp from 'fs/promises';
import { getAssembling, updateReady, updateFailed, findByContentHash } from './db.js';
import { assembleTo, listParts, discard } from './chunk-store.js';
import { getPath } from './storage.js';
import { faststartStored } from './faststart.js';
import { HLS_SIZE_THRESHOLD } from './db.js';

/**
 * Turns staged chunks into a stored media file.
 *
 * This used to happen inline in POST /upload/finalize, but for a large file it means
 * copying the whole thing into place over NFS and then running a full ffmpeg remux —
 * minutes of work. Uploads now come straight from a browser, so holding the request open
 * for that would hit Cloudflare's ~100s origin timeout after every byte had already
 * arrived. finalize records the intent and returns; this drains the backlog.
 *
 * The staging directory is named after the media id (finalize renames it), so a row in
 * 'assembling' is all the state needed to find its bytes.
 */

const POLL_INTERVAL = 2000;
let running = false;

async function assembleOne(job) {
  const names = await listParts(job.id);
  if (!names.length) {
    // Nothing on disk: the parts were swept, or finalize died between the rename and the
    // insert. There is nothing to retry with.
    await updateFailed(job.id, 'staged chunks missing');
    console.error(`[assemble] ${job.id} failed: no staged chunks`);
    return;
  }

  const dest = getPath(job.type, job.id, job.ext);
  try {
    const { size, hash } = await assembleTo(job.id, dest, names);
    if (!size) throw new Error('assembled file is empty');

    // Dedup can only run once the bytes are known, so an already-stored file costs one
    // wasted write which is then removed.
    const dupe = await findByContentHash(hash);
    if (dupe && dupe.id !== job.id) {
      await fsp.rm(dest, { force: true }).catch(() => {});
      await updateReady(job.id, {
        type: job.type, ext: dupe.ext, contentHash: hash,
        size, mimeType: job.mime_type, duplicateOf: dupe.id,
      });
      console.log(`[assemble] ${job.id} deduplicated to ${dupe.id}`);
      return;
    }

    await faststartStored(job.type, job.id, job.ext);

    const needsHls = job.type === 'video' && size > HLS_SIZE_THRESHOLD;
    await updateReady(job.id, {
      type: job.type, ext: job.ext, contentHash: hash,
      size, mimeType: job.mime_type,
      status: needsHls ? 'transcoding' : 'ready',
    });
    console.log(`[assemble] ${job.id} ${needsHls ? 'transcoding' : 'ready'} (${size} bytes)`);
  } catch (err) {
    await fsp.rm(dest, { force: true }).catch(() => {});
    await updateFailed(job.id, `assemble: ${err.message}`.slice(0, 2000));
    console.error(`[assemble] ${job.id} failed:`, err.message);
  } finally {
    await discard(job.id);
  }
}

export function startAssembleWorker() {
  if (running) return;
  running = true;
  console.log('[assemble] Worker started');

  async function poll() {
    while (running) {
      const jobs = await getAssembling(1);
      if (jobs.length) await assembleOne(jobs[0]);
      else await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
  }

  poll().catch(err => {
    console.error('[assemble] Fatal:', err);
    running = false;
  });
}

export function stopAssembleWorker() {
  running = false;
}
