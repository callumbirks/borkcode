import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const serverPort = process.env.BORKCODE_SERVER_PORT ?? "4800";

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: Number(process.env.BORKCODE_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      // Keeps the browser on one origin; the server only accepts same-origin sockets.
      "/ws": { target: `ws://127.0.0.1:${serverPort}`, ws: true },
    },
  },
});
