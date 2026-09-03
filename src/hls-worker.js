import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { getTranscoding, updateHlsReady, updateHlsFailed } from './db.js';
import { getPath } from './storage.js';

const execFileAsync = promisify(execFile);
// Absolute: hlsDir() feeds res.sendFile, which rejects relative paths.
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');
// Unlike images/videos/hls, this is NOT NFS-mounted — it's plain local disk. Every read
// and write ffmpeg does during the transcode itself lands here instead of over the network,
// where per-operation latency (not bandwidth) was the actual bottleneck. Only the source
// copy in and the finished output copy out cross the network, as two bulk transfers.
const LOCAL_STAGING_DIR = path.join(DATA_DIR, 'tmp-transcode');
const POLL_INTERVAL = 5000;
const SEGMENT_SECONDS = 3;
// Probing over NFS occasionally takes longer than 10s for large files, especially under
// concurrent load — a probe that times out is not the same as an unrecognized codec, but
// used to be treated identically, silently forcing a needless re-encode.
const PROBE_TIMEOUT_MS = 30_000;
// A flat timeout killed anything longer than `budget * encode_speed` of content — in
// practice every video over ~16 min, and over ~1.5 min for slow HEVC sources. Budget by
// source duration instead, at a pessimistic 0.15x, with a floor and a ceiling.
const MIN_TRANSCODE_MS = 10 * 60_000;
const MAX_TRANSCODE_MS = 6 * 60 * 60_000;
const SLOWEST_EXPECTED_SPEED = 0.15;

let running = false;

function hlsDir(id) {
  return path.join(DATA_DIR, 'hls', id.slice(0, 2), id.slice(2, 4), id);
}

async function probeCodec(src) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', src,
    ], { timeout: PROBE_TIMEOUT_MS });
    return stdout.trim();
  } catch (err) {
    // 'unknown' forces a re-encode further down, so a probe that merely timed out on a
    // perfectly normal file must not look the same as one that genuinely can't be read.
    console.error(`[hls] probeCodec failed for ${src}:`, err.message.slice(0, 200));
    return 'unknown';
  }
}

async function probeDuration(src) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'csv=p=0', src,
    ], { timeout: PROBE_TIMEOUT_MS });
    const seconds = parseFloat(stdout.trim());
    return Number.isFinite(seconds) ? seconds : 0;
  } catch (err) {
    console.error(`[hls] probeDuration failed for ${src}:`, err.message.slice(0, 200));
    return 0;
  }
}

// A stream copy is near-instant regardless of length; only re-encoding needs a real budget.
function transcodeBudgetMs(durationSeconds, needsReencode) {
  if (!needsReencode || !durationSeconds) return MIN_TRANSCODE_MS;
  const needed = Math.round((durationSeconds / SLOWEST_EXPECTED_SPEED) * 1000);
  return Math.min(MAX_TRANSCODE_MS, Math.max(MIN_TRANSCODE_MS, needed));
}

async function transcode(job) {
  const remoteSrc = getPath('video', job.id, job.ext);
  const outDir = hlsDir(job.id);

  const localSrc = path.join(LOCAL_STAGING_DIR, `${job.id}.${job.ext}`);
  const localOutDir = path.join(LOCAL_STAGING_DIR, job.id);

  try {
    await fs.mkdir(localOutDir, { recursive: true });

    // A file already sitting here — same size as the DB record — was prefetched ahead of
    // time (e.g. by an operator rsyncing the backlog in). Matching size is a cheap enough
    // integrity check to trust it and skip a redundant copy over NFS.
    const stagedSize = await fs.stat(localSrc).then(s => s.size).catch(() => null);
    if (stagedSize !== job.size) {
      await fs.copyFile(remoteSrc, localSrc);
    }

    const playlist = path.join(localOutDir, 'index.m3u8');

    const codec = await probeCodec(localSrc);
    const needsReencode = codec !== 'h264';
    const duration = await probeDuration(localSrc);
    const budgetMs = transcodeBudgetMs(duration, needsReencode);

    console.log(`[hls] Transcoding ${job.id} (${(job.size / 1048576).toFixed(1)} MB) codec=${codec} reencode=${needsReencode} duration=${duration.toFixed(0)}s budget=${(budgetMs / 60000).toFixed(0)}min`);

    // Short segments start faster: the player only has to pull one segment
    // before it can begin playing, which dominates startup latency for
    // short-form video. When re-encoding we can force keyframes to match;
    // with -c:v copy segments still land on the source's existing keyframes.
    const videoArgs = needsReencode
      ? ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
         '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`]
      : ['-c:v', 'copy'];

    await execFileAsync('ffmpeg', [
      '-i', localSrc,
      ...videoArgs,
      '-c:a', 'aac',
      '-start_number', '0',
      '-hls_time', String(SEGMENT_SECONDS),
      '-hls_list_size', '0',
      '-hls_segment_filename', path.join(localOutDir, 'seg%03d.ts'),
      '-f', 'hls',
      '-y',
      playlist,
    ], { timeout: budgetMs, maxBuffer: 1024 * 1024 });

    // Only now does anything cross the network again — one bulk copy of the finished
    // output, instead of one NFS round-trip per segment during the encode itself.
    await fs.mkdir(outDir, { recursive: true });
    await fs.cp(localOutDir, outDir, { recursive: true });

    await updateHlsReady(job.id);
    console.log(`[hls] ${job.id} ready (with HLS)`);
  } catch (err) {
    // Not promoted to 'ready': videos this large are HLS-only, so without a playlist
    // there is nothing servable. The mp4 stays on disk for a retry.
    console.error(`[hls] ${job.id} HLS failed, held unserved:`, err.message.slice(0, 200));
    await updateHlsFailed(job.id, `HLS: ${err.message}`.slice(0, 2000)).catch(() => {});
  } finally {
    await fs.rm(localSrc, { force: true }).catch(() => {});
    await fs.rm(localOutDir, { recursive: true, force: true }).catch(() => {});
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

  // Awaited before the loop starts: a job could otherwise write into the staging dir
  // before this finishes clearing it, and lose that write. Nothing here is authoritative —
  // the source of truth is always the remote copy or the 'transcoding' row for retry.
  fs.rm(LOCAL_STAGING_DIR, { recursive: true, force: true })
    .then(() => fs.mkdir(LOCAL_STAGING_DIR, { recursive: true }))
    .catch(err => console.error('[hls] Failed to prep local staging dir:', err.message))
    .then(() => poll())
    .catch(err => {
      console.error('[hls] Fatal:', err);
      running = false;
    });
}

export function stopHlsWorker() {
  running = false;
}

export { hlsDir };
