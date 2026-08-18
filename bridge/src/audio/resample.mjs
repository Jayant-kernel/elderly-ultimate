/**
 * Hand-rolled FIR resamplers — the bridge's only dependency is `ws`.
 * Each instance keeps its own filter history: one per call, never shared.
 */
export function buildLowPass(cutoffHz, sampleRate, taps = 63) {
  const fc = cutoffHz / sampleRate;
  const mid = (taps - 1) / 2;
  const coeffs = new Float32Array(taps);
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const k = n - mid;
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (taps - 1)); // Hamming
    coeffs[n] = sinc * window;
    sum += coeffs[n];
  }
  for (let n = 0; n < taps; n++) coeffs[n] /= sum;
  return coeffs;
}

export class FirFilter {
  constructor(coeffs) {
    this.coeffs = coeffs;
    this.history = new Float32Array(coeffs.length);
    this.pos = 0;
  }
  /** Push one sample, get filtered sample. */
  push(x) {
    const { coeffs, history } = this;
    const n = coeffs.length;
    history[this.pos] = x;
    let acc = 0;
    let idx = this.pos;
    for (let i = 0; i < n; i++) {
      acc += coeffs[i] * history[idx];
      idx = idx === 0 ? n - 1 : idx - 1;
    }
    this.pos = (this.pos + 1) % n;
    return acc;
  }
}

function clamp16(v) {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
}

/** Integer-ratio upsampler: zero-stuff then low-pass. */
export class Upsampler {
  constructor(fromRate, toRate) {
    if (toRate % fromRate !== 0) throw new Error("Upsampler needs integer ratio");
    this.ratio = toRate / fromRate;
    this.filter = new FirFilter(buildLowPass(fromRate * 0.45, toRate));
  }
  process(samples) {
    const out = new Int16Array(samples.length * this.ratio);
    let o = 0;
    for (let i = 0; i < samples.length; i++) {
      out[o++] = clamp16(this.filter.push(samples[i] * this.ratio));
      for (let r = 1; r < this.ratio; r++) out[o++] = clamp16(this.filter.push(0));
    }
    return out;
  }
}

/** Integer-ratio downsampler: low-pass then decimate. */
export class Downsampler {
  constructor(fromRate, toRate) {
    if (fromRate % toRate !== 0) throw new Error("Downsampler needs integer ratio");
    this.ratio = fromRate / toRate;
    this.filter = new FirFilter(buildLowPass(toRate * 0.45, fromRate));
    this.phase = 0;
  }
  process(samples) {
    const out = [];
    for (let i = 0; i < samples.length; i++) {
      const y = this.filter.push(samples[i]);
      if (this.phase === 0) out.push(clamp16(y));
      this.phase = (this.phase + 1) % this.ratio;
    }
    return Int16Array.from(out);
  }
}

/** 24k → 16k for Sarvam (ratio 3:2): upsample ×2 to 48k, then decimate ÷3. */
export class Resampler24kTo16k {
  constructor() {
    this.up = new Upsampler(24000, 48000);
    this.down = new Downsampler(48000, 16000);
  }
  process(samples) {
    return this.down.process(this.up.process(samples));
  }
}
