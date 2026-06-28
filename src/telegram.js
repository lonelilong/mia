import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Logger } from 'telegram/extensions/Logger.js';

class QuietLogger extends Logger {
  error(msg) {
    const s = typeof msg === 'function' ? msg() : String(msg ?? '');
    if (s.includes('TIMEOUT')) return;
    super.error(msg);
  }
}

let client = null;

export async function connect() {
  if (client?.connected) return client;
  if (client) {
    try { await client.disconnect(); } catch {}
  }
  client = new TelegramClient(
    new StringSession(process.env.SESSION_STRING || ''),
    parseInt(process.env.API_ID),
    process.env.API_HASH,
    { connectionRetries: 5, baseLogger: new QuietLogger() },
  );
  await client.connect();
  console.log('[telegram] Connected');
  return client;
}

const MIME_TO_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov',
};

const EXT_TO_MIME = Object.fromEntries(Object.entries(MIME_TO_EXT).map(([k, v]) => [v, k]));

const DOWNLOAD_TIMEOUT = 300_000; // 5 minutes

export async function fetchMedia(channel, messageId) {
  const tg = await connect();

  const timeout = (ms) => new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Telegram download timed out')), ms));

  const doFetch = async () => {
    const entity = await tg.getEntity(channel);
    const [msg] = await tg.getMessages(entity, { ids: [messageId] });
    if (!msg || !msg.media) return null;

  const isVideo = msg.media.className === 'MessageMediaDocument' &&
    msg.media.document?.mimeType?.startsWith('video/');
  const isPhoto = msg.media.className === 'MessageMediaPhoto';
  const isDoc = msg.media.className === 'MessageMediaDocument' && !isVideo;

  let type, ext, mime, size;

  if (isVideo) {
    type = 'video';
    mime = msg.media.document.mimeType;
    ext = MIME_TO_EXT[mime] || 'mp4';
    size = Number(msg.media.document.size ?? 0);
  } else if (isPhoto) {
    type = 'photo';
    mime = 'image/jpeg';
    ext = 'jpg';
    const sizes = msg.media.photo.sizes || [];
    const biggest = sizes[sizes.length - 1];
    size = biggest?.size || 0;
  } else if (isDoc) {
    type = 'photo';
    mime = msg.media.document.mimeType || 'application/octet-stream';
    ext = MIME_TO_EXT[mime] || 'bin';
    size = Number(msg.media.document.size ?? 0);
  } else {
    return null;
  }

    const buffer = await tg.downloadMedia(msg);
    if (!buffer) return null;

    return { buffer: Buffer.from(buffer), type, ext, mime, size: buffer.length };
  };

  return Promise.race([doFetch(), timeout(DOWNLOAD_TIMEOUT)]);
}

export { EXT_TO_MIME };
