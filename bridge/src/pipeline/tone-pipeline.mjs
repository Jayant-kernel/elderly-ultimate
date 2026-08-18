import { EventEmitter } from "node:events";
import { tone, silence, concat } from "../audio/pcm.mjs";
import { mulawToPcm16, pcm16ToMulaw } from "../audio/mulaw.mjs";
import { logger } from "../log.mjs";

const log = logger("tone-pipeline");
const RATE = 8000;
const CHUNK_BYTES = 160; // 20 ms of mu-law @ 8 kHz

/**
 * Phase-1 stub. Proves the rails without any AI:
 *  - on connect → `ready`
 *  - on createResponse → plays a 3-note chime as mu-law 8k bytes in 20 ms
 *    chunks, tagged with a fresh generation id
 *  - logs inbound audio frame counts + RMS so we can see the phone's mic works
 *  - if inbound audio gets loud while we're "speaking" → speech_started (fake barge-in)
 */
export class TonePipeline extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.callId = opts.callId || "unknown";
    this.frames = 0;
    this.speaking = false;
    this.timer = null;
    this.closed = false;
    this.lastLog = 0;
    this.gen = 0;
    this.seq = 0;
  }

  async connect(context = {}) {
    this.context = context;
    log.info("connected", { callId: this.callId });
    queueMicrotask(() => this.emit("ready"));
  }

  appendAudio(mulawBytes) {
    if (this.closed) return;
    this.frames++;
    const samples = mulawToPcm16(mulawBytes);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / Math.max(1, samples.length));
    const now = Date.now();
    if (now - this.lastLog > 1000) {
      this.lastLog = now;
      log.info("inbound", { callId: this.callId, frames: this.frames, bytes: mulawBytes.length, rms: Math.round(rms) });
    }
    if (this.speaking && rms > 2500) {
      log.info("fake barge-in", { callId: this.callId, rms: Math.round(rms) });
      this.cancelResponse();
      this.emit("speech_started");
    }
  }

  createResponse(instructions) {
    if (this.closed) return;
    this.cancelResponse();
    const genId = `gen-${++this.gen}`;
    log.info("createResponse", { callId: this.callId, genId, instructions: instructions ? String(instructions).slice(0, 60) : null });
    const chime = concat(
      tone({ freqHz: 523, ms: 250, sampleRate: RATE }), silence(60, RATE),
      tone({ freqHz: 659, ms: 250, sampleRate: RATE }), silence(60, RATE),
      tone({ freqHz: 784, ms: 450, sampleRate: RATE }),
    );
    const mulaw = pcm16ToMulaw(chime);
    let offset = 0;
    this.speaking = true;
    this.emit("transcript", { role: "assistant", text: "[tone] chime", seq: this.seq++, at: Date.now() });
    this.timer = setInterval(() => {
      if (this.closed) return this.cancelResponse();
      const end = Math.min(offset + CHUNK_BYTES, mulaw.length);
      this.emit("audio", mulaw.subarray(offset, end), genId);
      offset = end;
      if (offset >= mulaw.length) {
        this.cancelResponse();
        this.emit("response_done");
      }
    }, 20);
  }

  cancelResponse() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.speaking = false;
  }

  sendToolResult() {}

  close() {
    if (this.closed) return;
    this.closed = true;
    this.cancelResponse();
    log.info("closed", { callId: this.callId, frames: this.frames });
    this.emit("close");
  }
}
