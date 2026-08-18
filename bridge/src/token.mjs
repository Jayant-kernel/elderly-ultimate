import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Domain-separated HMAC tokens (ported pattern from Final-Eldery's
 * session-token.ts).
 *
 * Two domains that must NEVER swap:
 *   attempt — 30 min; travels through Twilio's public TwiML URL. Long enough
 *             to place a call and connect media, not long enough to replay
 *             from a log the next day.
 *   call    — 90 min; minted by /twiml after verifying the attempt, carried
 *             into the media stream as a <Parameter> noun. Slightly longer
 *             than a very long call, so a real conversation never expires.
 *
 * The domain is baked into the signed payload (`${domain}:${payloadPart}`),
 * so a valid attempt token presented where a call token is expected fails
 * the HMAC — not just a prefix check.
 */
const TTL_SECONDS = { attempt: 30 * 60, call: 90 * 60 };

function b64u(s) { return Buffer.from(s, "utf8").toString("base64url"); }
function unb64u(s) { return Buffer.from(s, "base64url").toString("utf8"); }

function sign(secret, domain, payloadPart) {
  return createHmac("sha256", secret).update(`${domain}:${payloadPart}`).digest("base64url");
}

export function signToken(secret, domain, subject, now = Date.now()) {
  const ttl = TTL_SECONDS[domain];
  if (!ttl) throw new Error(`Unknown token domain '${domain}'`);
  if (!secret) throw new Error("signToken needs a secret");
  const payloadPart = b64u(JSON.stringify({ sub: subject, exp: Math.floor(now / 1000) + ttl }));
  return `${payloadPart}.${sign(secret, domain, payloadPart)}`;
}

/** Returns {sub, exp}, or null if malformed, forged, wrong-domain, or expired. */
export function verifyToken(secret, domain, token, now = Date.now()) {
  if (!secret || !token || !TTL_SECONDS[domain]) return null;
  const sep = token.lastIndexOf(".");
  if (sep <= 0) return null;
  const payloadPart = token.slice(0, sep);
  // Constant-time compare; length check first — timingSafeEqual throws on
  // differing lengths, which would itself leak information.
  const provided = Buffer.from(token.slice(sep + 1));
  const expected = Buffer.from(sign(secret, domain, payloadPart));
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;
  let payload;
  try { payload = JSON.parse(unb64u(payloadPart)); } catch { return null; }
  if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp < Math.floor(now / 1000)) return null;
  return payload;
}
