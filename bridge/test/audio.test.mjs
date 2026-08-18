import { test } from "node:test";
import assert from "node:assert/strict";
import { mulawToPcm16, pcm16ToMulaw } from "../src/audio/mulaw.mjs";
import { Upsampler, Downsampler, Resampler24kTo16k } from "../src/audio/resample.mjs";
import { tone, int16ToBase64, base64ToInt16 } from "../src/audio/pcm.mjs";

function rms(samples) {
  let s = 0;
  for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
  return Math.sqrt(s / Math.max(1, samples.length));
}

/** Goertzel power at a frequency — lets us assert "the tone survived". */
function goertzel(samples, freq, rate) {
  const k = Math.round((samples.length * freq) / rate);
  const w = (2 * Math.PI * k) / samples.length;
  const c = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < samples.length; i++) { s0 = samples[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

test("mu-law round trip preserves silence and is near-lossless for speech-level audio", () => {
  const zeros = new Int16Array(160);
  assert.deepEqual(Array.from(mulawToPcm16(pcm16ToMulaw(zeros))), Array.from(zeros));

  const t = tone({ freqHz: 400, ms: 100, sampleRate: 8000, amplitude: 0.5 });
  const back = mulawToPcm16(pcm16ToMulaw(t));
  let maxErr = 0;
  for (let i = 0; i < t.length; i++) maxErr = Math.max(maxErr, Math.abs(t[i] - back[i]) / Math.max(64, Math.abs(t[i])));
  assert.ok(maxErr < 0.1, `mu-law relative error too high: ${maxErr}`);
});

test("mu-law encoder matches known reference bytes", () => {
  // Reference values from the G.711 spec: 0 -> 0xFF, max positive -> 0x80, max negative -> 0x00
  const enc = pcm16ToMulaw(Int16Array.from([0, 32767, -32768]));
  assert.equal(enc[0], 0xff);
  assert.equal(enc[1], 0x80);
  assert.equal(enc[2], 0x00);
});

test("upsampler 8k->24k triples length and keeps the tone", () => {
  const up = new Upsampler(8000, 24000);
  const t = tone({ freqHz: 440, ms: 200, sampleRate: 8000, amplitude: 0.5 });
  const out = up.process(t);
  assert.equal(out.length, t.length * 3);
  const tail = out.subarray(2400); // skip filter warm-up
  const inBand = goertzel(tail, 440, 24000);
  const image = goertzel(tail, 8000 - 440, 24000); // aliasing image if the low-pass failed
  assert.ok(inBand > image * 50, `image not suppressed: inBand=${inBand} image=${image}`);
  assert.ok(rms(tail) > rms(t) * 0.7, "upsampled tone lost too much energy");
});

test("downsampler 24k->8k thirds length and keeps the tone", () => {
  const down = new Downsampler(24000, 8000);
  const t = tone({ freqHz: 440, ms: 200, sampleRate: 24000, amplitude: 0.5 });
  const out = down.process(t);
  assert.equal(out.length, t.length / 3);
  const tail = out.subarray(800);
  assert.ok(goertzel(tail, 440, 8000) > goertzel(tail, 1500, 8000) * 50, "tone not dominant after downsample");
});

test("24k->16k resampler produces 2/3 length and keeps the tone", () => {
  const r = new Resampler24kTo16k();
  const t = tone({ freqHz: 300, ms: 300, sampleRate: 24000, amplitude: 0.5 });
  const out = r.process(t);
  assert.ok(Math.abs(out.length - (t.length * 2) / 3) <= 2, `bad length ${out.length}`);
  const tail = out.subarray(1600);
  assert.ok(goertzel(tail, 300, 16000) > goertzel(tail, 2000, 16000) * 50);
});

test("resamplers keep per-instance state (no cross-call bleed)", () => {
  const a = new Downsampler(24000, 8000);
  const b = new Downsampler(24000, 8000);
  a.process(tone({ freqHz: 440, ms: 100, amplitude: 0.9 }));
  const quiet = b.process(new Int16Array(2400));
  assert.equal(rms(quiet), 0, "fresh instance leaked another instance's history");
});

test("base64 PCM helpers round trip", () => {
  const t = tone({ freqHz: 200, ms: 20 });
  const back = base64ToInt16(int16ToBase64(t));
  assert.deepEqual(Array.from(back), Array.from(t));
});
