/**
 * main.ts — application entry point.
 *
 * Wires together the UI controls, file loading, transport, and the
 * Web Audio engine.  The engine is created lazily on the first user
 * gesture to comply with browser autoplay policies.
 */

import "./style.css";
import { createEngine, type BloomEngine } from "./audio/createEngine.js";
import {
  addControl,
  CONTROL_DEFS,
  PRESETS,
  type ControlHandle,
} from "./ui/controls.js";

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const fileNameEl = document.getElementById("file-name") as HTMLParagraphElement;
const btnPlay = document.getElementById("btn-play") as HTMLButtonElement;
const btnStop = document.getElementById("btn-stop") as HTMLButtonElement;
const chkLoop = document.getElementById("chk-loop") as HTMLInputElement;
const chkBypass = document.getElementById("chk-bypass") as HTMLInputElement;
const controlsContainer = document.getElementById("controls-container") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let engine: BloomEngine | null = null;
let isPlaying = false;

function setStatus(msg: string, isError = false): void {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

// ---------------------------------------------------------------------------
// Engine init (lazy — first user gesture)
// ---------------------------------------------------------------------------
async function getEngine(): Promise<BloomEngine> {
  if (engine) return engine;
  setStatus("Initialising audio engine…");
  try {
    engine = await createEngine();
    setStatus("Engine ready.");
    return engine;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(`Engine error: ${msg}`, true);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Build controls
// ---------------------------------------------------------------------------
const controlHandles: Map<string, ControlHandle> = new Map();

for (const def of CONTROL_DEFS) {
  const handle = addControl(controlsContainer, def, (value) => {
    engine?.setParams({ [def.id]: value } as never);
  });
  controlHandles.set(def.id, handle);
}

// Preset buttons row
const presetRow = document.createElement("div");
presetRow.style.cssText =
  "display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;padding-top:12px;border-top:1px solid var(--border)";

for (const preset of PRESETS) {
  const btn = document.createElement("button");
  btn.textContent = preset.name;
  btn.style.fontSize = "12px";
  btn.style.padding = "5px 12px";
  btn.addEventListener("click", () => applyPreset(preset.values));
  presetRow.appendChild(btn);
}
controlsContainer.appendChild(presetRow);

function applyPreset(values: Record<string, number>): void {
  for (const [id, value] of Object.entries(values)) {
    const handle = controlHandles.get(id);
    handle?.setValue(value);
  }
  engine?.setParams(values as never);
}

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  fileNameEl.textContent = file.name;
  setStatus("Loading file…");

  try {
    const eng = await getEngine();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await eng.context.decodeAudioData(arrayBuffer);
    eng.loadBuffer(audioBuffer);

    btnPlay.disabled = false;
    btnStop.disabled = false;
    setStatus(`Loaded "${file.name}" (${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.numberOfChannels}ch, ${audioBuffer.sampleRate}Hz)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(`Failed to load file: ${msg}`, true);
  }
});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
btnPlay.addEventListener("click", async () => {
  try {
    const eng = await getEngine();

    if (eng.context.state === "suspended") {
      await eng.context.resume();
    }

    if (isPlaying) {
      eng.stop();
    }
    eng.play(chkLoop.checked);
    isPlaying = true;
    btnPlay.textContent = "▶ Restart";
    setStatus("Playing…");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(`Playback error: ${msg}`, true);
  }
});

btnStop.addEventListener("click", () => {
  engine?.stop();
  isPlaying = false;
  btnPlay.textContent = "▶ Play";
  setStatus("Stopped.");
});

// ---------------------------------------------------------------------------
// A/B Bypass
// ---------------------------------------------------------------------------
chkBypass.addEventListener("change", () => {
  const bypass = chkBypass.checked;
  engine?.setBypass(bypass);
  setStatus(bypass ? "Bypass ON (dry signal)" : "Bypass OFF (effect active)");
});
