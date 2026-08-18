/**
 * Force-dial — place one outbound call through the deployed bridge.
 * The silent-death diagnosis tool: if the phone doesn't ring, the error is
 * printed here; if it rings but stays silent, check /health and the logs.
 *
 * Usage:
 *   node tools/dial.mjs --to +91XXXXXXXXXX [--greeting "hello there"]
 *
 * Needs env: PUBLIC_URL, TOKEN_SIGNING_SECRET,
 *            TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *
 * Shared-trial rules: outbound only, SMS-verified numbers only, and this
 * script never touches any Twilio number's inbound webhook.
 */
import { randomUUID } from "node:crypto";
import { signToken } from "../src/token.mjs";

const read = (name) => {
  const v = process.env[name] === undefined ? "" : String(process.env[name]).trim();
  if (!v) { console.error(`[dial] missing env ${name}`); process.exit(1); }
  return v;
};

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const to = flag("--to");
if (!to || !to.startsWith("+")) { console.error("[dial] usage: node tools/dial.mjs --to +91XXXXXXXXXX"); process.exit(1); }

const publicUrl = read("PUBLIC_URL").replace(/\/+$/, "");
const secret = read("TOKEN_SIGNING_SECRET");
const accountSid = read("TWILIO_ACCOUNT_SID");
const authToken = read("TWILIO_AUTH_TOKEN");
const from = read("TWILIO_FROM_NUMBER");

const attemptId = randomUUID().slice(0, 12);
const token = signToken(secret, "attempt", attemptId);
const twimlUrl = new URL(`${publicUrl}/twiml`);
twimlUrl.searchParams.set("attempt", attemptId);
twimlUrl.searchParams.set("token", token);
const greeting = flag("--greeting");
if (greeting) twimlUrl.searchParams.set("greeting", greeting);

console.log(`[dial] attempt=${attemptId} calling ${to} via ${publicUrl}`);

const body = new URLSearchParams({
  To: to,
  From: from,
  Url: twimlUrl.toString(),
  Method: "POST",
  MachineDetection: "Enable",
  StatusCallback: `${publicUrl}/status`,
  StatusCallbackMethod: "POST",
});
// multiple values = the parameter appended multiple times, per Twilio's API
for (const ev of ["initiated", "ringing", "answered", "completed"]) body.append("StatusCallbackEvent", ev);

const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
  method: "POST",
  headers: {
    Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: body.toString(),
  signal: AbortSignal.timeout(10000),
});

const payload = await res.json();
if (!res.ok) {
  console.error(`[dial] Twilio ${res.status}: ${payload.message || JSON.stringify(payload)}`);
  process.exit(1);
}
console.log(`[dial] call placed: sid=${payload.sid} status=${payload.status}`);
console.log(`[dial] watch: ${publicUrl}/health  (and Railway logs for [${attemptId}])`);
