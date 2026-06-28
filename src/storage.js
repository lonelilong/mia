import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

function getDataDir() {
  return process.env.DATA_DIR || '/data';
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
