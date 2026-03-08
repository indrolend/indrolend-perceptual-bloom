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
  BLOOM_DEFS,
  COMPRESSOR_DEFS,
  ECHO_DEFS,
  CHORUS_DEFS,
  SRATE_DEFS,
  REVERB_DEFS,
  MASTER_DEFS,
  PRESETS,
  type ControlHandle,
} from "./ui/controls.js";

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const fileInput     = document.getElementById("file-input")     as HTMLInputElement;
const fileNameEl    = document.getElementById("file-name")      as HTMLParagraphElement;
const btnPlay       = document.getElementById("btn-play")       as HTMLButtonElement;
const btnStop       = document.getElementById("btn-stop")       as HTMLButtonElement;
const btnExport     = document.getElementById("btn-export")     as HTMLButtonElement;
const chkLoop       = document.getElementById("chk-loop")       as HTMLInputElement;
const chkBypass     = document.getElementById("chk-bypass")     as HTMLInputElement;
const statusEl      = document.getElementById("status")         as HTMLParagraphElement;

const bloomContainer      = document.getElementById("bloom-controls")      as HTMLDivElement;
const compressorContainer = document.getElementById("compressor-controls") as HTMLDivElement;
const echoContainer       = document.getElementById("echo-controls")       as HTMLDivElement;
const chorusContainer     = document.getElementById("chorus-controls")     as HTMLDivElement;
const srateContainer      = document.getElementById("srate-controls")      as HTMLDivElement;
const reverbContainer     = document.getElementById("reverb-controls")     as HTMLDivElement;
const masterContainer     = document.getElementById("master-controls")     as HTMLDivElement;

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
// Build controls — one section at a time
// ---------------------------------------------------------------------------
const controlHandles: Map<string, ControlHandle> = new Map();

function buildSection(
  container: HTMLElement,
  defs: typeof BLOOM_DEFS,
): void {
  for (const def of defs) {
    const handle = addControl(container, def, (value) => {
      engine?.setParams({ [def.id]: value } as never);
    });
    controlHandles.set(def.id, handle);
  }
}

buildSection(bloomContainer,      BLOOM_DEFS);
buildSection(compressorContainer,  COMPRESSOR_DEFS);
buildSection(echoContainer,        ECHO_DEFS);
buildSection(chorusContainer,      CHORUS_DEFS);
buildSection(srateContainer,       SRATE_DEFS);
buildSection(reverbContainer,      REVERB_DEFS);
buildSection(masterContainer,      MASTER_DEFS);

// Preset buttons — appended to the Bloom section
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
bloomContainer.appendChild(presetRow);

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

    btnPlay.disabled   = false;
    btnStop.disabled   = false;
    btnExport.disabled = false;
    setStatus(
      `Loaded "${file.name}" (${audioBuffer.duration.toFixed(2)}s, ` +
      `${audioBuffer.numberOfChannels}ch, ${audioBuffer.sampleRate}Hz)`,
    );
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

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
btnExport.addEventListener("click", async () => {
  if (!engine) return;
  btnExport.disabled = true;
  setStatus("Rendering export — please wait…");
  try {
    await engine.exportAudio();
    setStatus("Export complete — check your downloads.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(`Export error: ${msg}`, true);
  } finally {
    btnExport.disabled = false;
  }
});

