import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

function getDataDir() {
  // Absolute: res.sendFile rejects relative paths, and DATA_DIR is commonly
  // set to something like ./data outside of Docker.
  return path.resolve(process.env.DATA_DIR || '/data');
}

function filePath(type, id, ext) {
  const dir = type === 'video' ? 'videos' : 'images';
  const a = id.slice(0, 2);
  const b = id.slice(2, 4);
  return path.join(getDataDir(), dir, a, b, `${id}.${ext}`);
}

export async function save(type, id, ext, buffer) {
  const fp = filePath(type, id, ext);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, buffer);
  return fp;
}

// Unlike videos/images, this is NOT NFS-mounted — plain local disk under DATA_DIR. A
// downloaded video lands here first so faststart's remux and the thumbnail's frame grab
// both run against local disk instead of round-tripping the whole file over NFS twice.
function localStagingPath(id, ext) {
  return path.join(getDataDir(), 'tmp-ingest', `${id}.${ext}`);
}

export async function saveLocal(id, ext, buffer) {
  const fp = localStagingPath(id, ext);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, buffer);
  return fp;
}

// Only now does the file cross the network — one bulk copy of the finished result,
// instead of the write+read+write it would take to process it in place on NFS.
export async function publishLocal(type, id, ext) {
  const src = localStagingPath(id, ext);
  const dest = filePath(type, id, ext);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
  return dest;
}

export async function cleanupLocal(id, ext) {
  await fs.rm(localStagingPath(id, ext), { force: true }).catch(() => {});
}

// Wipes leftovers from a prior crash/restart mid-job — nothing here is authoritative, the
// original download can simply be retried.
export async function resetLocalStaging() {
  const dir = path.join(getDataDir(), 'tmp-ingest');
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(dir, { recursive: true });
}

export async function read(type, id, ext) {
  const fp = filePath(type, id, ext);
  try {
    return await fs.readFile(fp);
  } catch {
    return null;
  }
}

export function getPath(type, id, ext) {
  return filePath(type, id, ext);
}

export function contentHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
