/**
 * UI controls — build slider rows and preset buttons.
 *
 * Each control row consists of:
 *   - A label (with optional hint)
 *   - A range input
 *   - A numeric readout
 *
 * The `onChange` callback fires with the new numeric value whenever the
 * slider is moved.
 */

export interface ControlDef {
  id: string;
  label: string;
  hint?: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  /** Format the value for display (e.g. "0.70", "+3.0 dB"). */
  format?: (v: number) => string;
}

export interface ControlHandle {
  getValue(): number;
  setValue(v: number): void;
}

/**
 * Append a slider control row to `container`.
 * Returns a handle for programmatic get/set.
 */
export function addControl(
  container: HTMLElement,
  def: ControlDef,
  onChange: (value: number) => void
): ControlHandle {
  const row = document.createElement("div");
  row.className = "control-row";

  const labelEl = document.createElement("label");
  labelEl.htmlFor = def.id;
  labelEl.innerHTML = def.label;
  if (def.hint) {
    const hint = document.createElement("span");
    hint.className = "param-hint";
    hint.textContent = def.hint;
    labelEl.appendChild(hint);
  }

  const slider = document.createElement("input");
  slider.type = "range";
  slider.id = def.id;
  slider.min = String(def.min);
  slider.max = String(def.max);
  slider.step = String(def.step);
  slider.value = String(def.defaultValue);

  const fmt = def.format ?? ((v) => v.toFixed(2));
  const valueEl = document.createElement("span");
  valueEl.className = "control-value";
  valueEl.textContent = fmt(def.defaultValue);

  slider.addEventListener("input", () => {
    const v = parseFloat(slider.value);
    valueEl.textContent = fmt(v);
    onChange(v);
  });

  row.appendChild(labelEl);
  row.appendChild(slider);
  row.appendChild(valueEl);
  container.appendChild(row);

  return {
    getValue: () => parseFloat(slider.value),
    setValue: (v: number) => {
      slider.value = String(v);
      valueEl.textContent = fmt(v);
    },
  };
}

// ---------------------------------------------------------------------------
// Control definitions — Bloom parameters
// ---------------------------------------------------------------------------

