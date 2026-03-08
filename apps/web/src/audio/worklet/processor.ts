/**
 * AudioWorklet processor — Perceptual Bloom (extended)
 *
 * This file runs inside an AudioWorkletGlobalScope (a dedicated thread).
 * It cannot import ES modules via the normal bundler path, so all DSP logic
 * is inlined here.  When porting to JUCE, use the TypeScript sources in
 * packages/dsp-core as the algorithmic reference.
 *
 * Message protocol (from main thread via port.postMessage):
 *   { type: "params",  payload: Partial<BloomParams> }
 *   { type: "bypass",  value: boolean }
 *
 * Signal chain (per sample):
 *   Input → Bloom → Compressor → Sample-Rate Degrade
 *         → Echo/Delay → Chorus → Reverb → Master Pan → Output
 */

// AudioWorkletGlobalScope exposes `sampleRate`, `registerProcessor`, and
// `AudioWorkletProcessor` as globals not present in TypeScript's lib.dom.d.ts.
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
// Full parameter type — Bloom params + all effect params
// ---------------------------------------------------------------------------

interface BloomParams {
  // ── Bloom (original) ─────────────────────────────────────────────────────
  punch: number;
  bloom: number;
  bassMonoHz: number;
  tailPan: number;
  tailSkew: number;
  outputTrimDb: number;
  // ── Compressor ────────────────────────────────────────────────────────────
  /** Threshold in dBFS. Signal above this gets compressed. Default 0 = off. */
  compThreshDb: number;
  /** Compression ratio (1:1 = bypass, 4:1 = 4x reduction above threshold). */
  compRatio: number;
  /** Attack time in ms for the compressor envelope. */
  compAttackMs: number;
  /** Release time in ms for the compressor envelope. */
  compReleaseMs: number;
  /** Make-up gain in dB applied after compression. */
  compMakeupDb: number;
  // ── Echo / Delay ──────────────────────────────────────────────────────────
  /** Time between echo repeats in ms. */
  echoDelayMs: number;
  /** 0 = single echo, 1–8 = increasing feedback → longer tail. */
  echoRepeats: number;
  /** Echo wet level (0 = off, 1 = full echo added on top). */
  echoMix: number;
  // ── Chorus ────────────────────────────────────────────────────────────────
  /** LFO modulation rate in Hz. */
  chorusRate: number;
  /** Modulation depth — sets the center delay time in ms. */
  chorusDepth: number;
  /** Chorus wet/dry mix (0 = dry, 1 = full chorus). */
  chorusMix: number;
  // ── Sample-Rate Degradation ───────────────────────────────────────────────
  /** Integer hold factor: 1 = off, 2 = half rate, 16 = very degraded. */
  srateDivide: number;
  // ── Reverb ────────────────────────────────────────────────────────────────
  /** Room size: controls comb-filter feedback (0 = small, 1 = huge). */
  reverbSize: number;
  /** High-frequency damping inside the comb filters (0 = bright, 1 = dark). */
  reverbDamp: number;
  /** Reverb wet/dry mix (0 = dry, 1 = full reverb). */
  reverbMix: number;
  // ── Master Pan ────────────────────────────────────────────────────────────
  /** Post-effects stereo pan: -1 = hard left, 0 = centre, +1 = hard right. */
  masterPan: number;
}

// ---------------------------------------------------------------------------
// DSP helpers
// ---------------------------------------------------------------------------

function msEncode(L: number, R: number): { mid: number; side: number } {
  return { mid: (L + R) * 0.5, side: (L - R) * 0.5 };
}

function msDecode(mid: number, side: number): { L: number; R: number } {
  return { L: mid + side, R: mid - side };
}

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
// Default parameters (all effects off / neutral)
// ---------------------------------------------------------------------------

