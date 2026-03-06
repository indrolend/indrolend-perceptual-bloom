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

// AudioWorkletGlobalScope exposes `sampleRate`, `registerProcessor`, and
// `AudioWorkletProcessor` as globals not present in TypeScript's lib.dom.d.ts.
// We declare the minimal shapes we need so the rest of the file is type-safe.
declare const sampleRate: number;

interface AudioWorkletProcessorBase {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}

declare abstract class AudioWorkletProcessor implements AudioWorkletProcessorBase {
  readonly port: MessagePort;
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processor: new () => AudioWorkletProcessorBase
): void;

// ---------------------------------------------------------------------------
// Parameter type (mirrors BloomParams in packages/dsp-core)
// ---------------------------------------------------------------------------

interface BloomParams {
  punch: number;
  bloom: number;
  bassMonoHz: number;
  tailPan: number;
  tailSkew: number;
  outputTrimDb: number;
}

// ---------------------------------------------------------------------------
// Inlined dsp-core/ms.ts
// ---------------------------------------------------------------------------

function msEncode(L: number, R: number): { mid: number; side: number } {
  return { mid: (L + R) * 0.5, side: (L - R) * 0.5 };
}

function msDecode(mid: number, side: number): { L: number; R: number } {
  return { L: mid + side, R: mid - side };
}

// ---------------------------------------------------------------------------
// Inlined dsp-core/perceptualBloom.ts  (coefficient helpers)
// ---------------------------------------------------------------------------

function timeConstCoeff(timeMs: number, sr: number): number {
  return Math.exp(-1.0 / (timeMs * 0.001 * sr));
}

function lpCoeff(cutoffHz: number, sr: number): number {
  return Math.exp((-2.0 * Math.PI * cutoffHz) / sr);
}

function dbToLinear(db: number): number {
  return Math.pow(10.0, db / 20.0);
}

// ---------------------------------------------------------------------------
// Default parameters
// ---------------------------------------------------------------------------

const DEFAULT_PARAMS: BloomParams = {
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
  private _params: BloomParams;
  private _envelope: number;
  private _prevEnvelope: number;
  private _bassLowpassZ: number;
  private _needsCoeffUpdate: boolean;
  private _attackCoeff: number;
  private _releaseCoeff: number;
  private _bassCoeff: number;
  private _bypass: boolean;

  constructor() {
    super();

    this._params = { ...DEFAULT_PARAMS };
    this._envelope = 0;
    this._prevEnvelope = 0;
    this._bassLowpassZ = 0;
    this._needsCoeffUpdate = true;
    this._attackCoeff = 0;
    this._releaseCoeff = 0;
    this._bassCoeff = 0;
    this._bypass = false;

    // Listen for parameter updates from the main thread
    this.port.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type: string; payload?: Partial<BloomParams>; value?: boolean };
      if (msg.type === "params" && msg.payload) {
        const prev = this._params;
        this._params = { ...prev, ...msg.payload };
        if (this._params.bassMonoHz !== prev.bassMonoHz) {
          this._needsCoeffUpdate = true;
        }
      } else if (msg.type === "bypass") {
        this._bypass = msg.value ?? false;
      }
    };
  }

  private _updateCoeffs(): void {
    this._attackCoeff = timeConstCoeff(2, sampleRate);    // ~2 ms
    this._releaseCoeff = timeConstCoeff(80, sampleRate);  // ~80 ms
    this._bassCoeff = lpCoeff(this._params.bassMonoHz, sampleRate);
    this._needsCoeffUpdate = false;
  }

  /**
   * process() — called by the browser every ~128 samples (one render quantum).
   */
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
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