export const BLOOM_DEFS: ControlDef[] = [
  {
    id: "punch",
    label: "Punch",
    hint: "Transient narrowing (0 = off, 1 = mono on hit)",
    min: 0, max: 1, step: 0.01, defaultValue: 0.7,
    format: (v) => v.toFixed(2),
  },
  {
    id: "bloom",
    label: "Bloom",
    hint: "Sustain widening (0 = off, 1 = max width on tail)",
    min: 0, max: 1, step: 0.01, defaultValue: 0.6,
    format: (v) => v.toFixed(2),
  },
  {
    id: "bassMonoHz",
    label: "Bass Mono Hz",
    hint: "Keep bass below this freq mono",
    min: 20, max: 500, step: 1, defaultValue: 200,
    format: (v) => `${Math.round(v)} Hz`,
  },
  {
    id: "tailPan",
    label: "Tail Pan",
    hint: "Pan the bloom tail (−1 left … +1 right)",
    min: -1, max: 1, step: 0.01, defaultValue: 0,
    format: (v) => (v >= 0 ? "+" : "") + v.toFixed(2),
  },
  {
    id: "tailSkew",
    label: "Tail Skew",
    hint: "Asymmetry depth (0 = symmetric, 1 = full skew)",
    min: 0, max: 1, step: 0.01, defaultValue: 0.3,
    format: (v) => v.toFixed(2),
  },
  {
    id: "outputTrimDb",
    label: "Output Trim",
    hint: "Bloom output gain (applied before effects chain)",
    min: -24, max: 12, step: 0.1, defaultValue: 0,
    format: (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + " dB",
  },
];

// Keep the legacy export name so any future code that uses CONTROL_DEFS still works.
export const CONTROL_DEFS = BLOOM_DEFS;

// ---------------------------------------------------------------------------
// Control definitions — Compressor
// ---------------------------------------------------------------------------

export const COMPRESSOR_DEFS: ControlDef[] = [
  {
    id: "compThreshDb",
    label: "Threshold",
    hint: "Signal above this level gets compressed",
    min: -60, max: 0, step: 1, defaultValue: -20,
    format: (v) => v.toFixed(0) + " dBFS",
  },
  {
    id: "compRatio",
    label: "Ratio",
    hint: "1:1 = bypass, 4:1 = moderate, 20:1 = limiting",
    min: 1, max: 20, step: 0.5, defaultValue: 1,
    format: (v) => v.toFixed(1) + ":1",
  },
  {
    id: "compAttackMs",
    label: "Attack",
    hint: "Compressor attack time",
    min: 1, max: 100, step: 1, defaultValue: 10,
    format: (v) => v.toFixed(0) + " ms",
  },
  {
    id: "compReleaseMs",
    label: "Release",
    hint: "Compressor release time",
    min: 10, max: 500, step: 5, defaultValue: 100,
    format: (v) => v.toFixed(0) + " ms",
  },
  {
    id: "compMakeupDb",
    label: "Makeup Gain",
    hint: "Gain applied after compression",
    min: -6, max: 18, step: 0.1, defaultValue: 0,
    format: (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + " dB",
  },
];

// ---------------------------------------------------------------------------
// Control definitions — Echo / Delay
// ---------------------------------------------------------------------------

export const ECHO_DEFS: ControlDef[] = [
  {
    id: "echoDelayMs",
    label: "Delay Time",
    hint: "Time between echo repeats",
    min: 10, max: 1500, step: 10, defaultValue: 300,
    format: (v) => v.toFixed(0) + " ms",
  },
  {
    id: "echoRepeats",
    label: "Repeats",
    hint: "0 = single echo, 8 = long tail",
    min: 0, max: 8, step: 1, defaultValue: 3,
    format: (v) => {
      const n = Math.round(v);
      return n === 0 ? "single" : String(n);
    },
  },
  {
    id: "echoMix",
    label: "Echo Mix",
    hint: "Echo level added on top of dry signal (0 = off)",
    min: 0, max: 1, step: 0.01, defaultValue: 0,
    format: (v) => Math.round(v * 100) + "%",
  },
];

// ---------------------------------------------------------------------------
// Control definitions — Chorus
// ---------------------------------------------------------------------------

export const CHORUS_DEFS: ControlDef[] = [
  {
    id: "chorusRate",
    label: "Rate",
    hint: "LFO modulation speed",
    min: 0.1, max: 5, step: 0.1, defaultValue: 0.5,
    format: (v) => v.toFixed(1) + " Hz",
  },
  {
    id: "chorusDepth",
    label: "Depth",
    hint: "Center delay time (modulation range)",
    min: 1, max: 20, step: 0.5, defaultValue: 7,
    format: (v) => v.toFixed(1) + " ms",
  },
  {
    id: "chorusMix",
    label: "Chorus Mix",
    hint: "Wet/dry blend (0 = off)",
    min: 0, max: 1, step: 0.01, defaultValue: 0,
    format: (v) => Math.round(v * 100) + "%",
  },
];

// ---------------------------------------------------------------------------
// Control definitions — Sample-Rate Degradation
// ---------------------------------------------------------------------------

export const SRATE_DEFS: ControlDef[] = [
  {
    id: "srateDivide",
    label: "Divide",
    hint: "1 = off, 2 = half-rate lo-fi, 16 = very degraded",
    min: 1, max: 16, step: 1, defaultValue: 1,
    format: (v) => {
      const n = Math.round(v);
      return n === 1 ? "÷1 (off)" : "÷" + n;
    },
  },
];

// ---------------------------------------------------------------------------
// Control definitions — Reverb
// ---------------------------------------------------------------------------

export const REVERB_DEFS: ControlDef[] = [
  {
    id: "reverbSize",
    label: "Room Size",
    hint: "Comb-filter feedback: 0 = small room, 1 = huge space",
    min: 0, max: 1, step: 0.01, defaultValue: 0.6,
    format: (v) => v.toFixed(2),
  },
  {
    id: "reverbDamp",
    label: "Damping",
    hint: "High-frequency absorption (0 = bright, 1 = dark)",
    min: 0, max: 1, step: 0.01, defaultValue: 0.5,
    format: (v) => v.toFixed(2),
  },
  {
    id: "reverbMix",
    label: "Reverb Mix",
    hint: "Wet/dry blend (0 = off)",
    min: 0, max: 1, step: 0.01, defaultValue: 0,
    format: (v) => Math.round(v * 100) + "%",
  },
];

// ---------------------------------------------------------------------------
// Control definitions — Master
// ---------------------------------------------------------------------------

export const MASTER_DEFS: ControlDef[] = [
  {
    id: "masterPan",
    label: "Master Pan",
    hint: "Post-effects stereo pan (−1 L … 0 C … +1 R)",
    min: -1, max: 1, step: 0.01, defaultValue: 0,
    format: (v) => {
      if (Math.abs(v) < 0.01) return "C";
      const side = v < 0 ? "L" : "R";
      return side + " " + Math.round(Math.abs(v) * 100) + "%";
    },
  },
];

// ---------------------------------------------------------------------------
// Preset definitions
// ---------------------------------------------------------------------------

export interface Preset {
  name: string;
  values: Record<string, number>;
}

export const PRESETS: Preset[] = [
  {
    name: "Default",
    values: {
      punch: 0.7, bloom: 0.6, bassMonoHz: 200, tailPan: 0, tailSkew: 0.3,
      outputTrimDb: 0, compThreshDb: -20, compRatio: 1, compAttackMs: 10,
      compReleaseMs: 100, compMakeupDb: 0, echoDelayMs: 300, echoRepeats: 3,
      echoMix: 0, chorusRate: 0.5, chorusDepth: 7, chorusMix: 0,
      srateDivide: 1, reverbSize: 0.6, reverbDamp: 0.5, reverbMix: 0,
      masterPan: 0,
    },
  },
  {
    name: "Wide Room",
    values: {
      punch: 0.5, bloom: 0.9, bassMonoHz: 150, tailPan: 0, tailSkew: 0.5,
      outputTrimDb: -1.5, compThreshDb: -18, compRatio: 2, compAttackMs: 15,
      compReleaseMs: 150, compMakeupDb: 2, echoDelayMs: 400, echoRepeats: 2,
      echoMix: 0.2, chorusRate: 0.4, chorusDepth: 10, chorusMix: 0.25,
      srateDivide: 1, reverbSize: 0.8, reverbDamp: 0.4, reverbMix: 0.35,
      masterPan: 0,
    },
  },
  {
    name: "Snappy",
    values: {
      punch: 1.0, bloom: 0.4, bassMonoHz: 250, tailPan: 0, tailSkew: 0.2,
      outputTrimDb: 0, compThreshDb: -12, compRatio: 4, compAttackMs: 5,
      compReleaseMs: 80, compMakeupDb: 3, echoDelayMs: 180, echoRepeats: 1,
      echoMix: 0.15, chorusRate: 0, chorusDepth: 5, chorusMix: 0,
      srateDivide: 1, reverbSize: 0.3, reverbDamp: 0.6, reverbMix: 0.1,
      masterPan: 0,
    },
  },
  {
    name: "Left Drift",
    values: {
      punch: 0.6, bloom: 0.7, bassMonoHz: 180, tailPan: -0.6, tailSkew: 0.8,
      outputTrimDb: 0, compThreshDb: -20, compRatio: 1, compAttackMs: 10,
      compReleaseMs: 100, compMakeupDb: 0, echoDelayMs: 500, echoRepeats: 4,
      echoMix: 0.3, chorusRate: 0.3, chorusDepth: 8, chorusMix: 0.2,
      srateDivide: 1, reverbSize: 0.65, reverbDamp: 0.5, reverbMix: 0.25,
      masterPan: -0.2,
    },
  },
  {
    name: "Lo-Fi Tape",
    values: {
      punch: 0.4, bloom: 0.5, bassMonoHz: 300, tailPan: 0, tailSkew: 0.1,
      outputTrimDb: -2, compThreshDb: -15, compRatio: 3, compAttackMs: 20,
      compReleaseMs: 200, compMakeupDb: 1.5, echoDelayMs: 250, echoRepeats: 2,
      echoMix: 0.2, chorusRate: 1.2, chorusDepth: 5, chorusMix: 0.3,
      srateDivide: 4, reverbSize: 0.4, reverbDamp: 0.7, reverbMix: 0.2,
      masterPan: 0,
    },
  },
];

