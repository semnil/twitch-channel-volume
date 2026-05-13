// audio-worklet.js — Loaded by page-bridge.js into the page's AudioContext.
// Accumulates K-weighted mean-square per fixed-length sub-block and posts
// values to the main thread, which then forms 400ms / 3s windows.

class KMeanSquareProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() { return []; }

  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    const blockSec = Number(opts.blockSec) || 0.1;
    this._blockLen = Math.max(64, Math.round(sampleRate * blockSec));
    this._acc = 0;
    this._count = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    const ch1 = input.length > 1 ? input[1] : null;
    if (!ch0) return true;
    const len = ch0.length;
    for (let i = 0; i < len; i++) {
      const l = ch0[i];
      const r = ch1 ? ch1[i] : l;
      this._acc += l * l + r * r;
      this._count++;
      if (this._count >= this._blockLen) {
        const ms = this._acc / this._count;
        this._acc = 0;
        this._count = 0;
        this.port.postMessage({ ms, samples: this._blockLen });
      }
    }
    return true;
  }
}

registerProcessor('k-mean-square', KMeanSquareProcessor);
