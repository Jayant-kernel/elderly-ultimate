/**
 * G.711 μ-law codec. Twilio Media Streams carry 8 kHz μ-law; everything inside
 * the bridge is PCM16. Pure functions, no state — safe across concurrent calls.
 */
const BIAS = 0x84;
const CLIP = 32635;

const decodeTable = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let u = ~i & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  decodeTable[i] = sign ? -sample : sample;
}

export function mulawToPcm16(bytes) {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = decodeTable[bytes[i]];
  return out;
}

export function pcm16ToMulaw(samples) {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    let sign = 0;
    if (s < 0) { sign = 0x80; s = -s; }
    if (s > CLIP) s = CLIP;
    s += BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
    const mantissa = (s >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}
