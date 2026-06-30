import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { getTranscoding, updateStatus, updateFailed } from './db.js';
import { getPath } from './storage.js';

const execFileAsync = promisify(execFile);
const DATA_DIR = process.env.DATA_DIR || '/data';
const POLL_INTERVAL = 5000;

let running = false;

function hlsDir(id) {
  return path.join(DATA_DIR, 'hls', id.slice(0, 2), id.slice(2, 4), id);
}

async function probeCodec(src) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', src,
    ], { timeout: 10_000 });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

async function transcode(job) {
  const src = getPath('video', job.id, job.ext);
  const outDir = hlsDir(job.id);
  await fs.mkdir(outDir, { recursive: true });

  const playlist = path.join(outDir, 'index.m3u8');

  const codec = await probeCodec(src);
  const needsReencode = codec !== 'h264';

  console.log(`[hls] Transcoding ${job.id} (${(job.size / 1048576).toFixed(1)} MB) codec=${codec} reencode=${needsReencode}`);

  const videoArgs = needsReencode
    ? ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23']
    : ['-c:v', 'copy'];

  try {
    await execFileAsync('ffmpeg', [
      '-i', src,
      ...videoArgs,
      '-c:a', 'aac',
      '-start_number', '0',
      '-hls_time', '6',
      '-hls_list_size', '0',
      '-hls_segment_filename', path.join(outDir, 'seg%03d.ts'),
      '-f', 'hls',
      '-y',
      playlist,
    ], { timeout: 600_000 }); // 10 min timeout for re-encoding

    await updateStatus(job.id, 'ready');
    console.log(`[hls] ${job.id} ready`);
  } catch (err) {
    console.error(`[hls] ${job.id} failed:`, err.message);
    await updateFailed(job.id, `HLS: ${err.message}`);
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function startHlsWorker() {
  if (running) return;
  running = true;
  console.log('[hls] Worker started');

  async function poll() {
    while (running) {
      const jobs = await getTranscoding(1);
      if (jobs.length) {
        await transcode(jobs[0]);
      } else {
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
      }
    }
  }

  poll().catch(err => {
    console.error('[hls] Fatal:', err);
    running = false;
  });
}

export function stopHlsWorker() {
  running = false;
}

export { hlsDir };
