import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      // Allow apps/web to import dsp-core by package name during dev/build.
      "@perceptual-bloom/dsp-core": path.resolve(
        __dirname,
        "../../packages/dsp-core/src/index.ts"
      ),
    },
  },
  build: {
    outDir: "dist",
    // Inline worklet script as a URL so it survives bundling.
    rollupOptions: {
      output: {
        // Keep the worklet as a separate chunk so the browser can load it
        // via AudioWorklet.addModule().
        manualChunks: undefined,
      },
    },
  },
  // Vite needs to serve files with correct MIME for AudioWorklet.
  server: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
});
