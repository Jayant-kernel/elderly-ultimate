import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import WebSocket from "ws";
import { signToken, verifyToken } from "../src/token.mjs";
import { streamTwiml, apologyTwiml, escapeXml } from "../src/twiml.mjs";
import { validateTwilioSignature, verifyTwilioWebhook } from "../src/webhook-auth.mjs";
import { createServer } from "../src/server.mjs";

const SECRET = "test-signing-secret";
const AUTH_TOKEN = "twilio-auth-token-fake";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── tokens ────────────────────────────────────────────────────────────────────

test("tokens: round-trip in both domains", () => {
  for (const domain of ["attempt", "call"]) {
    const t = signToken(SECRET, domain, "abc-123");
    const payload = verifyToken(SECRET, domain, t);
    assert.equal(payload.sub, "abc-123");
  }
});

test("tokens: domains never swap — attempt token rejected as call token and vice versa", () => {
  const attempt = signToken(SECRET, "attempt", "abc-123");
  const call = signToken(SECRET, "call", "abc-123");
  assert.equal(verifyToken(SECRET, "call", attempt), null);
  assert.equal(verifyToken(SECRET, "attempt", call), null);
});

test("tokens: tampering, wrong secret, and expiry all fail closed", () => {
  const t = signToken(SECRET, "attempt", "abc-123");
  assert.equal(verifyToken(SECRET, "attempt", t.slice(0, -2) + "xx"), null, "tampered signature");
  assert.equal(verifyToken("other-secret", "attempt", t), null, "wrong secret");
  const past = Date.now() - 31 * 60 * 1000; // attempt TTL is 30 min
  const stale = signToken(SECRET, "attempt", "abc-123", past);
  assert.equal(verifyToken(SECRET, "attempt", stale), null, "expired");
  assert.ok(verifyToken(SECRET, "attempt", stale, past + 60_000), "same token valid inside its window");
});

// ── twiml ─────────────────────────────────────────────────────────────────────

test("twiml: stream uses Parameter nouns and refuses query strings on the Stream URL", () => {
  const xml = streamTwiml({ wsUrl: "wss://x.example/media", params: { attempt: "a1", token: "t&<>" } });
  assert.match(xml, /<Connect><Stream url="wss:\/\/x\.example\/media">/);
  assert.match(xml, /<Parameter name="attempt" value="a1"\/>/);
  assert.match(xml, /<Parameter name="token" value="t&amp;&lt;&gt;"\/>/, "parameter values must be XML-escaped");
  assert.throws(() => streamTwiml({ wsUrl: "wss://x.example/media?token=oops" }), /query string/);
});

test("twiml: apology escapes its message", () => {
  assert.match(apologyTwiml(`a "b" & <c>`), /a &quot;b&quot; &amp; &lt;c&gt;/);
  assert.equal(escapeXml("'"), "&apos;");
});

// ── webhook signature ─────────────────────────────────────────────────────────

function twilioSign(url, form, authToken) {
  let payload = url;
  for (const k of Object.keys(form).sort()) payload += k + form[k];
  return createHmac("sha1", authToken).update(Buffer.from(payload, "utf8")).digest("base64");
}

test("webhook-auth: valid signature accepted, bad one rejected", () => {
  const url = "https://bridge.example/twiml?attempt=a1";
  const form = { CallSid: "CA1", AnsweredBy: "human" };
  const signature = twilioSign(url, form, AUTH_TOKEN);
  assert.ok(validateTwilioSignature({ signature, url, form, authToken: AUTH_TOKEN }));
  assert.ok(!validateTwilioSignature({ signature: "bogus", url, form, authToken: AUTH_TOKEN }));
  assert.ok(!validateTwilioSignature({ signature, url, form, authToken: null }), "no auth token = refuse");
});

test("webhook-auth: multi-candidate tolerates proxy host/proto rewriting", () => {
  const form = { CallSid: "CA1" };
  // Twilio signed the public https URL, but the handler sees an internal host
  const signed = twilioSign("https://bridge.example/twiml?a=1", form, AUTH_TOKEN);
  const check = verifyTwilioWebhook({
    headers: { "x-twilio-signature": signed, host: "10.0.0.5:8080", "x-forwarded-host": "bridge.example", "x-forwarded-proto": "https" },
    pathWithQuery: "/twiml?a=1",
    form,
    authToken: AUTH_TOKEN,
    publicUrl: null,
  });
  assert.ok(check.ok, `no candidate matched: ${check.tried.join(" | ")}`);
  // and via PUBLIC_URL when forwarding headers are absent
  const check2 = verifyTwilioWebhook({
    headers: { "x-twilio-signature": signed, host: "10.0.0.5:8080" },
    pathWithQuery: "/twiml?a=1",
    form,
    authToken: AUTH_TOKEN,
    publicUrl: "https://bridge.example",
  });
  assert.ok(check2.ok);
});

