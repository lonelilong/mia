#!/usr/bin/env node
// Probe queued items to fill in type/size from Telegram metadata.
// This enables priority sorting (photos first, small videos next, large videos last).
//
// Dry run by default — prints what it would update.
// Pass --apply to write type/size to the database.
//
//   node scripts/probe-queue.js                 # report only
//   node scripts/probe-queue.js --apply         # update DB
//   node scripts/probe-queue.js --apply --limit 50
import { createClient } from '@libsql/client';
import { connect } from '../src/telegram.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) || 500 : 500;

const db = createClient({ url: process.env.LIBSQL_URL || 'file:media.db' });

const { rows: queued } = await db.execute({
  sql: "SELECT id, tg_channel, tg_message_id, type, size FROM media WHERE status = 'queued' AND type IS NULL ORDER BY created_at ASC LIMIT ?",
  args: [limit],
});

if (queued.length === 0) {
  console.log('No unprobed queued items.');
  process.exit(0);
}

console.log(`Found ${queued.length} unprobed queued items. ${apply ? 'Updating DB...' : 'Dry run (pass --apply to update).'}`);

const tg = await connect();
let probed = 0, skipped = 0, errors = 0;

for (const job of queued) {
  try {
    const entity = await tg.getEntity(job.tg_channel);
    const [msg] = await tg.getMessages(entity, { ids: [job.tg_message_id] });
    if (!msg || !msg.media) {
      console.log(`  ${job.id} (${job.tg_channel}/${job.tg_message_id}): no media found`);
      skipped++;
      continue;
    }

    const isVideo = msg.media.className === 'MessageMediaDocument' &&
      msg.media.document?.mimeType?.startsWith('video/');
    const isPhoto = msg.media.className === 'MessageMediaPhoto';
    const isDoc = msg.media.className === 'MessageMediaDocument' && !isVideo;

    let type, mime, size;
    if (isVideo) {
      type = 'video';
      mime = msg.media.document.mimeType;
      size = Number(msg.media.document.size ?? 0);
    } else if (isPhoto) {
      type = 'photo';
      mime = 'image/jpeg';
      const sizes = msg.media.photo.sizes || [];
      size = sizes[sizes.length - 1]?.size || 0;
    } else if (isDoc) {
      type = 'photo';
      mime = msg.media.document.mimeType || 'application/octet-stream';
      size = Number(msg.media.document.size ?? 0);
    } else {
      skipped++;
      continue;
    }

    const sizeMb = (size / 1048576).toFixed(1);
    console.log(`  ${job.id} (${job.tg_channel}/${job.tg_message_id}): ${type} ${sizeMb}MB ${mime}`);

    if (apply) {
      await db.execute({
        sql: "UPDATE media SET type = ?, size = ?, mime_type = ? WHERE id = ?",
        args: [type, size, mime, job.id],
      });
    }
    probed++;
  } catch (err) {
    console.error(`  ${job.id} (${job.tg_channel}/${job.tg_message_id}): ERROR ${err.message}`);
    errors++;
  }
}

console.log(`\nDone: ${probed} probed, ${skipped} skipped, ${errors} errors.`);
process.exit(0);
