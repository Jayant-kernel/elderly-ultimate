import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CallBridge } from "../src/call-bridge.mjs";
import { TonePipeline } from "../src/pipeline/tone-pipeline.mjs";
import { assertPipeline } from "../src/pipeline/interface.mjs";
import { mulawToPcm16, pcm16ToMulaw } from "../src/audio/mulaw.mjs";
import { tone } from "../src/audio/pcm.mjs";

/** Minimal in-memory stand-in for a `ws` socket. */
class FakeSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; this.emit("close"); }
  // test helpers
  receive(obj) { this.emit("message", Buffer.from(JSON.stringify(obj))); }
  mediaFrames() { return this.sent.filter((m) => m.event === "media"); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("TonePipeline satisfies the VoicePipeline contract", () => {
  assertPipeline(new TonePipeline({ callId: "t" }));
});

test("full Twilio handshake: start -> greeting chime is paced out as 160-byte mu-law frames", async () => {
  const ws = new FakeSocket();
  const pipeline = new TonePipeline({ callId: "t1" });
  const ended = [];
  const bridge = new CallBridge({ ws, pipeline, callId: "t1", onEnd: (e) => ended.push(e) });

  ws.receive({ event: "connected", protocol: "Call" });
  ws.receive({ event: "start", streamSid: "MZ123", start: { streamSid: "MZ123", customParameters: { greeting: "hi" } } });

  await sleep(1500); // chime is ~1.07 s
  const frames = ws.mediaFrames();
  assert.ok(frames.length > 40, `expected many media frames, got ${frames.length}`);
  for (const f of frames) {
    assert.equal(f.streamSid, "MZ123");
    assert.equal(Buffer.from(f.media.payload, "base64").length, 160, "every outbound frame must be 20 ms of mu-law");
  }
  // audio must not be silence
  const pcm = mulawToPcm16(Buffer.from(frames[10].media.payload, "base64"));
  let energy = 0; for (const s of pcm) energy += Math.abs(s);
  assert.ok(energy / pcm.length > 200, "chime frames should carry audio energy");
  // response_done -> mark
  assert.ok(ws.sent.some((m) => m.event === "mark" && m.mark.name === "response_done"));

  ws.receive({ event: "stop" });
  assert.equal(ended.length, 1);
  assert.equal(ended[0].reason, "twilio_stop");
  assert.equal(bridge.ended, true);
});

test("inbound mu-law bytes cross the pipeline boundary untouched (zero resampling on the main path)", async () => {
  const ws = new FakeSocket();
  const pipeline = new TonePipeline({ callId: "t2" });
  const got = [];
  const origAppend = pipeline.appendAudio.bind(pipeline);
  pipeline.appendAudio = (b) => { got.push(Buffer.from(b)); origAppend(b); };
  new CallBridge({ ws, pipeline, callId: "t2" });
  ws.receive({ event: "start", streamSid: "MZ1", start: { streamSid: "MZ1" } });
  const frame8k = tone({ freqHz: 300, ms: 20, sampleRate: 8000, amplitude: 0.2 }); // 160 samples
  const mulaw = Buffer.from(pcm16ToMulaw(frame8k));
  ws.receive({ event: "media", media: { track: "inbound", payload: mulaw.toString("base64") } });
  ws.receive({ event: "media", media: { track: "inbound", payload: mulaw.toString("base64") } });
  assert.equal(got.length, 2);
  for (const g of got) assert.deepEqual(g, mulaw, "bridge must pass the exact mu-law bytes through");
  ws.receive({ event: "stop" });
});

test("barge-in: clear sent, queue emptied, and the cancelled generation's late flush is dropped", async () => {
  const ws = new FakeSocket();
  const pipeline = new TonePipeline({ callId: "t3" });
  const bridge = new CallBridge({ ws, pipeline, callId: "t3" });
  ws.receive({ event: "start", streamSid: "MZ9", start: { streamSid: "MZ9" } });
  await sleep(150); // chime (gen-1) playing, queue populated
  assert.ok(bridge.outQueue.length > 0, "queue should hold pending frames");
  pipeline.cancelResponse();
  pipeline.emit("speech_started");
  assert.equal(bridge.outQueue.length, 0);
  assert.ok(ws.sent.some((m) => m.event === "clear" && m.streamSid === "MZ9"));
  assert.equal(bridge.stats.bargeIns, 1);
  // late flush from the cancelled generation (the ElevenLabs close_context gotcha)
  pipeline.emit("audio", new Uint8Array(320), "gen-1");
  assert.equal(bridge.outQueue.length, 0, "cancelled-generation audio must never reach the caller");
  assert.ok(bridge.stats.droppedFrames > 0);
  // a fresh generation flows normally
  pipeline.emit("audio", new Uint8Array(320), "gen-2");
  assert.equal(bridge.outQueue.length, 2);
  ws.receive({ event: "stop" });
});

test("socket close ends the call exactly once and closes the pipeline", () => {
  const ws = new FakeSocket();
  const pipeline = new TonePipeline({ callId: "t4" });
  const ended = [];
  new CallBridge({ ws, pipeline, callId: "t4", onEnd: (e) => ended.push(e) });
  ws.close();
  ws.emit("close");
  assert.equal(ended.length, 1);
  assert.equal(ended[0].reason, "caller_hangup");
  assert.equal(pipeline.closed, true);
});
