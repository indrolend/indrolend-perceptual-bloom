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
// Control definitions for all Bloom parameters
// ---------------------------------------------------------------------------

export const CONTROL_DEFS: ControlDef[] = [
  {
    id: "punch",
    label: "Punch",
    hint: "Transient narrowing (0 = off, 1 = mono on hit)",
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 0.7,
    format: (v) => v.toFixed(2),
  },
  {
    id: "bloom",
    label: "Bloom",
    hint: "Sustain widening (0 = off, 1 = max width on tail)",
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 0.6,
    format: (v) => v.toFixed(2),
  },
  {
    id: "bassMonoHz",
    label: "Bass Mono Hz",
    hint: "Keep bass below this freq mono",
    min: 20,
    max: 500,
    step: 1,
    defaultValue: 200,
    format: (v) => `${Math.round(v)} Hz`,
  },
  {
    id: "tailPan",
    label: "Tail Pan",
    hint: "Pan the bloom tail (−1 left … +1 right)",
    min: -1,
    max: 1,
    step: 0.01,
    defaultValue: 0,
    format: (v) => (v >= 0 ? "+" : "") + v.toFixed(2),
  },
  {
    id: "tailSkew",
    label: "Tail Skew",
    hint: "Asymmetry depth (0 = symmetric, 1 = full skew)",
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 0.3,
    format: (v) => v.toFixed(2),
  },
  {
    id: "outputTrimDb",
    label: "Output Trim",
    hint: "Output gain",
    min: -24,
    max: 12,
    step: 0.1,
    defaultValue: 0,
    format: (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + " dB",
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
      punch: 0.7,
      bloom: 0.6,
      bassMonoHz: 200,
      tailPan: 0,
      tailSkew: 0.3,
      outputTrimDb: 0,
    },
  },
  {
    name: "Wide Room",
    values: {
      punch: 0.5,
      bloom: 0.9,
      bassMonoHz: 150,
      tailPan: 0,
      tailSkew: 0.5,
      outputTrimDb: -1.5,
    },
  },
  {
    name: "Snappy",
    values: {
      punch: 1.0,
      bloom: 0.4,
      bassMonoHz: 250,
      tailPan: 0,
      tailSkew: 0.2,
      outputTrimDb: 0,
    },
  },
  {
    name: "Left Drift",
    values: {
      punch: 0.6,
      bloom: 0.7,
      bassMonoHz: 180,
      tailPan: -0.6,
      tailSkew: 0.8,
      outputTrimDb: 0,
    },
  },
];
