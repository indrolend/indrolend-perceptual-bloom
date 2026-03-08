# Perceptual Bloom

A web-first audio DSP demo built with **Vite + TypeScript** and the **Web Audio API**.

Upload an audio file, hit Play, and hear the **Perceptual Bloom** stereo effect:

| Control | What it does |
|---|---|
| **Punch** | Narrows the stereo field during transients, keeping the initial hit mono-stable and tight. |
| **Bloom** | Widens the high-frequency part of the tail so the sustain blooms wider while the attack stays centred. |
| **Bass Mono Hz** | Keeps everything below this frequency mono (prevents bass "leakage" from the widening). |
| **Tail Pan** | Biases the bloomed tail left or right — makes the reverb tail feel longer on one side without moving the dry hit. |
| **Tail Skew** | Controls how much asymmetry is applied (depth of the Tail Pan effect). |
| **Output Trim** | Final linear gain in dB. |
| **A/B Bypass** | Routes dry signal around the worklet for a clean A/B comparison. |

---

## Local development

**Requirements:** Node ≥ 18, pnpm ≥ 8

```bash
# 1. Install dependencies (from repo root)
pnpm install

# 2. Start the dev server
pnpm dev
# → http://localhost:5173
```

Open a browser tab at `http://localhost:5173`.  
Chrome / Edge are recommended (best AudioWorklet support).

### Building for production

```bash
pnpm build
# Output: apps/web/dist/
```

Preview the production build locally:

```bash
pnpm -C apps/web preview
```

---

## AudioWorklet loading

The AudioWorklet processor (`apps/web/src/audio/worklet/processor.ts`) is loaded using Vite's **`?worker&url`** import query:

```typescript
import workletUrl from "./processor.ts?worker&url";
await ctx.audioWorklet.addModule(workletUrl);
```

This forces Vite to compile the TypeScript file to JavaScript at build time and emit it as a dedicated asset.  The alternative (`?raw` + Blob URL) passes the raw TypeScript source to `addModule()`, which makes the browser throw *"Unexpected token 'const'"* on Cloudflare Pages and any CDN that serves the raw file without a TypeScript-aware build step.

---

## Cloudflare Pages deployment

1. Push this repository to GitHub (or fork it).
2. In the [Cloudflare Dashboard](https://dash.cloudflare.com/), create a new **Pages** project connected to your repository.
3. Set the following build settings:

| Setting | Value |
|---|---|
| **Build command** | `pnpm install --frozen-lockfile && pnpm -C apps/web build` |
| **Build output directory** | `apps/web/dist` |
| **Node.js version** | `18` (or higher) |

4. Deploy — Cloudflare Pages will run the build command and serve `apps/web/dist`.

No server-side components are required; the entire DSP runs in the browser.

---

## Repository structure

```
perceptual-bloom/
├── pnpm-workspace.yaml
├── package.json                   # workspace root scripts
│
├── packages/
│   └── dsp-core/                  # Platform-agnostic DSP library
│       └── src/
│           ├── index.ts           # Public API re-exports
│           ├── ms.ts              # Mid/Side encode + decode
│           └── perceptualBloom.ts # Core algorithm (BloomState, processSample)
│
└── apps/
    └── web/                       # Vite + TypeScript web app
        ├── index.html
        ├── vite.config.ts
        └── src/
            ├── main.ts            # Application entry point / UI wiring
            ├── style.css
            ├── audio/
            │   ├── createEngine.ts        # Web Audio graph construction
            │   └── worklet/
            │       ├── processor.ts       # AudioWorkletProcessor (DSP inline)
            │       └── register.ts        # audioWorklet.addModule() helper
            └── ui/
                └── controls.ts    # Slider rows, presets
```

---

## Roadmap to VST3 (JUCE)

The `packages/dsp-core` directory is intentionally written as a **platform-agnostic** DSP reference that maps almost 1-to-1 to a C++/JUCE implementation.

### Mapping

| TypeScript (dsp-core) | C++ / JUCE equivalent |
|---|---|
| `BloomParams` struct | Private member struct in `PerceptualBloomAudioProcessor` |
| `BloomState` struct | Private member variables in the processor class |
| `createState()` | `PerceptualBloomAudioProcessor` constructor / `prepareToPlay()` |
| `processSample(L, R, state, params)` | Inner loop body inside `processBlock()` |
| `encode()` / `decode()` in `ms.ts` | Inline `msEncode` / `msDecode` functions |
| One-pole IIR lowpass (`lpCoeff`) | `juce::dsp::FirstOrderTPTFilter` or manual `z1` state |
| Envelope follower | Manual `z` state; or `juce::dsp::BallisticsFilter` |

### Steps to port

1. **Create a JUCE audio plugin project** (Audio Plugin type, VST3 + AU).
2. **Copy the algorithm** from `perceptualBloom.ts` into `PluginProcessor.cpp`:
   - Translate `BloomState` to member variables.
   - Translate `processSample` into the inner `processBlock` loop.
   - All math is standard C++; no JUCE-specific calls needed for the core.
3. **Add APVTS parameters** matching `BloomParams` (Punch, Bloom, BassMonoHz, TailPan, TailSkew, OutputTrimDb).
4. **Wire parameters** in `processBlock` by reading from `APVTS::getRawParameterValue`.
5. **Build and test** with the JUCE AudioPluginHost or FL Studio.

The coefficient helpers (`timeConstCoeff`, `lpCoeff`, `dbToLinear`) translate verbatim to C++ — they use only `std::exp`, `std::pow`, and `M_PI`.
