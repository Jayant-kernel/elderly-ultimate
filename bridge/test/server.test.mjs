import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { createServer } from "../src/server.mjs";
import { pcm16ToMulaw } from "../src/audio/mulaw.mjs";
import { tone } from "../src/audio/pcm.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("server: /health responds and a real WebSocket call receives the chime", async () => {
  const { server, shutdown, calls } = createServer({ pipeline: "tone" });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  assert.equal(health.ok, true);
  assert.equal(health.pipeline, "tone");
  assert.deepEqual(health.vendors, {}, "/health must expose the per-vendor lastError registry");

  const ws = new WebSocket(`ws://127.0.0.1:${port}/media`);
  await new Promise((r) => ws.on("open", r));
  const received = [];
  ws.on("message", (m) => received.push(JSON.parse(m.toString())));

  ws.send(JSON.stringify({ event: "connected", protocol: "Call" }));
  ws.send(JSON.stringify({ event: "start", streamSid: "MZtest", start: { streamSid: "MZtest", customParameters: {} } }));
  await sleep(50);
  assert.equal(calls.size, 1);

  // stream 500 ms of caller audio
  const payload = Buffer.from(pcm16ToMulaw(tone({ freqHz: 250, ms: 20, sampleRate: 8000, amplitude: 0.2 }))).toString("base64");
  for (let i = 0; i < 25; i++) {
    ws.send(JSON.stringify({ event: "media", media: { track: "inbound", payload } }));
    await sleep(20);
  }
  await sleep(1200);

  const media = received.filter((m) => m.event === "media");
  assert.ok(media.length > 40, `expected chime frames, got ${media.length}`);
  assert.ok(received.some((m) => m.event === "mark"), "expected response_done mark");

  ws.send(JSON.stringify({ event: "stop" }));
  await sleep(50);
  assert.equal(calls.size, 0);
  ws.close();
  await shutdown();
});

test("server: non-/media upgrade paths are rejected", async () => {
  const { server, shutdown } = createServer({ pipeline: "tone" });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/nope`);
  const outcome = await new Promise((resolve) => {
    ws.on("open", () => resolve("open"));
    ws.on("error", () => resolve("error"));
    ws.on("close", () => resolve("close"));
  });
  assert.notEqual(outcome, "open");
  await shutdown();
});
