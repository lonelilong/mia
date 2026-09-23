import { TelegramClient, utils } from 'telegram';
import bigInt from 'big-integer';
import { StringSession } from 'telegram/sessions/index.js';
import { Logger } from 'telegram/extensions/Logger.js';
import fs from 'fs/promises';
import path from 'path';
import { localStagingPath } from './storage.js';

class QuietLogger extends Logger {
  error(msg) {
    const s = typeof msg === 'function' ? msg() : String(msg ?? '');
    if (s.includes('TIMEOUT')) return;
    super.error(msg);
  }
}

let client = null;

export async function connect() {
  if (client?.connected) return client;
  if (client) {
    try { await client.disconnect(); } catch {}
  }
  client = new TelegramClient(
    new StringSession(process.env.SESSION_STRING || ''),
    parseInt(process.env.API_ID),
    process.env.API_HASH,
    { connectionRetries: 5, baseLogger: new QuietLogger() },
  );
  await client.connect();
  console.log('[telegram] Connected');
  return client;
}

const MIME_TO_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov',
};

const EXT_TO_MIME = Object.fromEntries(Object.entries(MIME_TO_EXT).map(([k, v]) => [v, k]));

const MIN_DOWNLOAD_TIMEOUT = parseInt(process.env.DOWNLOAD_TIMEOUT) || 300_000;
const TIMEOUT_PER_MB = 3_000; // 3s per MB
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 200 * 1024 * 1024; // 200MB

function parseMediaMeta(msg) {
  const isVideo = msg.media.className === 'MessageMediaDocument' &&
    msg.media.document?.mimeType?.startsWith('video/');
  const isPhoto = msg.media.className === 'MessageMediaPhoto';
  const isDoc = msg.media.className === 'MessageMediaDocument' && !isVideo;

  if (isVideo) {
    const mime = msg.media.document.mimeType;
    return { type: 'video', mime, ext: MIME_TO_EXT[mime] || 'mp4', size: Number(msg.media.document.size ?? 0) };
  } else if (isPhoto) {
    const sizes = msg.media.photo.sizes || [];
    const biggest = sizes[sizes.length - 1];
    return { type: 'photo', mime: 'image/jpeg', ext: 'jpg', size: biggest?.size || 0 };
  } else if (isDoc) {
    const mime = msg.media.document.mimeType || 'application/octet-stream';
    return { type: 'photo', mime, ext: MIME_TO_EXT[mime] || 'bin', size: Number(msg.media.document.size ?? 0) };
  }
  return null;
}

export async function fetchMedia(channel, messageId, { force = false, id } = {}) {
  const tg = await connect();

  const entity = await tg.getEntity(channel);
  const [msg] = await tg.getMessages(entity, { ids: [messageId] });
  if (!msg || !msg.media) return null;

  const meta = parseMediaMeta(msg);
  if (!meta) return null;
  const { type, ext, mime, size } = meta;

  if (!force && size > MAX_FILE_SIZE) {
    const mb = (size / 1048576).toFixed(1);
    const err = new Error(`File too large: ${mb}MB exceeds ${MAX_FILE_SIZE / 1048576}MB limit`);
    err.code = 'TOO_LARGE';
    throw err;
  }

  // Dynamic timeout: base 5min + 3s per MB
  const sizeMb = size / 1048576;
  const dlTimeout = Math.max(MIN_DOWNLOAD_TIMEOUT, Math.round(sizeMb * TIMEOUT_PER_MB));
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Telegram download timed out (${Math.round(dlTimeout / 1000)}s for ${sizeMb.toFixed(1)}MB)`)), dlTimeout));

  // Videos stream straight to the local staging path — each chunk is written to disk and
  // discarded immediately, instead of GramJS's default behaviour of accumulating every chunk
  // in memory and concatenating them at the end — which briefly holds ~2x the file's size
  // in RAM right as the download finishes. A large-enough video (observed: a 1.5GB file
  // reaching ~3.6GB RSS) gets OOM-killed by the host right at that peak. Photos stay
  // buffered in memory; they're never large enough for this to matter.
  const destPath = type === 'video' && id ? localStagingPath(id, ext) : null;
  if (destPath) await fs.mkdir(path.dirname(destPath), { recursive: true });

  let lastLog = 0;
  const progressCallback = (downloaded, total) => {
    const now = Date.now();
    if (now - lastLog < 3000) return;
    lastLog = now;
    const pct = total ? ((Number(downloaded) / Number(total)) * 100).toFixed(1) : '?';
    const mb = (Number(downloaded) / 1048576).toFixed(1);
    const totalMb = total ? (Number(total) / 1048576).toFixed(1) : '?';
    console.log(`[telegram] Downloading ${channel}/${messageId}: ${mb}/${totalMb} MB (${pct}%)`);
  };

  if (destPath) {
    const abort = { aborted: false };
    const downloadPromise = downloadResumable(tg, entity, msg, destPath, size, progressCallback, abort);
    try {
      await Promise.race([downloadPromise, timeoutPromise]);
    } catch (err) {
      // Stop the loop from carrying on in the background once the overall budget is spent.
      abort.aborted = true;
      throw err;
    }
    return { filePath: destPath, type, ext, mime, size };
  }

  const result = await Promise.race([tg.downloadMedia(msg, { progressCallback }), timeoutPromise]);
  if (!result) return null;
  return { buffer: Buffer.from(result), type, ext, mime, size: result.length };
}

// GramJS retries a failed chunk only when the error is exactly 'TIMEOUT', and only once.
// Telegram's "-503: Timeout (caused by upload.GetFile)" doesn't match, so a single stalled
// chunk aborted the whole file and the next attempt started over from 0 — large videos kept
// failing at a different point every time. This streams chunks to disk itself and, on a
// failure, resumes from the bytes already written. Resuming there is always a valid offset:
// every chunk but the last is exactly partSize, which divides Telegram's 1MB boundary.
const MAX_CHUNK_FAILURES = 5;

async function downloadResumable(tg, entity, msg, destPath, size, onProgress, abort) {
  const partSize = utils.getAppropriatedPartSize(bigInt(size)) * 1024;
  let media = msg.media;
  let written = 0;
  let failures = 0;

  const fh = await fs.open(destPath, 'w');
  try {
    while (written < size) {
      try {
        for await (const chunk of tg.iterDownload({
          file: media,
          offset: bigInt(written),
          requestSize: partSize,
          fileSize: bigInt(size),
        })) {
          if (abort.aborted) return;
          await fh.write(chunk, 0, chunk.length, written);
          written += chunk.length;
          failures = 0;
          onProgress(written, size);
        }
        if (written < size) throw new Error(`download ended early at ${written}/${size} bytes`);
      } catch (err) {
        if (abort.aborted) return;
        failures++;
        if (failures > MAX_CHUNK_FAILURES) throw err;
        const mb = (written / 1048576).toFixed(1);
        console.warn(`[telegram] chunk failed at ${mb}MB (${failures}/${MAX_CHUNK_FAILURES}), resuming: ${err.message}`);
        // A long download can outlive the message's file reference; fetch a fresh one.
        if (/FILE_REFERENCE/.test(err.errorMessage || err.message || '')) {
          const [fresh] = await tg.getMessages(entity, { ids: [msg.id] });
          if (fresh?.media) media = fresh.media;
        }
        await new Promise(r => setTimeout(r, 2000 * failures));
      }
    }
  } finally {
    await fh.close();
  }
}

export { EXT_TO_MIME };
