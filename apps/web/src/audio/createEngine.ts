/**
 * createEngine — constructs the Web Audio processing graph.
 *
 * Graph topology:
 *
 *   BufferSourceNode ──► AudioWorkletNode ──► destination
 *
 * The worklet processes: Bloom → Compressor → Sample-Rate Degrade
 *                        → Echo → Chorus → Reverb → Master Pan
 *
 * A/B bypass routes the dry signal through the worklet unchanged.
 * Export renders the same graph offline via OfflineAudioContext.
 */

import { registerWorklet } from "./worklet/register.js";
import type { BloomParams } from "@perceptual-bloom/dsp-core";

// All user-controllable parameters (core Bloom params + new effects).
export interface EngineParams extends Omit<BloomParams, "sampleRate"> {
  // ── Compressor ────────────────────────────────────────────────────────────
  compThreshDb: number;
  compRatio: number;
  compAttackMs: number;
  compReleaseMs: number;
  compMakeupDb: number;
  // ── Echo / Delay ──────────────────────────────────────────────────────────
  echoDelayMs: number;
  echoRepeats: number;
  echoMix: number;
  // ── Chorus ────────────────────────────────────────────────────────────────
  chorusRate: number;
  chorusDepth: number;
  chorusMix: number;
  // ── Sample-Rate Degradation ───────────────────────────────────────────────
  srateDivide: number;
  // ── Reverb ────────────────────────────────────────────────────────────────
  reverbSize: number;
  reverbDamp: number;
  reverbMix: number;
  // ── Master Pan ────────────────────────────────────────────────────────────
  masterPan: number;
}

export interface BloomEngine {
  /** Load an AudioBuffer and prepare it for playback. */
  loadBuffer(buffer: AudioBuffer): void;
  /** Start playback. */
  play(loop: boolean): void;
  /** Stop playback. */
  stop(): void;
  /** Update DSP parameters (partial update is fine). */
  setParams(params: Partial<EngineParams>): void;
  /** Enable / disable A/B bypass. */
  setBypass(bypass: boolean): void;
  /** Render the loaded buffer through all current effects and download as WAV. */
  exportAudio(): Promise<void>;
  /** Return the underlying AudioContext (for future metering etc.). */
  readonly context: AudioContext;
}

// ---------------------------------------------------------------------------
// WAV encoder (16-bit PCM)
// ---------------------------------------------------------------------------

function encodeWav(buffer: AudioBuffer): Blob {
  const numChannels   = buffer.numberOfChannels;
  const sr            = buffer.sampleRate;
  const numFrames     = buffer.length;
  const bytesPerSample = 2; // 16-bit
  const dataBytes     = numFrames * numChannels * bytesPerSample;
  const ab            = new ArrayBuffer(44 + dataBytes);
  const dv            = new DataView(ab);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) dv.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  dv.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  dv.setUint32(16, 16, true);                                  // PCM chunk size
  dv.setUint16(20, 1, true);                                   // format: PCM
  dv.setUint16(22, numChannels, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * numChannels * bytesPerSample, true);   // byte rate
  dv.setUint16(32, numChannels * bytesPerSample, true);        // block align
  dv.setUint16(34, 16, true);                                  // bits per sample
  writeStr(36, "data");
  dv.setUint32(40, dataBytes, true);

  let off = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      dv.setInt16(off, Math.round(s * 32767), true);
      off += 2;
    }
  }

  return new Blob([ab], { type: "audio/wav" });
}

// ---------------------------------------------------------------------------
// Engine factory
// ---------------------------------------------------------------------------

