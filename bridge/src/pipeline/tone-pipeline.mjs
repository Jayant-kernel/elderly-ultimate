import { EventEmitter } from "node:events";
import { tone, silence, concat, int16ToBase64 } from "../audio/pcm.mjs";
import { logger } from "../log.mjs";

const log = logger("tone-pipeline");

/**
 * Phase-1 stub. Proves the rails without any AI:
 *  - on connect → `ready`
 *  - on createResponse → plays a 3-note chime as PCM16@24k in 20 ms chunks
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
    this.sessionId = null;
  }

  async connect(sessionConfig = {}) {
    this.sessionConfig = sessionConfig;
    log.info("connected", { callId: this.callId });
    queueMicrotask(() => this.emit("ready"));
  }

  appendAudio(samples) {
    if (this.closed) return;
    this.frames++;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / Math.max(1, samples.length));
    const now = Date.now();
    if (now - this.lastLog > 1000) {
      this.lastLog = now;
      log.info("inbound", { callId: this.callId, frames: this.frames, samples: samples.length, rms: Math.round(rms) });
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
    log.info("createResponse", { callId: this.callId, instructions: instructions ? String(instructions).slice(0, 60) : null });
    const chime = concat(
      tone({ freqHz: 523, ms: 250 }), silence(60),
      tone({ freqHz: 659, ms: 250 }), silence(60),
      tone({ freqHz: 784, ms: 450 }),
    );
    const CHUNK = 480; // 20 ms @ 24 kHz
    let offset = 0;
    this.speaking = true;
    this.emit("transcript", { role: "assistant", text: "[tone] chime", itemId: `tone-${Date.now()}` });
    this.timer = setInterval(() => {
      if (this.closed) return this.cancelResponse();
      const end = Math.min(offset + CHUNK, chime.length);
      this.emit("audio", int16ToBase64(chime.subarray(offset, end)));
      offset = end;
      if (offset >= chime.length) {
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
