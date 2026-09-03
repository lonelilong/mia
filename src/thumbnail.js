import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { nanoid } from 'nanoid';
import { insert, setThumb } from './db.js';
import { getPath } from './storage.js';

const execFileAsync = promisify(execFile);

/**
 * Extract a video's poster frame and store it as an ordinary photo record.
 *
 * Keeping the thumbnail as a normal media row means it is served by the existing
 * /media/<id>.jpg route and reaches the CDN with no extra routing, unlike a dedicated
 * thumbnails directory which would sit on local disk the CDN cannot see.
 *
 * The first frame is used deliberately: creators of this content put a cover image there,
 * so frame 0 is the poster they intended. ffmpeg's `thumbnail` filter would pick a
 * statistically representative frame instead and skip straight past it.
 *
 * Best-effort — a video with no poster is still perfectly usable, so failures are logged
 * and swallowed rather than blocking the file from becoming ready.
 */
export async function generateThumbnail(videoId, ext, srcPath) {
  const src = srcPath || getPath('video', videoId, ext);
  const thumbId = nanoid();
  const dest = getPath('photo', thumbId, 'jpg');

  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await execFileAsync('ffmpeg', [
      '-i', src,
      '-frames:v', '1',
      '-vf', 'scale=640:-2',
      '-q:v', '3',
      '-f', 'image2',
      '-y', dest,
    ], { timeout: 60_000, maxBuffer: 512 * 1024 });

    const { size } = await fs.stat(dest);
    if (!size) throw new Error('empty thumbnail');

    await insert({
      id: thumbId, status: 'ready', type: 'photo', ext: 'jpg',
      source: 'thumbnail', size, mime_type: 'image/jpeg',
    });
    await setThumb(videoId, thumbId);
    console.log(`[thumb] ${videoId} → ${thumbId} (${size} bytes)`);
    return thumbId;
  } catch (err) {
    await fs.rm(dest, { force: true }).catch(() => {});
    console.error(`[thumb] ${videoId} failed:`, err.message.slice(0, 200));
    return null;
  }
}
