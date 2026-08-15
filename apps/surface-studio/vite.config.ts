import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { surfaceStudioApi } from "./server/plugin-api";

export default defineConfig({
  plugins: [react(), surfaceStudioApi()],
  server: {
    port: 3000,
    strictPort: true,
  },
  preview: {
    port: 3000,
    strictPort: true,
  },
});
