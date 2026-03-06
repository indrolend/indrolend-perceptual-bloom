// @ts-nocheck
/**
 * AudioWorklet processor — Perceptual Bloom
 *
 * This file runs inside an AudioWorkletGlobalScope (a dedicated thread).
 * It cannot import ES modules via the normal bundler path, so the DSP logic
 * from dsp-core is inlined here.  When porting to JUCE, use the TypeScript
 * sources in packages/dsp-core as the algorithmic reference.
 *
 * Message protocol (from main thread via port.postMessage):
 *   { type: "params", payload: Partial<BloomParams> }
 */

// ---------------------------------------------------------------------------
// Inlined dsp-core/ms.ts
// ---------------------------------------------------------------------------

function msEncode(L, R) {
  return { mid: (L + R) * 0.5, side: (L - R) * 0.5 };
}

function msDecode(mid, side) {
  return { L: mid + side, R: mid - side };
}

// ---------------------------------------------------------------------------
// Inlined dsp-core/perceptualBloom.ts  (coefficient helpers)
// ---------------------------------------------------------------------------

function timeConstCoeff(timeMs, sampleRate) {
  return Math.exp(-1.0 / (timeMs * 0.001 * sampleRate));
}

function lpCoeff(cutoffHz, sampleRate) {
  return Math.exp((-2.0 * Math.PI * cutoffHz) / sampleRate);
}

function dbToLinear(db) {
  return Math.pow(10.0, db / 20.0);
}

// ---------------------------------------------------------------------------
// Default parameters
// ---------------------------------------------------------------------------

const DEFAULT_PARAMS = {
  punch: 0.7,
  bloom: 0.6,
  bassMonoHz: 200,
  tailPan: 0.0,
  tailSkew: 0.3,
  outputTrimDb: 0.0,
};

// ---------------------------------------------------------------------------
// Processor class
// ---------------------------------------------------------------------------

class PerceptualBloomProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Parameter state
    this._params = { ...DEFAULT_PARAMS };

    // DSP state
    this._envelope = 0;
    this._prevEnvelope = 0;
    this._bassLowpassZ = 0;

    // Coefficients (computed lazily on first process call or param change)
    this._needsCoeffUpdate = true;
    this._attackCoeff = 0;
    this._releaseCoeff = 0;
    this._bassCoeff = 0;

    // A/B bypass flag
    this._bypass = false;

    // Listen for parameter updates from the main thread
    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "params") {
        const prev = this._params;
        this._params = { ...prev, ...msg.payload };
        if (
          this._params.bassMonoHz !== prev.bassMonoHz
        ) {
          this._needsCoeffUpdate = true;
        }
      } else if (msg.type === "bypass") {
        this._bypass = msg.value;
      }
    };
  }

  _updateCoeffs() {
    this._attackCoeff = timeConstCoeff(2, sampleRate);    // ~2 ms
    this._releaseCoeff = timeConstCoeff(80, sampleRate);  // ~80 ms
    this._bassCoeff = lpCoeff(this._params.bassMonoHz, sampleRate);
    this._needsCoeffUpdate = false;
  }

  /**
   * process() — called by the browser every ~128 samples (one render quantum).
   */
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    // Passthrough if no input or bypass is active
    if (!input || input.length < 2) {
      return true;
    }

    if (this._bypass) {
      // Copy input to output unchanged
      for (let ch = 0; ch < Math.min(input.length, output.length); ch++) {
        output[ch].set(input[ch]);
      }
      return true;
    }

    if (this._needsCoeffUpdate) {
      this._updateCoeffs();
    }

    const inL = input[0];
    const inR = input[1] ?? input[0]; // mono fallback
    const outL = output[0];
    const outR = output[1] ?? output[0];

    const p = this._params;
    const trimGain = dbToLinear(p.outputTrimDb);

    for (let i = 0; i < inL.length; i++) {
      const L = inL[i];
      const R = inR[i];

      // ── M/S encode ────────────────────────────────────────────────
      const { mid, side } = msEncode(L, R);

      // ── Envelope follower ─────────────────────────────────────────
      const absIn = Math.abs(mid);
      if (absIn > this._envelope) {
        this._envelope =
          this._attackCoeff * this._envelope +
          (1 - this._attackCoeff) * absIn;
      } else {
        this._envelope =
          this._releaseCoeff * this._envelope +
          (1 - this._releaseCoeff) * absIn;
      }

      // ── Transient / sustain masks ──────────────────────────────────
      const envDelta = Math.max(0, this._envelope - this._prevEnvelope);
      this._prevEnvelope = this._envelope;

      const transientMask = Math.min(
        1.0,
        (envDelta / (this._envelope + 1e-9)) * 8.0
      );
      const sustainMask = 1.0 - transientMask;

      // ── Bass/treble split on Side ─────────────────────────────────
      this._bassLowpassZ =
        this._bassCoeff * this._bassLowpassZ +
        (1 - this._bassCoeff) * side;
      const lowSide = this._bassLowpassZ;
      const hiSide = side - lowSide;

      // ── Width shaping ─────────────────────────────────────────────
      const punchGain = 1.0 - p.punch * transientMask;
      const baseSide = lowSide + hiSide * punchGain;

      const bloomGain = 1.0 + p.bloom * sustainMask;
      const wideSide = lowSide + hiSide * bloomGain;

      const tailSide = wideSide - baseSide;

      // ── Tail asymmetry ────────────────────────────────────────────
      const skewDepth = p.tailSkew * sustainMask;
      const panL = 1.0 + p.tailPan * skewDepth;
      const panR = 1.0 - p.tailPan * skewDepth;

      const asymMidContrib = tailSide * (panL - panR) * 0.5;
      const asymSideContrib = tailSide * (panL + panR) * 0.5;

      const finalMid = mid + asymMidContrib;
      const finalSide = baseSide + asymSideContrib;

      // ── M/S decode + trim ─────────────────────────────────────────
      const { L: oL, R: oR } = msDecode(finalMid, finalSide);
      outL[i] = oL * trimGain;
      outR[i] = oR * trimGain;
    }

    return true; // keep processor alive
  }
}

registerProcessor("perceptual-bloom-processor", PerceptualBloomProcessor);
