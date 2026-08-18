import { mulawToPcm16, pcm16ToMulaw } from "./audio/mulaw.mjs";
import { Upsampler, Downsampler } from "./audio/resample.mjs";
import { base64ToInt16 } from "./audio/pcm.mjs";
import { logger } from "./log.mjs";

const log = logger("call-bridge");
const TWILIO_RATE = 8000;
const PIPELINE_RATE = 24000;
const OUT_FRAME_MS = 20;
const OUT_FRAME_SAMPLES_8K = (TWILIO_RATE * OUT_FRAME_MS) / 1000; // 160

/**
 * CallBridge — one instance per phone call. Owns ALL telephony details:
 *   Twilio Media Streams JSON protocol, mu-law <-> PCM16, 8k <-> 24k resampling,
 *   outbound pacing (20 ms frames), barge-in clear, mark/flush.
 * The pipeline only ever sees PCM16 @ 24 kHz. All state is per-instance.
 */
export class CallBridge {
  constructor({ ws, pipeline, callId, onEnd }) {
    this.ws = ws;
    this.pipeline = pipeline;
    this.callId = callId;
    this.onEnd = onEnd || (() => {});
    this.streamSid = null;
    this.customParameters = {};
    this.up = new Upsampler(TWILIO_RATE, PIPELINE_RATE);
    this.down = new Downsampler(PIPELINE_RATE, TWILIO_RATE);
    this.outQueue = []; // Buffers of mu-law, 160 bytes each
    this.outPartial = new Uint8Array(0);
    this.outTimer = null;
    this.stats = { inFrames: 0, outFrames: 0, bargeIns: 0, startedAt: Date.now() };
    this.ended = false;
    this.wirePipeline();
    this.wireSocket();
  }

  wirePipeline() {
    const p = this.pipeline;
    p.on("ready", () => {
      log.info("pipeline ready", { callId: this.callId });
      this.pipeline.createResponse(this.customParameters.greeting || "greet");
    });
    p.on("audio", (b64) => this.enqueueOutbound(base64ToInt16(b64)));
    p.on("speech_started", () => this.handleBargeIn());
    p.on("response_done", () => this.sendMark("response_done"));
    p.on("transcript", (t) => log.info("transcript", { callId: this.callId, ...t }));
    p.on("tool_call", (t) => log.info("tool_call", { callId: this.callId, name: t.name }));
    p.on("error", (e) => log.error("pipeline error", { callId: this.callId, err: String(e && e.message ? e.message : e) }));
    p.on("close", () => this.end("pipeline_closed"));
  }

  wireSocket() {
    this.ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this.handleTwilio(msg);
    });
    this.ws.on("close", () => this.end("caller_hangup"));
    this.ws.on("error", (e) => {
      log.warn("ws error", { callId: this.callId, err: String(e && e.message ? e.message : e) });
      this.end("ws_error");
    });
  }

  handleTwilio(msg) {
    switch (msg.event) {
      case "connected":
        log.info("twilio connected", { callId: this.callId, protocol: msg.protocol });
        break;
      case "start": {
        this.streamSid = msg.streamSid || (msg.start && msg.start.streamSid) || null;
        this.customParameters = (msg.start && msg.start.customParameters) || {};
        log.info("stream start", { callId: this.callId, streamSid: this.streamSid, params: Object.keys(this.customParameters) });
        Promise.resolve(this.pipeline.connect({ customParameters: this.customParameters })).catch((e) => {
          log.error("pipeline connect failed", { callId: this.callId, err: String(e && e.message ? e.message : e) });
          this.end("pipeline_connect_failed");
        });
        break;
      }
      case "media": {
        if (msg.media && msg.media.track && msg.media.track !== "inbound") return;
        this.stats.inFrames++;
        const mulaw = Buffer.from(msg.media.payload, "base64");
        const pcm8k = mulawToPcm16(mulaw);
        const pcm24k = this.up.process(pcm8k);
        this.pipeline.appendAudio(pcm24k);
        break;
      }
      case "mark":
        log.debug("mark ack", { callId: this.callId, name: msg.mark && msg.mark.name });
        break;
      case "dtmf":
        log.info("dtmf", { callId: this.callId, digit: msg.dtmf && msg.dtmf.digit });
        break;
      case "stop":
        this.end("twilio_stop");
        break;
      default:
        break;
    }
  }

  /** PCM16@24k -> mu-law 8k, sliced into 160-byte (20 ms) frames, paced out. */
  enqueueOutbound(pcm24k) {
    const pcm8k = this.down.process(pcm24k);
    const mulaw = pcm16ToMulaw(pcm8k);
    const buf = new Uint8Array(this.outPartial.length + mulaw.length);
    buf.set(this.outPartial, 0);
    buf.set(mulaw, this.outPartial.length);
    let off = 0;
    while (buf.length - off >= OUT_FRAME_SAMPLES_8K) {
      this.outQueue.push(Buffer.from(buf.subarray(off, off + OUT_FRAME_SAMPLES_8K)));
      off += OUT_FRAME_SAMPLES_8K;
    }
    this.outPartial = buf.subarray(off);
    this.startPacer();
  }

  startPacer() {
    if (this.outTimer) return;
    this.outTimer = setInterval(() => {
      const frame = this.outQueue.shift();
      if (!frame) { clearInterval(this.outTimer); this.outTimer = null; return; }
      this.sendJson({ event: "media", streamSid: this.streamSid, media: { payload: frame.toString("base64") } });
      this.stats.outFrames++;
    }, OUT_FRAME_MS);
  }

  handleBargeIn() {
    this.stats.bargeIns++;
    this.outQueue.length = 0;
    this.outPartial = new Uint8Array(0);
    this.sendJson({ event: "clear", streamSid: this.streamSid });
    log.info("barge-in: cleared", { callId: this.callId });
  }

  sendMark(name) {
    this.sendJson({ event: "mark", streamSid: this.streamSid, mark: { name } });
  }

  sendJson(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  end(reason) {
    if (this.ended) return;
    this.ended = true;
    if (this.outTimer) { clearInterval(this.outTimer); this.outTimer = null; }
    const durationMs = Date.now() - this.stats.startedAt;
    log.info("call ended", { callId: this.callId, reason, durationMs, ...this.stats });
    try { this.pipeline.close(); } catch {}
    try { if (this.ws.readyState === 1) this.ws.close(); } catch {}
    this.onEnd({ callId: this.callId, reason, durationMs, stats: this.stats });
  }
}
