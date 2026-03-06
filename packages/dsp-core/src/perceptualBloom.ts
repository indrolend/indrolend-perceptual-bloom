/**
 * Perceptual Bloom — core DSP algorithm.
 *
 * Designed to be platform-agnostic so it can be ported to C++/JUCE later.
 * All state lives in the `BloomState` struct; there are no global variables.
 *
 * Algorithm overview (per stereo sample):
 *  1. M/S encode input.
 *  2. Track signal envelope (fast attack, slow release).
 *  3. Derive transientMask (high envelope delta → near 1) and
 *     sustainMask (low envelope delta, sustained energy → near 1).
 *  4. Narrow the Side channel during transients  (keeps the "punch" centred).
 *  5. Widen the high-frequency part of Side during the sustained tail
 *     (the "bloom").  Bass stays mono via a one-pole lowpass on Side.
 *  6. Apply asymmetric tail pan/skew only to the bloom component so
 *     the original hit stays centred.
 *  7. Reconstruct L/R and apply output trim.
 *
 * JUCE porting notes:
 *  - Replace `BloomState` with a private member struct in your DSP class.
 *  - `createState` → constructor / prepareToPlay.
 *  - `processSample` → your inner per-sample loop body.
 *  - AudioParams map directly to `BloomParams` fields.
 */

import { encode, decode } from "./ms.js";

// ---------------------------------------------------------------------------
// Parameter structure
// ---------------------------------------------------------------------------

/**
 * All user-controllable parameters for the Bloom algorithm.
 * Values are in the natural units described in each field comment.
 */
export interface BloomParams {
  /** Transient narrowing amount: 0 = no narrowing, 1 = fully mono during hit. */
  punch: number;
  /** Sustain widening amount: 0 = no bloom, 1 = max width on tail. */
  bloom: number;
  /** Frequency below which the Side signal is kept mono (Hz). */
  bassMonoHz: number;
  /** Tail pan: –1 = tail biased left, 0 = centre, +1 = biased right. */
  tailPan: number;
  /** Tail skew depth: 0 = symmetric tail, 1 = full L/R asymmetry applied. */
  tailSkew: number;
  /** Output gain in dB (-24 … +12 typical). */
  outputTrimDb: number;
  /** Sample rate in Hz (must match the audio context). */
  sampleRate: number;
}

// ---------------------------------------------------------------------------
// Internal state  (maps to a C++ private struct / member variables)
// ---------------------------------------------------------------------------

