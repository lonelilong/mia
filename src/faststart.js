import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import { getPath } from './storage.js';

const execFileAsync = promisify(execFile);

// MP4s downloaded from Telegram normally carry their `moov` atom at the end of
// the file, so a player has to fetch the tail before it can start — an extra
// round trip per video, and worse over a CDN. Re-muxing with +faststart moves
// `moov` to the front. It is a stream copy: no re-encode, no quality loss.
//
// Best effort by design: on any failure the original file is left untouched,
// since a non-faststart video still plays, just more slowly.
export async function faststart(src, { timeout = 300_000 } = {}) {
  const tmp = `${src}.faststart.tmp.mp4`;
  try {
    const before = (await fs.stat(src)).size;
    await execFileAsync('ffmpeg', [
      '-v', 'error',
      '-i', src,
      '-c', 'copy',
      '-movflags', '+faststart',
      '-y', tmp,
    ], { timeout });

    // The rename below is destructive, so refuse to overwrite a good original
    // with a suspiciously small output. A stream copy only relocates `moov`,
    // so in practice the result lands within ~0.5% of the input size; losing
    // more than 10% means ffmpeg truncated the file while still exiting 0.
    const after = (await fs.stat(tmp)).size;
    if (after < before * 0.9) {
      throw new Error(`output too small (${after} < ${before} bytes), keeping original`);
    }

    await fs.rename(tmp, src);
    return true;
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    // execFile reports only "Command failed: ffmpeg ..." and hides the actual
    // diagnostic in stderr, which makes failures impossible to triage.
    const detail = String(err.stderr || '').trim().split('\n').filter(Boolean).pop();
    if (detail) err.message = `${detail} (while remuxing ${src})`;
    throw err;
  }
}

// Convenience wrapper for stored media: only touches mp4 videos, and swallows
// failures so a bad remux can never fail an otherwise successful download.
export async function faststartStored(type, id, ext, srcPath) {
  if (type !== 'video' || ext !== 'mp4') return false;
  try {
    await faststart(srcPath || getPath(type, id, ext));
    return true;
  } catch (err) {
    console.error(`[faststart] ${id} skipped: ${err.message}`);
    return false;
  }
}
