import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';

/**
 * On-disk staging for chunked uploads.
 *
 * chigua reaches this server through Cloudflare, which rejects any request body over
 * 100MB at the edge, so large files arrive as a sequence of sub-limit chunks. Each chunk
 * is a separate part file; they are concatenated on finalize.
 */

const ROOT = () => path.resolve(process.env.UPLOAD_TMP_DIR || path.join(process.env.DATA_DIR || '/data', 'tmp-uploads'));

// Upload ids come from a client, so they must never escape the staging dir.
function safeId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null;
  return id;
}

const dirFor = id => path.join(ROOT(), id);

export async function writePart(uploadId, index, stream, maxTotal = Infinity) {
  const id = safeId(uploadId);
  if (!id) throw new Error('invalid upload id');
  if (!Number.isInteger(index) || index < 0 || index > 100000) throw new Error('invalid chunk index');

  const dir = dirFor(id);
  await fsp.mkdir(dir, { recursive: true });
  const part = path.join(dir, String(index).padStart(6, '0'));
  await pipeline(stream, fs.createWriteStream(part));
  const { size } = await fsp.stat(part);

  // Enforced while the upload is still arriving rather than at assembly time, so a caller
  // cannot stage far more than its ticket allows before being told no.
  if (Number.isFinite(maxTotal)) {
    let total = 0;
    for (const name of await listParts(id)) {
      total += (await fsp.stat(path.join(dir, name))).size;
    }
    if (total > maxTotal) {
      await discard(id);
      throw new Error('upload exceeds the size allowed by this ticket');
    }
  }

  return size;
}

/** Move staged parts under a new id, so the media row's own id locates its bytes. */
export async function renameStaging(fromId, toId) {
  const from = safeId(fromId);
  const to = safeId(toId);
  if (!from || !to) throw new Error('invalid upload id');
  await fsp.rename(dirFor(from), dirFor(to));
}

export async function listParts(uploadId) {
  const id = safeId(uploadId);
  if (!id) throw new Error('invalid upload id');
  try {
    return (await fsp.readdir(dirFor(id))).sort();
  } catch {
    return [];
  }
}

/**
 * Concatenate the parts into `dest`, returning { size, hash }.
 *
 * Streams rather than buffering: the existing /upload path holds the whole body in
 * memory, which is survivable for a Telegram photo but not for a 1GB+ author upload on a
 * 6GB box. The hash is computed during the copy so the file is read only once.
 */
export async function assembleTo(uploadId, dest, names) {
  const id = safeId(uploadId);
  if (!id) throw new Error('invalid upload id');
  const dir = dirFor(id);

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(dest);
  let size = 0;

  try {
    for (const name of names) {
      const rs = fs.createReadStream(path.join(dir, name));
      for await (const chunk of rs) {
        hash.update(chunk);
        size += chunk.length;
        if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
      }
    }
    await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    await fsp.rm(dest, { force: true }).catch(() => {});
    throw err;
  }

  return { size, hash: hash.digest('hex') };
}

export async function discard(uploadId) {
  const id = safeId(uploadId);
  if (!id) return;
  await fsp.rm(dirFor(id), { recursive: true, force: true }).catch(() => {});
}

/** Reclaim staging dirs from uploads that were never finalized. */
export async function sweepStale(maxAgeMs = 12 * 60 * 60 * 1000) {
  let entries;
  try {
    entries = await fsp.readdir(ROOT());
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of entries) {
    try {
      const { mtimeMs } = await fsp.stat(path.join(ROOT(), name));
      if (mtimeMs < cutoff) {
        await fsp.rm(path.join(ROOT(), name), { recursive: true, force: true });
        removed++;
      }
    } catch {}
  }
  return removed;
}

let lastSweep = 0;
export function maybeSweep(intervalMs = 15 * 60 * 1000) {
  const now = Date.now();
  if (now - lastSweep < intervalMs) return;
  lastSweep = now;
  sweepStale().catch(() => {});
}