const DEFAULT_ENGINE_PARAMS: EngineParams = {
  // Bloom
  punch: 0.7,
  bloom: 0.6,
  bassMonoHz: 200,
  tailPan: 0.0,
  tailSkew: 0.3,
  outputTrimDb: 0.0,
  // Compressor
  compThreshDb: -20,
  compRatio: 1,
  compAttackMs: 10,
  compReleaseMs: 100,
  compMakeupDb: 0,
  // Echo
  echoDelayMs: 300,
  echoRepeats: 3,
  echoMix: 0,
  // Chorus
  chorusRate: 0.5,
  chorusDepth: 7,
  chorusMix: 0,
  // Sample-rate degradation
  srateDivide: 1,
  // Reverb
  reverbSize: 0.6,
  reverbDamp: 0.5,
  reverbMix: 0,
  // Master pan
  masterPan: 0,
};

/**
 * Build the audio graph and return a BloomEngine controller object.
 * Call this once on first user gesture (to satisfy browser autoplay policy).
 */
export async function createEngine(): Promise<BloomEngine> {
  const ctx = new AudioContext({ latencyHint: "interactive" });

  // Register the worklet processor module.
  await registerWorklet(ctx);

  // Create the AudioWorkletNode (stereo in/out).
  const workletNode = new AudioWorkletNode(ctx, "perceptual-bloom-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
  });

  // Connect worklet to destination.
  workletNode.connect(ctx.destination);

  // Current source node (replaced on each play() call).
  let currentSource: AudioBufferSourceNode | null = null;
  let loadedBuffer: AudioBuffer | null = null;

  // Current params (merged incrementally).
  let currentParams: EngineParams = { ...DEFAULT_ENGINE_PARAMS };

  function sendParams(patch: Partial<EngineParams>): void {
    currentParams = { ...currentParams, ...patch };
    workletNode.port.postMessage({
      type: "params",
      payload: currentParams,
    });
  }

  // Send initial params immediately.
  sendParams({});

  return {
    get context() {
      return ctx;
    },

    loadBuffer(buffer: AudioBuffer): void {
      loadedBuffer = buffer;
    },

    play(loop: boolean): void {
      if (!loadedBuffer) return;

      // Stop any existing source.
      if (currentSource) {
        try { currentSource.stop(); } catch (_) { /* already stopped */ }
        currentSource.disconnect();
        currentSource = null;
      }

      if (ctx.state === "suspended") {
        ctx.resume();
      }

      const source = ctx.createBufferSource();
      source.buffer = loadedBuffer;
      source.loop = loop;
      source.connect(workletNode);
      source.start();
      currentSource = source;
    },

    stop(): void {
      if (currentSource) {
        try { currentSource.stop(); } catch (_) { /* already stopped */ }
        currentSource.disconnect();
        currentSource = null;
      }
    },

    setParams(params: Partial<EngineParams>): void {
      sendParams(params);
    },

    setBypass(bypass: boolean): void {
      workletNode.port.postMessage({ type: "bypass", value: bypass });
    },

    async exportAudio(): Promise<void> {
      if (!loadedBuffer) return;

      // Add tail time so reverb/echo tails are captured in the export.
      const tailSeconds = 3;
      const offlineCtx  = new OfflineAudioContext(
        2,
        Math.ceil((loadedBuffer.duration + tailSeconds) * loadedBuffer.sampleRate),
        loadedBuffer.sampleRate,
      );

      await registerWorklet(offlineCtx);

      const offlineWorklet = new AudioWorkletNode(
        offlineCtx,
        "perceptual-bloom-processor",
        {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
          channelCountMode: "explicit",
          channelInterpretation: "speakers",
        },
      );

      offlineWorklet.port.postMessage({ type: "params", payload: currentParams });

      const source = offlineCtx.createBufferSource();
      source.buffer = loadedBuffer;
      source.connect(offlineWorklet);
      offlineWorklet.connect(offlineCtx.destination);
      source.start(0);

      const rendered = await offlineCtx.startRendering();
      const wav      = encodeWav(rendered);
      const url      = URL.createObjectURL(wav);
      const a        = document.createElement("a");
      a.href         = url;
      a.download     = "perceptual-bloom-export.wav";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
  };
}
