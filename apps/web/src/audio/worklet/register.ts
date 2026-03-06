/**
 * Register the Perceptual Bloom AudioWorklet module with an AudioContext.
 *
 * Uses Vite's `?raw` import to inline the worklet source as a string, then
 * wraps it in a Blob URL so the browser always receives the correct
 * `application/javascript` MIME type — regardless of build tooling or
 * Cloudflare Pages CDN configuration.
 */

// Vite transforms `?raw` imports to the transpiled JS source string at
// build time, so this works correctly in both dev and production.
import processorSrc from "./processor.ts?raw";

export async function registerWorklet(ctx: AudioContext): Promise<void> {
  const blob = new Blob([processorSrc], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
