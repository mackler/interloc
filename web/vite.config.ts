// The browser build of the web GUI and its component tests. Every path is relative to `root`, this directory:
// `npm run build` writes web/dist (the server refuses to start without web/dist/index.html).
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { functionsMixins } from "vite-plugin-functions-mixins";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // m3-svelte writes its styles with CSS @function and @mixin, which this plugin resolves at build time.
  plugins: [svelte(), functionsMixins({ deps: ["m3-svelte"] })],
  build: { outDir: "dist", emptyOutDir: true },
});
