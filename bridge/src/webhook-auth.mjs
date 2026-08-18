import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Twilio webhook signature validation (ported from Final-Eldery's
 * webhook-auth.ts).
 *
 * Algorithm (Twilio's spec): HMAC-SHA1 over the full request URL with every
 * POST parameter appended in lexical order as key+value, keyed by the account
 * auth token, base64 encoded.
 */
export function validateTwilioSignature({ signature, url, form, authToken }) {
  if (!authToken || !signature) return false;
  let payload = url;
  for (const key of Object.keys(form).sort()) payload += key + form[key];
  const expected = createHmac("sha1", authToken).update(Buffer.from(payload, "utf8")).digest("base64");
  const provided = Buffer.from(signature);
  const computed = Buffer.from(expected);
  if (provided.length !== computed.length) return false;
  return timingSafeEqual(provided, computed);
}

/**
 * Tolerant multi-candidate check. Twilio signs the exact URL it was told to
 * fetch, but behind a proxy the URL the handler sees can differ in host or
 * protocol — a single guess gets it wrong often enough to be useless. Build
 * every plausible form and accept if ANY verifies: the signature itself still
 * does the work; we only compensate for proxy rewriting.
 */
export function verifyTwilioWebhook({ headers, pathWithQuery, form, authToken, publicUrl }) {
  const signature = headers["x-twilio-signature"] || null;
  const candidates = new Set();
  const add = (origin) => {
    if (origin) candidates.add(String(origin).replace(/\/+$/, "") + pathWithQuery);
  };
  add(publicUrl);
  const fwdHost = headers["x-forwarded-host"];
  const fwdProto = headers["x-forwarded-proto"];
  if (fwdHost) {
    add(`${fwdProto || "https"}://${fwdHost}`);
    add(`https://${fwdHost}`);
  }
  if (headers.host) {
    add(`https://${headers.host}`);
    add(`http://${headers.host}`);
  }
  const matched = [...candidates].find((url) => validateTwilioSignature({ signature, url, form, authToken }));
  return { ok: Boolean(matched), tried: [...candidates], hadSignature: Boolean(signature) };
}
