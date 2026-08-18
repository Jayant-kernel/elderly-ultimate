/**
 * Fake Twilio — pretends to be a phone call so we can test the bridge without
 * spending a Twilio minute. Speaks the real Media Streams protocol:
 *   connects to ws://host/media, sends connected + start, streams a caller
 *   audio track (silence, or a WAV file), records what the bridge sends back
 *   and writes it to tools/out/heard.wav (8 kHz PCM) — open it and listen.
 *
 * Usage:
 *   node tools/fake-twilio.mjs [ws://localhost:8080/media] [--speak path.wav] [--seconds 6]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { mulawToPcm16, pcm16ToMulaw } from "../src/audio/mulaw.mjs";
import { Downsampler } from "../src/audio/resample.mjs";
import { tone } from "../src/audio/pcm.mjs";

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith("ws")) || "ws://localhost:8080/media";
const speakIdx = args.indexOf("--speak");
const speakFile = speakIdx >= 0 ? args[speakIdx + 1] : null;
const secIdx = args.indexOf("--seconds");
const seconds = secIdx >= 0 ? Number(args[secIdx + 1]) : 6;
const bargeIdx = args.indexOf("--barge-at");
const bargeAtMs = bargeIdx >= 0 ? Number(args[bargeIdx + 1]) : null;

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "out");
fs.mkdirSync(outDir, { recursive: true });

/** Load a PCM16 WAV (mono, any of 8k/16k/24k/48k) and return 8 kHz mu-law frames of 160 bytes. */
function loadCallerFrames(file) {
  const buf = fs.readFileSync(file);
  const rate = buf.readUInt32LE(24);
  const channels = buf.readUInt16LE(22);
  const bits = buf.readUInt16LE(34);
  if (bits !== 16) throw new Error("WAV must be PCM16");
  let dataOff = 12;
  while (dataOff < buf.length) {
    const id = buf.toString("ascii", dataOff, dataOff + 4);
    const size = buf.readUInt32LE(dataOff + 4);
    if (id === "data") { dataOff += 8; break; }
    dataOff += 8 + size;
  }
  let pcm = new Int16Array(buf.buffer, buf.byteOffset + dataOff, Math.floor((buf.length - dataOff) / 2));
  if (channels > 1) {
    const mono = new Int16Array(Math.floor(pcm.length / channels));
    for (let i = 0; i < mono.length; i++) mono[i] = pcm[i * channels];
    pcm = mono;
  }
  if (rate !== 8000) {
    if (rate % 8000 !== 0) throw new Error(`WAV rate ${rate} not a multiple of 8000`);
    pcm = new Downsampler(rate, 8000).process(pcm);
  }
  const mulaw = pcm16ToMulaw(pcm);
  const frames = [];
  for (let o = 0; o + 160 <= mulaw.length; o += 160) frames.push(Buffer.from(mulaw.subarray(o, o + 160)));
  return frames;
}

function writeWav8k(file, samples) {
  const header = Buffer.alloc(44);
  const dataLen = samples.length * 2;
  header.write("RIFF", 0); header.writeUInt32LE(36 + dataLen, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(dataLen, 40);
  fs.writeFileSync(file, Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, dataLen)]));
}

const silenceFrame = Buffer.from(pcm16ToMulaw(new Int16Array(160)));
const callerFrames = speakFile ? loadCallerFrames(speakFile) : [];
const bargeFrames = bargeAtMs != null
  ? Array.from({ length: 50 }, () => Buffer.from(pcm16ToMulaw(tone({ freqHz: 220, ms: 20, sampleRate: 8000, amplitude: 0.6 }))))
  : [];

console.log(`[fake-twilio] dialing ${url} for ${seconds}s` + (speakFile ? ` speaking ${speakFile}` : "") + (bargeAtMs != null ? ` barge-in at ${bargeAtMs}ms` : ""));
const ws = new WebSocket(url);
const heard = [];
let mediaIn = 0, clears = 0, marks = 0;
const t0 = Date.now();
let firstAudioAt = null;

ws.on("open", () => {
  ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
  ws.send(JSON.stringify({
    event: "start", sequenceNumber: "1", streamSid: "MZfake",
    start: { streamSid: "MZfake", accountSid: "ACfake", callSid: "CAfake", tracks: ["inbound"],
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
      customParameters: { greeting: "harness" } },
  }));
  let i = 0;
  const timer = setInterval(() => {
    const elapsed = Date.now() - t0;
    let frame = silenceFrame;
    if (bargeAtMs != null && elapsed >= bargeAtMs && bargeFrames.length) frame = bargeFrames.shift();
    else if (callerFrames.length) frame = callerFrames.shift();
    ws.send(JSON.stringify({ event: "media", streamSid: "MZfake", media: { track: "inbound", chunk: String(++i), timestamp: String(elapsed), payload: frame.toString("base64") } }));
    if (elapsed >= seconds * 1000) {
      clearInterval(timer);
      ws.send(JSON.stringify({ event: "stop", streamSid: "MZfake" }));
      setTimeout(finish, 300);
    }
  }, 20);
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.event === "media") {
    mediaIn++;
    if (firstAudioAt == null) firstAudioAt = Date.now() - t0;
    heard.push(mulawToPcm16(Buffer.from(msg.media.payload, "base64")));
  } else if (msg.event === "clear") {
    clears++;
    console.log(`[fake-twilio] << clear (barge-in) at ${Date.now() - t0}ms`);
  } else if (msg.event === "mark") {
    marks++;
    console.log(`[fake-twilio] << mark ${msg.mark && msg.mark.name} at ${Date.now() - t0}ms`);
  }
});

ws.on("error", (e) => { console.error("[fake-twilio] error", e.message); process.exit(1); });

function finish() {
  const total = heard.reduce((s, c) => s + c.length, 0);
  const all = new Int16Array(total);
  let o = 0; for (const c of heard) { all.set(c, o); o += c.length; }
  const out = path.join(outDir, "heard.wav");
  writeWav8k(out, all);
  console.log(`[fake-twilio] done. media frames heard=${mediaIn} (${(total / 8000).toFixed(2)}s audio), first audio at ${firstAudioAt}ms, clears=${clears}, marks=${marks}`);
  console.log(`[fake-twilio] wrote ${out} — open it to hear what the phone would hear`);
  try { ws.close(); } catch {}
  process.exit(mediaIn > 0 ? 0 : 2);
}
