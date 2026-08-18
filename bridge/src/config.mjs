/**
 * Central env reader. Every value is trimmed — dashboard secrets pasted with a
 * trailing newline have broken fetches before, so we never trust raw env.
 */
function read(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return fallback;
  const v = String(raw).trim();
  return v === "" ? fallback : v;
}

export const config = {
  port: Number(read("PORT", "8080")),
  pipeline: read("PIPELINE", "tone"),
  sharedSecret: read("BRIDGE_SHARED_SECRET", null),
  logLevel: read("LOG_LEVEL", "info"),
  isProduction: read("NODE_ENV", "development") === "production",
  // telephony (Phase 2) — all optional locally; validated where used
  publicUrl: read("PUBLIC_URL", null),
  tokenSigningSecret: read("TOKEN_SIGNING_SECRET", null),
  adminSecret: read("ADMIN_SECRET", null),
  twilioAccountSid: read("TWILIO_ACCOUNT_SID", null),
  twilioAuthToken: read("TWILIO_AUTH_TOKEN", null),
  twilioFromNumber: read("TWILIO_FROM_NUMBER", null),
};

export function requireEnv(name) {
  const v = read(name, null);
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}
