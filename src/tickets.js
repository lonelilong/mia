import crypto from 'crypto';

/**
 * Short-lived, single-upload credentials for browsers.
 *
 * Uploads now come straight from the browser, which cannot be given AUTH_TOKEN — that grants
 * unlimited upload rights to anyone who reads the page source. chigua holds the same secret
 * (its MEDIA_SERVER_TOKEN is this server's AUTH_TOKEN), so it can mint a ticket that is
 * bound to one upload id and one size ceiling, and this server verifies it with no extra
 * secret to distribute.
 */

const SECRET = () => process.env.AUTH_TOKEN || '';

function sign(payload) {
  return crypto.createHmac('sha256', SECRET()).update(payload).digest('base64url');
}

export function mintTicket({ uploadId, maxSize, ttlMs = 6 * 60 * 60 * 1000 }) {
  const body = Buffer.from(
    JSON.stringify({ uploadId, maxSize, exp: Date.now() + ttlMs })
  ).toString('base64url');
  return `${body}.${sign(body)}`;
}

/**
 * Returns the ticket payload, or null if it is malformed, tampered with, expired, or issued
 * for a different upload than the one being attempted.
 */
export function verifyTicket(ticket, uploadId) {
  if (!SECRET() || typeof ticket !== 'string') return null;
  const [body, mac] = ticket.split('.');
  if (!body || !mac) return null;

  const expected = sign(body);
  // Both are base64url of a fixed-length digest, so lengths match unless the ticket is
  // malformed — timingSafeEqual throws on a length mismatch, hence the guard.
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }

  if (!payload?.exp || Date.now() > payload.exp) return null;
  // Without this a ticket would be a general upload permit rather than one slot.
  if (payload.uploadId !== uploadId) return null;
  return payload;
}
