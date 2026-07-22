#!/usr/bin/env node
// Backfill: move the `moov` atom to the front of already-stored MP4s.
//
// Files downloaded before the ingest-time remux landed still have `moov` at the
// end, which costs players an extra round trip before playback can start.
//
// Dry run by default — prints what it would rewrite and changes nothing.
// Pass --apply to actually rewrite files (in place, via a temp file + rename).
//
//   node scripts/faststart-backfill.js                 # report only
//   node scripts/faststart-backfill.js --apply         # rewrite
//   node scripts/faststart-backfill.js --apply --limit 50
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { faststart } from '../src/faststart.js';

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg !== -1 ? Number(process.argv[limitArg + 1]) : Infinity;

const DATA_DIR = process.env.DATA_DIR || '/data';
const LEGACY_MEDIA_DIR = process.env.LEGACY_MEDIA_DIR || '';

const roots = [path.join(DATA_DIR, 'videos'), LEGACY_MEDIA_DIR].filter(Boolean);

// Walk the MP4 box structure from the start of the file. Whichever of `moov`
// or `mdat` appears first tells us if the file is already faststart. Only box
// headers are read, so this stays cheap regardless of file size.
async function isFaststart(fp) {
  const fh = await fs.open(fp, 'r');
  try {
    const header = Buffer.alloc(16);
    let offset = 0;
    for (let box = 0; box < 32; box++) {
      const { bytesRead } = await fh.read(header, 0, 16, offset);
      if (bytesRead < 8) return null; // not a parseable mp4
      let size = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      if (size === 1) {
        if (bytesRead < 16) return null;
        size = Number(header.readBigUInt64BE(8)); // 64-bit extended size
      } else if (size === 0) {
        return null; // box runs to EOF
      }
      if (size < 8) return null;
      offset += size;
    }
    return null;
  } finally {
    await fh.close();
  }
}

async function* walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(fp);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.mp4')) yield fp;
  }
}

const stats = { scanned: 0, ok: 0, needsFix: 0, fixed: 0, failed: 0, unparsable: 0 };

for (const root of roots) {
  for await (const fp of walk(root)) {
    if (stats.needsFix >= LIMIT && !APPLY) break;
    if (stats.fixed >= LIMIT) break;
    stats.scanned++;
    const fast = await isFaststart(fp);
    if (fast === null) { stats.unparsable++; continue; }
    if (fast) { stats.ok++; continue; }

    stats.needsFix++;
    if (!APPLY) {
      console.log(`would fix: ${fp}`);
      continue;
    }
    try {
      const before = (await fs.stat(fp)).size;
      await faststart(fp);
      const after = (await fs.stat(fp)).size;
      stats.fixed++;
      console.log(`fixed: ${fp} (${before} -> ${after} bytes)`);
    } catch (err) {
      stats.failed++;
      console.error(`FAILED: ${fp}: ${err.message}`);
    }
  }
}

console.log(
  `\n${APPLY ? 'Applied' : 'Dry run'} — scanned ${stats.scanned}, ` +
  `already faststart ${stats.ok}, needed fix ${stats.needsFix}, ` +
  `fixed ${stats.fixed}, failed ${stats.failed}, unparsable ${stats.unparsable}`
);
if (!APPLY && stats.needsFix) console.log('Re-run with --apply to rewrite these files.');
