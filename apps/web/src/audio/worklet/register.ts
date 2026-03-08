/**
 * Register the Perceptual Bloom AudioWorklet module with an AudioContext.
 *
 * Uses Vite's `?worker&url` query so the processor TypeScript is compiled to
 * JavaScript at build time and emitted as a dedicated asset.  The browser
 * therefore always receives valid JS — fixing the "Unexpected token 'const'"
 * error on Cloudflare Pages that occurred when the previous `?raw` Blob
 * technique served the raw TypeScript source text instead of compiled JS.
 *
 * In dev mode Vite's worker pipeline handles the TypeScript transform on the
 * fly; in production the compiled JS asset URL is baked in at build time.
 */

// `?worker&url` tells Vite to compile the TypeScript file as a worker bundle
// and return the URL of the resulting JS asset.
import workletUrl from "./processor.ts?worker&url";

export async function registerWorklet(ctx: AudioContext): Promise<void> {
  await ctx.audioWorklet.addModule(workletUrl);
}
