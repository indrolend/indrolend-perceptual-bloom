/**
 * createEngine — constructs the Web Audio processing graph.
 *
 * Graph topology:
 *
 *   BufferSourceNode ──► (gain node for mix) ──► AudioWorkletNode ──► destination
 *                   └──────────────────────────────────────────────► (bypass path)
 *
 * A/B bypass is implemented by sending a "bypass" message to the worklet
 * rather than rewiring the graph, which avoids audio glitches.
 */

import { registerWorklet } from "./worklet/register.js";
import type { BloomParams } from "@perceptual-bloom/dsp-core";

// Parameters exposed to the UI (excludes sampleRate which is set internally).
export type EngineParams = Omit<BloomParams, "sampleRate">;

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
  /** Return the underlying AudioContext (for future metering etc.). */
  readonly context: AudioContext;
}

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
  let currentParams: EngineParams = {
    punch: 0.7,
    bloom: 0.6,
    bassMonoHz: 200,
    tailPan: 0.0,
    tailSkew: 0.3,
    outputTrimDb: 0.0,
  };

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
  };
}