const DEFAULT_PARAMS: BloomParams = {
  punch: 0.7,
  bloom: 0.6,
  bassMonoHz: 200,
  tailPan: 0.0,
  tailSkew: 0.3,
  outputTrimDb: 0.0,
  // Compressor — ratio 1:1 is unity (bypass)
  compThreshDb: -20,
  compRatio: 1,
  compAttackMs: 10,
  compReleaseMs: 100,
  compMakeupDb: 0,
  // Echo — mix 0 means off
  echoDelayMs: 300,
  echoRepeats: 3,
  echoMix: 0,
  // Chorus — mix 0 means off
  chorusRate: 0.5,
  chorusDepth: 7,
  chorusMix: 0,
  // Sample-rate degradation — divide 1 means off
  srateDivide: 1,
  // Reverb — mix 0 means off
  reverbSize: 0.6,
  reverbDamp: 0.5,
  reverbMix: 0,
  // Master pan — 0 = centre
  masterPan: 0,
};

// ---------------------------------------------------------------------------
// Processor class
// ---------------------------------------------------------------------------

class PerceptualBloomProcessor extends AudioWorkletProcessor {
  // ── Bloom state ───────────────────────────────────────────────────────────
  private _params: BloomParams;
  private _envelope: number;
  private _prevEnvelope: number;
  private _bassLowpassZ: number;
  private _needsCoeffUpdate: boolean;
  private _attackCoeff: number;
  private _releaseCoeff: number;
  private _bassCoeff: number;
  private _bypass: boolean;

  // ── Compressor state ──────────────────────────────────────────────────────
  private _compEnv: number;
  private _compAttackCoeff: number;
  private _compReleaseCoeff: number;

  // ── Echo state (ring buffer) ──────────────────────────────────────────────
  private _echoL: Float32Array;
  private _echoR: Float32Array;
  private _echoWriteIdx: number;

  // ── Chorus state ──────────────────────────────────────────────────────────
  private _chorusBufL: Float32Array;
  private _chorusBufR: Float32Array;
  private _chorusWriteIdx: number;
  private _chorusPhase: number;

  // ── Sample-rate degradation state ─────────────────────────────────────────
  private _srateHoldL: number;
  private _srateHoldR: number;
  private _srateCounter: number;

  // ── Reverb state (Freeverb-inspired: 4 comb + 2 allpass per channel) ──────
  private _combBufL: Float32Array[];
  private _combBufR: Float32Array[];
  private _combIdxL: number[];
  private _combIdxR: number[];
  private _combFeedZL: number[];
  private _combFeedZR: number[];
  private _apBufL: Float32Array[];
  private _apBufR: Float32Array[];
  private _apIdxL: number[];
  private _apIdxR: number[];

  constructor() {
    super();

    this._params = { ...DEFAULT_PARAMS };

    // Bloom
    this._envelope = 0;
    this._prevEnvelope = 0;
    this._bassLowpassZ = 0;
    this._needsCoeffUpdate = true;
    this._attackCoeff = 0;
    this._releaseCoeff = 0;
    this._bassCoeff = 0;
    this._bypass = false;

    // Compressor
    this._compEnv = 0;
    this._compAttackCoeff = 0;
    this._compReleaseCoeff = 0;

    // Echo ring buffer — 2 s max delay
    const echoLen = Math.ceil(sampleRate * 2);
    this._echoL = new Float32Array(echoLen);
    this._echoR = new Float32Array(echoLen);
    this._echoWriteIdx = 0;

    // Chorus buffer — 30 ms max centre delay
    const chorusLen = Math.ceil(sampleRate * 0.03) + 4;
    this._chorusBufL = new Float32Array(chorusLen);
    this._chorusBufR = new Float32Array(chorusLen);
    this._chorusWriteIdx = 0;
    this._chorusPhase = 0;

    // Sample-rate degradation
    this._srateHoldL = 0;
    this._srateHoldR = 0;
    this._srateCounter = 0;

    // Reverb — Freeverb delay lengths scaled to current sampleRate.
    // Base values (at 44 100 Hz) are classic Freeverb comb-filter lengths;
    // +23 per channel provides the stereo decorrelation spread.
    const s44 = sampleRate / 44100;
    const combLenL = [1116, 1188, 1277, 1356].map(d => Math.max(8, Math.round(d * s44)));
    const combLenR = combLenL.map(d => d + Math.round(23 * s44));
    const apLen    = [556, 441].map(d => Math.max(4, Math.round(d * s44)));

    this._combBufL   = combLenL.map(n => new Float32Array(n));
    this._combBufR   = combLenR.map(n => new Float32Array(n));
    this._combIdxL   = [0, 0, 0, 0];
    this._combIdxR   = [0, 0, 0, 0];
    this._combFeedZL = [0, 0, 0, 0];
    this._combFeedZR = [0, 0, 0, 0];
    this._apBufL     = apLen.map(n => new Float32Array(n));
    this._apBufR     = apLen.map(n => new Float32Array(n));
    this._apIdxL     = [0, 0];
    this._apIdxR     = [0, 0];

    // Message handler
    this.port.onmessage = (event: MessageEvent) => {
      const msg = event.data as {
        type: string;
        payload?: Partial<BloomParams>;
        value?: boolean;
      };
      if (msg.type === "params" && msg.payload) {
        this._params = { ...this._params, ...msg.payload };
        this._needsCoeffUpdate = true;
      } else if (msg.type === "bypass") {
        this._bypass = msg.value ?? false;
      }
    };
  }