// ── routes ────────────────────────────────────────────────────────────────────

const overrides = {
  tokenSigningSecret: SECRET,
  twilioAuthToken: AUTH_TOKEN,
  publicUrl: "https://bridge.example",
  isProduction: false,
};

async function postForm(port, path, form, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
  });
  return { status: res.status, text: await res.text() };
}

function signedHeaders(path, form) {
  return { "x-twilio-signature": twilioSign(`https://bridge.example${path}`, form, AUTH_TOKEN) };
}

test("routes: /twiml happy path issues Connect/Stream with a call-domain token bound to the attempt", async () => {
  const { server, shutdown } = createServer({ pipeline: "tone", configOverrides: overrides });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const attemptId = "att-1";
  const path = `/twiml?attempt=${attemptId}&token=${encodeURIComponent(signToken(SECRET, "attempt", attemptId))}`;
  const form = { CallSid: "CA1", AnsweredBy: "human" };
  const { status, text } = await postForm(port, path, form, signedHeaders(path, form));

  assert.equal(status, 200);
  assert.match(text, /<Connect><Stream url="wss:\/\/bridge\.example\/media">/);
  const tokenMatch = text.match(/<Parameter name="token" value="([^"]+)"\/>/);
  assert.ok(tokenMatch, "stream must carry a token Parameter noun");
  const payload = verifyToken(SECRET, "call", tokenMatch[1]);
  assert.ok(payload, "the stream token must be call-domain");
  assert.equal(payload.sub, attemptId, "call token must be bound to the attempt");
  await shutdown();
});

test("routes: /twiml always answers 200 — bad token gets a spoken apology, voicemail gets the retry line", async () => {
  const { server, shutdown } = createServer({ pipeline: "tone", configOverrides: overrides });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  // forged attempt token
  const badPath = `/twiml?attempt=att-2&token=forged`;
  const badForm = { CallSid: "CA2" };
  const bad = await postForm(port, badPath, badForm, signedHeaders(badPath, badForm));
  assert.equal(bad.status, 200, "non-2xx TwiML is discarded by Twilio — always 200");
  assert.match(bad.text, /<Say[^>]*>Sorry, this call could not be verified\.<\/Say>/);

  // machine answered
  const attemptId = "att-3";
  const vmPath = `/twiml?attempt=${attemptId}&token=${encodeURIComponent(signToken(SECRET, "attempt", attemptId))}`;
  const vmForm = { CallSid: "CA3", AnsweredBy: "machine_start" };
  const vm = await postForm(port, vmPath, vmForm, signedHeaders(vmPath, vmForm));
  assert.equal(vm.status, 200);
  assert.match(vm.text, /We will try again a little later/);
  assert.doesNotMatch(vm.text, /<Connect>/, "never hand a voicemail to the pipeline");

  // missing/invalid Twilio signature
  const sig = await postForm(port, vmPath, vmForm, { "x-twilio-signature": "bogus" });
  assert.equal(sig.status, 200);
  assert.match(sig.text, /could not be verified/);

  await shutdown();
});

test("routes: /status accepts the callback; /media start is gated on the call token", async () => {
  const { server, shutdown, calls } = createServer({ pipeline: "tone", configOverrides: overrides });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const st = await postForm(port, "/status", { CallSid: "CA9", CallStatus: "completed", CallDuration: "42" });
  assert.equal(st.status, 204);

  // start without a valid call token -> rejected
  const ws1 = new WebSocket(`ws://127.0.0.1:${port}/media`);
  await new Promise((r) => ws1.on("open", r));
  const closed = new Promise((r) => ws1.on("close", r));
  ws1.send(JSON.stringify({ event: "start", streamSid: "MZ1", start: { streamSid: "MZ1", customParameters: { attempt: "a", token: "junk" } } }));
  await closed;
  assert.equal(calls.size, 0, "bad token must not leave a live call");

  // start with the real call token -> chime flows
  const attemptId = "att-4";
  const callToken = signToken(SECRET, "call", attemptId);
  const ws2 = new WebSocket(`ws://127.0.0.1:${port}/media`);
  await new Promise((r) => ws2.on("open", r));
  const media = [];
  ws2.on("message", (m) => { const msg = JSON.parse(m.toString()); if (msg.event === "media") media.push(msg); });
  ws2.send(JSON.stringify({ event: "start", streamSid: "MZ2", start: { streamSid: "MZ2", customParameters: { attempt: attemptId, token: callToken } } }));
  await sleep(400);
  assert.ok(media.length > 5, `expected chime frames through the gated stream, got ${media.length}`);
  ws2.send(JSON.stringify({ event: "stop" }));
  await sleep(50);
  ws2.close();
  await shutdown();
});
