import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { surfaceStudioApi } from "./server/plugin-api";

export default defineConfig(({ mode }) => {
  /**
   * `FANOS_*` from `apps/surface-studio/.env` into `process.env`, before the plugin reads its
   * config. Vite only exposes `.env` to client code, and the plugin is server-side — so without
   * this a local `FANOS_API_URL` was silently ignored and Studio fell back to :4000, where on a
   * machine running another service it reports "control plane reachable" for the wrong API.
   * A variable already set in the shell wins.
   */
  for (const [key, value] of Object.entries(loadEnv(mode, process.cwd(), "FANOS_"))) {
    process.env[key] ??= value;
  }

  return {
    plugins: [react(), surfaceStudioApi()],
    server: {
      port: 3000,
      strictPort: true,
    },
    preview: {
      port: 3000,
      strictPort: true,
    },
  };
});
