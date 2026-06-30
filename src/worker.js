import { getQueued, updateReady, updateFailed, findByContentHash, HLS_SIZE_THRESHOLD } from './db.js';
import { save, contentHash } from './storage.js';
import { fetchMedia } from './telegram.js';

const CALLBACK_URL = process.env.CALLBACK_URL || '';
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const POLL_INTERVAL = 2000;

let running = false;

async function notifyReady(record) {
  if (!CALLBACK_URL) return;
  try {
    await fetch(CALLBACK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        id: record.id,
        url: `/media/${record.id}.${record.ext}`,
        type: record.type,
        tg_channel: record.tg_channel,
        tg_message_id: record.tg_message_id,
      }),
    });
    console.log(`[worker] Notified callback for ${record.id}`);
  } catch (err) {
    console.error(`[worker] Callback failed for ${record.id}:`, err.message);
  }
}

// Serialize Telegram downloads — GramJS can't handle concurrent downloadMedia calls
let downloadQueue = Promise.resolve();

function serializedFetch(channel, messageId, opts) {
  const result = downloadQueue.then(() => fetchMedia(channel, messageId, opts));
  // Update the chain regardless of success/failure
  downloadQueue = result.then(() => {}, () => {});
  return result;
}

async function processJob(job) {
  console.log(`[worker] Processing ${job.id} (${job.tg_channel}/${job.tg_message_id})`);
  try {
    const media = await serializedFetch(job.tg_channel, job.tg_message_id, { force: !!job.force });
    if (!media) {
      await updateFailed(job.id, 'Media not found on Telegram');
      return;
    }

    const hash = contentHash(media.buffer);

    // Dedup by content
    const dupe = await findByContentHash(hash);
    if (dupe) {
      await updateReady(job.id, {
        type: media.type, ext: dupe.ext,
        contentHash: hash, size: media.size, mimeType: media.mime,
      });
      console.log(`[worker] ${job.id} deduplicated to ${dupe.id}`);
      await notifyReady({ ...job, type: media.type, ext: dupe.ext });
      return;
    }

    await save(media.type, job.id, media.ext, media.buffer);

    const needsHls = media.type === 'video' && media.size > HLS_SIZE_THRESHOLD;
    await updateReady(job.id, {
      type: media.type, ext: media.ext,
      contentHash: hash, size: media.size, mimeType: media.mime,
      status: needsHls ? 'transcoding' : 'ready',
    });
    console.log(`[worker] ${job.id} ${needsHls ? 'transcoding' : 'ready'} (${media.type} ${media.size} bytes)`);
    if (!needsHls) {
      await notifyReady({ ...job, type: media.type, ext: media.ext });
    }
  } catch (err) {
    const status = err.code === 'TOO_LARGE' ? 'too_large' : 'failed';
    console.error(`[worker] ${job.id} ${status}:`, err.message);
    await updateFailed(job.id, err.message, status);
  }
}

export function startWorker() {
  if (running) return;
  running = true;
  console.log('[worker] Started');

  async function poll() {
    while (running) {
      const jobs = await getQueued(1);
      if (jobs.length) {
        await processJob(jobs[0]);
      } else {
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
      }
    }
  }

  poll().catch(err => {
    console.error('[worker] Fatal:', err);
    running = false;
  });
}

export function stopWorker() {
  running = false;
}
