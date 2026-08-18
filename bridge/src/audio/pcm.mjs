export function int16ToBuffer(samples) {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}
export function bufferToInt16(buf) {
  // Node's small Buffers live in a shared pool with a non-zero byteOffset, so
  // copy into a fresh, aligned ArrayBuffer before viewing it as Int16.
  const n = Math.floor(buf.length / 2);
  const ab = new ArrayBuffer(n * 2);
  new Uint8Array(ab).set(buf.subarray(0, n * 2));
  return new Int16Array(ab);
}
export function int16ToBase64(samples) {
  return int16ToBuffer(samples).toString("base64");
}
export function base64ToInt16(b64) {
  return bufferToInt16(Buffer.from(b64, "base64"));
}
/** Generate a sine tone as PCM16. */
export function tone({ freqHz = 440, ms = 500, sampleRate = 24000, amplitude = 0.3 }) {
  const n = Math.round((sampleRate * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    // small fade in/out to avoid clicks
    const env = Math.min(1, i / 240, (n - i) / 240);
    out[i] = Math.round(Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * 32767 * amplitude * env);
  }
  return out;
}
export function silence(ms, sampleRate = 24000) {
  return new Int16Array(Math.round((sampleRate * ms) / 1000));
}
export function concat(...chunks) {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Int16Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
