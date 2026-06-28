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

async function transcode(job) {
  const src = getPath('video', job.id, job.ext);
  const outDir = hlsDir(job.id);
  await fs.mkdir(outDir, { recursive: true });

  const playlist = path.join(outDir, 'index.m3u8');

  console.log(`[hls] Transcoding ${job.id} (${(job.size / 1048576).toFixed(1)} MB)`);

  try {
    await execFileAsync('ffmpeg', [
      '-i', src,
      '-codec', 'copy',
      '-start_number', '0',
      '-hls_time', '6',
      '-hls_list_size', '0',
      '-hls_segment_filename', path.join(outDir, 'seg%03d.ts'),
      '-f', 'hls',
      '-y',
      playlist,
    ], { timeout: 300_000 }); // 5 min timeout

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
