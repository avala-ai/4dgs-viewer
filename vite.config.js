import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Relative assets work both under GitHub's /4dgs-viewer/ project path and at the root
  // of the custom domain once viewer.4dgs.dev is configured.
  base: "./",
  plugins: [react()],
  build: { sourcemap: true },
});