  private _updateCoeffs(): void {
    const p = this._params;
    // Bloom
    this._attackCoeff  = timeConstCoeff(2, sampleRate);
    this._releaseCoeff = timeConstCoeff(80, sampleRate);
    this._bassCoeff    = lpCoeff(p.bassMonoHz, sampleRate);
    // Compressor
    this._compAttackCoeff  = timeConstCoeff(Math.max(0.1, p.compAttackMs), sampleRate);
    this._compReleaseCoeff = timeConstCoeff(Math.max(1,   p.compReleaseMs), sampleRate);
    this._needsCoeffUpdate = false;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input  = inputs[0];
    const output = outputs[0];

    if (!input || input.length === 0 || !output || output.length === 0) {
      return true;
    }

    if (this._bypass) {
      for (let ch = 0; ch < Math.min(input.length, output.length); ch++) {
        output[ch].set(input[ch]);
      }
      return true;
    }

    if (this._needsCoeffUpdate) {
      this._updateCoeffs();
    }

    const inL  = input[0];
    const inR  = input[1] ?? input[0];
    const outL = output[0];
    const outR = output[1] ?? output[0];

    const p = this._params;

    // ── Pre-block coefficient snapshots (avoids repeated property lookups) ──

    const trimGain     = dbToLinear(p.outputTrimDb);
    const compMakeup   = dbToLinear(p.compMakeupDb);
    const compThreshLin = dbToLinear(p.compThreshDb);

    const echoLen          = this._echoL.length;
    const echoDelaySamples = Math.min(echoLen - 1, Math.round(p.echoDelayMs * 0.001 * sampleRate));
    // Echo feedback: dividing by 9 maps the 0–8 integer range to 0–0.9,
    // giving no feedback at 0 (single echo) and a long, dense tail at 8.
    const echoFeedback     = (p.echoRepeats / 9) * 0.9;

    const srateDiv = Math.max(1, Math.round(p.srateDivide));

    const chorusCenterSamples = Math.round(p.chorusDepth * 0.001 * sampleRate);
    const chorusPhaseInc      = (2 * Math.PI * p.chorusRate) / sampleRate;
    const cLen                = this._chorusBufL.length;

    // Reverb comb-filter feedback: 0.5 is the minimum (small room) and
    // 0.48 is the range, giving 0.98 at reverbSize = 1 (infinite space).
    const combFeedback = 0.5 + 0.48 * p.reverbSize;
    const combDamp     = p.reverbDamp * 0.4;

    // Equal-power master pan (unity at centre)
    const panAngle    = (p.masterPan + 1) * Math.PI * 0.25;
    const masterGainL = Math.cos(panAngle) * Math.SQRT2;
    const masterGainR = Math.sin(panAngle) * Math.SQRT2;

    for (let i = 0; i < inL.length; i++) {
      const L = inL[i];
      const R = inR[i];

      // ── Bloom ─────────────────────────────────────────────────────────────
      const { mid, side } = msEncode(L, R);

      const absIn = Math.abs(mid);
      if (absIn > this._envelope) {
        this._envelope = this._attackCoeff * this._envelope + (1 - this._attackCoeff) * absIn;
      } else {
        this._envelope = this._releaseCoeff * this._envelope + (1 - this._releaseCoeff) * absIn;
      }

      const envDelta     = Math.max(0, this._envelope - this._prevEnvelope);
      this._prevEnvelope = this._envelope;

      const transientMask = Math.min(1.0, (envDelta / (this._envelope + 1e-9)) * 8.0);
      const sustainMask   = 1.0 - transientMask;

      this._bassLowpassZ =
        this._bassCoeff * this._bassLowpassZ + (1 - this._bassCoeff) * side;
      const lowSide = this._bassLowpassZ;
      const hiSide  = side - lowSide;

      const punchGain = 1.0 - p.punch * transientMask;
      const baseSide  = lowSide + hiSide * punchGain;
      const bloomGain = 1.0 + p.bloom * sustainMask;
      const wideSide  = lowSide + hiSide * bloomGain;
      const tailSide  = wideSide - baseSide;

      const skewDepth      = p.tailSkew * sustainMask;
      const bloomPanL      = 1.0 + p.tailPan * skewDepth;
      const bloomPanR      = 1.0 - p.tailPan * skewDepth;
      const asymMidContrib  = tailSide * (bloomPanL - bloomPanR) * 0.5;
      const asymSideContrib = tailSide * (bloomPanL + bloomPanR) * 0.5;

      const { L: bL, R: bR } = msDecode(mid + asymMidContrib, baseSide + asymSideContrib);
      let oL = bL * trimGain;
      let oR = bR * trimGain;

      // ── Compressor ────────────────────────────────────────────────────────
      {
        const peak = Math.max(Math.abs(oL), Math.abs(oR));
        if (peak > this._compEnv) {
          this._compEnv =
            this._compAttackCoeff * this._compEnv + (1 - this._compAttackCoeff) * peak;
        } else {
          this._compEnv =
            this._compReleaseCoeff * this._compEnv + (1 - this._compReleaseCoeff) * peak;
        }

        if (p.compRatio > 1.0 && this._compEnv > compThreshLin) {
          const envDb         = 20 * Math.log10(this._compEnv + 1e-30);
          const gainReducDb   = (envDb - p.compThreshDb) * (1.0 - 1.0 / p.compRatio);
          const gainLin       = dbToLinear(-gainReducDb) * compMakeup;
          oL *= gainLin;
          oR *= gainLin;
        } else {
          oL *= compMakeup;
          oR *= compMakeup;
        }
      }

      // ── Sample-Rate Degradation ───────────────────────────────────────────
      if (srateDiv > 1) {
        if (this._srateCounter === 0) {
          this._srateHoldL = oL;
          this._srateHoldR = oR;
        }
        oL = this._srateHoldL;
        oR = this._srateHoldR;
        this._srateCounter = (this._srateCounter + 1) % srateDiv;
      }

      // ── Echo / Delay ──────────────────────────────────────────────────────
      {
        const readIdx = ((this._echoWriteIdx - echoDelaySamples) + echoLen * 2) % echoLen;
        const echoOutL = this._echoL[readIdx];
        const echoOutR = this._echoR[readIdx];
        this._echoL[this._echoWriteIdx] = oL + echoOutL * echoFeedback;
        this._echoR[this._echoWriteIdx] = oR + echoOutR * echoFeedback;
        this._echoWriteIdx = (this._echoWriteIdx + 1) % echoLen;
        oL += echoOutL * p.echoMix;
        oR += echoOutR * p.echoMix;
      }

      // ── Chorus ────────────────────────────────────────────────────────────
      // Always write to buffer so it's ready when mix is enabled
      this._chorusBufL[this._chorusWriteIdx] = oL;
      this._chorusBufR[this._chorusWriteIdx] = oR;

      this._chorusPhase += chorusPhaseInc;
      if (this._chorusPhase > Math.PI * 2) this._chorusPhase -= Math.PI * 2;

      if (p.chorusMix > 0) {
        const lfo          = Math.sin(this._chorusPhase);
        const delaySamples = Math.max(1, chorusCenterSamples * (1.0 + lfo * 0.5));
        const readF        = this._chorusWriteIdx - delaySamples;
        const ri0          = Math.floor(readF);
        const frac         = readF - ri0;
        const idx0         = ((ri0 % cLen) + cLen) % cLen;
        const idx1         = (idx0 + 1) % cLen;
        const chorusL      = this._chorusBufL[idx0] * (1 - frac) + this._chorusBufL[idx1] * frac;
        const chorusR      = this._chorusBufR[idx0] * (1 - frac) + this._chorusBufR[idx1] * frac;
        oL = oL * (1 - p.chorusMix) + chorusL * p.chorusMix;
        oR = oR * (1 - p.chorusMix) + chorusR * p.chorusMix;
      }

      this._chorusWriteIdx = (this._chorusWriteIdx + 1) % cLen;

      // ── Reverb (4 parallel comb filters → 2 serial allpass filters) ───────
      if (p.reverbMix > 0) {
        const rvIn = (oL + oR) * 0.5; // mono feed into reverb
        let rvL = 0;
        let rvR = 0;

        for (let ci = 0; ci < 4; ci++) {
          const cOutL = this._combBufL[ci][this._combIdxL[ci]];
          this._combFeedZL[ci] =
            cOutL * (1.0 - combDamp) + this._combFeedZL[ci] * combDamp;
          this._combBufL[ci][this._combIdxL[ci]] =
            rvIn + this._combFeedZL[ci] * combFeedback;
          this._combIdxL[ci] = (this._combIdxL[ci] + 1) % this._combBufL[ci].length;
          rvL += cOutL;

          const cOutR = this._combBufR[ci][this._combIdxR[ci]];
          this._combFeedZR[ci] =
            cOutR * (1.0 - combDamp) + this._combFeedZR[ci] * combDamp;
          this._combBufR[ci][this._combIdxR[ci]] =
            rvIn + this._combFeedZR[ci] * combFeedback;
          this._combIdxR[ci] = (this._combIdxR[ci] + 1) % this._combBufR[ci].length;
          rvR += cOutR;
        }

        for (let ai = 0; ai < 2; ai++) {
          const apBL  = this._apBufL[ai][this._apIdxL[ai]];
          const apNL  = -rvL + apBL;
          this._apBufL[ai][this._apIdxL[ai]] = rvL + apBL * 0.5;
          this._apIdxL[ai] = (this._apIdxL[ai] + 1) % this._apBufL[ai].length;
          rvL = apNL;

          const apBR  = this._apBufR[ai][this._apIdxR[ai]];
          const apNR  = -rvR + apBR;
          this._apBufR[ai][this._apIdxR[ai]] = rvR + apBR * 0.5;
          this._apIdxR[ai] = (this._apIdxR[ai] + 1) % this._apBufR[ai].length;
          rvR = apNR;
        }

        // Mix wet (normalised by comb count) with dry
        const rvScale = p.reverbMix * 0.25;
        const dryScale = 1.0 - p.reverbMix;
        oL = oL * dryScale + rvL * rvScale;
        oR = oR * dryScale + rvR * rvScale;
      }

      // ── Master Pan (equal-power, unity at centre) ─────────────────────────
      outL[i] = oL * masterGainL;
      outR[i] = oR * masterGainR;
    }

    return true;
  }
}

registerProcessor("perceptual-bloom-processor", PerceptualBloomProcessor);
