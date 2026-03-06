/**
 * @perceptual-bloom/dsp-core
 *
 * Public API surface.  Import this package from both the web AudioWorklet
 * and (in the future) from a Node.js / WebAssembly test harness.
 */

export { encode, decode } from "./ms.js";
export {
  createState,
  processSample,
  type BloomParams,
  type BloomState,
} from "./perceptualBloom.js";