export interface BloomState {
  /** Current envelope follower value. */
  envelope: number;
  /** Previous envelope value, used to compute delta for transient detection. */
  prevEnvelope: number;
  /** One-pole lowpass state for the bass-mono splitter on the Side channel. */
  bassLowpassZ: number;
  /** Cached attack coefficient (recomputed when sampleRate or params change). */
  attackCoeff: number;
  /** Cached release coefficient. */
  releaseCoeff: number;
  /** Cached bass-lowpass coefficient. */
  bassCoeff: number;
  /** Snapshot of last applied params (to detect coefficient-dirty state). */
  lastParams: BloomParams | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a freshly initialised BloomState. */
export function createState(): BloomState {
  return {
    envelope: 0,
    prevEnvelope: 0,
    bassLowpassZ: 0,
    attackCoeff: 0,
    releaseCoeff: 0,
    bassCoeff: 0,
    lastParams: null,
  };
}

// ---------------------------------------------------------------------------
// Coefficient helpers
// ---------------------------------------------------------------------------

/**
 * One-pole IIR coefficient for a given time constant and sample rate.
 * coeff = exp(-1 / (timeMs * 0.001 * sampleRate))
 */
function timeConstCoeff(timeMs: number, sampleRate: number): number {
  return Math.exp(-1.0 / (timeMs * 0.001 * sampleRate));
}

/**
 * One-pole lowpass coefficient from a cutoff frequency.
 * Uses the bilinear-ish approximation: coeff = exp(-2π·fc/fs).
 */
function lpCoeff(cutoffHz: number, sampleRate: number): number {
  return Math.exp((-2.0 * Math.PI * cutoffHz) / sampleRate);
}

/** Convert dB to linear gain. */
function dbToLinear(db: number): number {
  return Math.pow(10.0, db / 20.0);
}

/** Update cached coefficients when params change. */
function updateCoeffs(state: BloomState, params: BloomParams): void {
  state.attackCoeff = timeConstCoeff(2, params.sampleRate);   // ~2 ms attack
  state.releaseCoeff = timeConstCoeff(80, params.sampleRate); // ~80 ms release
  state.bassCoeff = lpCoeff(params.bassMonoHz, params.sampleRate);
  state.lastParams = { ...params };
}

// ---------------------------------------------------------------------------
// Per-sample processing
// ---------------------------------------------------------------------------

/**
 * Process a single stereo sample through the Bloom algorithm.
 *
 * @param L     Left input sample (–1…+1 range assumed).
 * @param R     Right input sample.
 * @param state Mutable algorithm state (updated in place).
 * @param params Current parameter values.
 * @returns     { L, R } processed stereo output sample.
 *
 * JUCE port: this becomes the inner loop body inside processBlock().
 */
export function processSample(
  L: number,
  R: number,
  state: BloomState,
  params: BloomParams
): { L: number; R: number } {
  // ------------------------------------------------------------------
  // 1. Refresh coefficients if params changed
  // ------------------------------------------------------------------
  if (
    state.lastParams === null ||
    state.lastParams.sampleRate !== params.sampleRate ||
    state.lastParams.bassMonoHz !== params.bassMonoHz
  ) {
    updateCoeffs(state, params);
  }

  // ------------------------------------------------------------------
  // 2. M/S encode
  // ------------------------------------------------------------------
  const { mid, side } = encode(L, R);

  // ------------------------------------------------------------------
  // 3. Envelope follower on the mid channel (mono power proxy)
  //    Classic peak follower: fast attack, slow release.
  // ------------------------------------------------------------------
  const absIn = Math.abs(mid);
  if (absIn > state.envelope) {
    state.envelope = state.attackCoeff * state.envelope + (1 - state.attackCoeff) * absIn;
  } else {
    state.envelope = state.releaseCoeff * state.envelope + (1 - state.releaseCoeff) * absIn;
  }

  // ------------------------------------------------------------------
  // 4. Transient / sustain masks
  //    transientMask rises when the envelope is growing fast (a hit).
  //    sustainMask is the complement: prominent during the tail.
  // ------------------------------------------------------------------
  const envDelta = Math.max(0, state.envelope - state.prevEnvelope);
  state.prevEnvelope = state.envelope;

  // Normalise delta to [0,1].  The 0.5 divisor is empirical — adjust to taste.
  const transientMask = Math.min(1.0, envDelta / (state.envelope + 1e-9) * 8.0);
  const sustainMask = 1.0 - transientMask;

  // ------------------------------------------------------------------
  // 5. Bass/treble split on Side channel (one-pole IIR lowpass)
  //    lowSide  → stays mono (discarded from widening path)
  //    hiSide   → candidate for widening
  // ------------------------------------------------------------------
  // One-pole lowpass:  y[n] = coeff * y[n-1] + (1 - coeff) * x[n]
  state.bassLowpassZ = state.bassCoeff * state.bassLowpassZ + (1 - state.bassCoeff) * side;
  const lowSide = state.bassLowpassZ;
  const hiSide = side - lowSide;

  // ------------------------------------------------------------------
  // 6. Width shaping
  //    baseSide  = narrowed during transient (punch), full during tail.
  //    wideSide  = hiSide further widened by bloom amount.
  //    tailSide  = the "extra" width contributed by bloom only.
  // ------------------------------------------------------------------
  //  Narrowing: scale side by (1 - punch * transientMask).
  const punchGain = 1.0 - params.punch * transientMask;
  const baseSide = lowSide + hiSide * punchGain;

  //  Widening: scale hiSide up by bloom * sustainMask.
  const bloomGain = 1.0 + params.bloom * sustainMask;
  const wideSide = lowSide + hiSide * bloomGain;

  //  The tail bloom delta (only the extra component):
  let tailSide = wideSide - baseSide;  // = hiSide * (bloomGain - punchGain)

  // ------------------------------------------------------------------
  // 7. Tail asymmetry (Tail Pan + Tail Skew)
  //    We decompose tailSide into L and R contributions and scale them
  //    differently so the tail feels longer on one side.
  //
  //    tailSide encodes as:  L_contribution =  tailSide
  //                          R_contribution = -tailSide
  //    Pan > 0 → boost L, attenuate R (tail biased left in the mix).
  //    Pan < 0 → boost R, attenuate L.
  //    Skew controls depth: 0 = symmetric, 1 = full asymmetry.
  // ------------------------------------------------------------------
  const skewDepth = params.tailSkew * sustainMask;
  const panL = 1.0 + params.tailPan * skewDepth;   // scale for L side contribution
  const panR = 1.0 - params.tailPan * skewDepth;   // scale for R side contribution

  // Reconstruct asymmetric tail as a modified side value (average of L/R contributions).
  // scaledTailL =  tailSide * panL   (adds to L = mid + side)
  // scaledTailR = -tailSide * panR   (adds to R = mid - side  → sign flips)
  // Encode back: side_contribution = (scaledTailL - (-scaledTailR)) * 0.5
  //            = tailSide * (panL + panR) * 0.5
  // Mid contribution of asymmetry: (scaledTailL + scaledTailR) * 0.5
  //            = tailSide * (panL - panR) * 0.5
  const asymMidContrib = tailSide * (panL - panR) * 0.5;
  const asymSideContrib = tailSide * (panL + panR) * 0.5;

  const finalMid = mid + asymMidContrib;
  const finalSide = baseSide + asymSideContrib;

  // ------------------------------------------------------------------
  // 8. M/S decode + output trim
  // ------------------------------------------------------------------
  const trimGain = dbToLinear(params.outputTrimDb);
  const { L: outL, R: outR } = decode(finalMid, finalSide);

  return {
    L: outL * trimGain,
    R: outR * trimGain,
  };
}
