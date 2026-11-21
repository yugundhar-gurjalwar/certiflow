import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { defineConfig } from "vite";

// In dev the Vite server proxies /api to the backend, so the browser only ever talks to one origin.
export default defineConfig({
  plugins: [react(), tailwind()],
  server: { port: 5173, proxy: { "/api": { target: process.env.API_URL ?? "http://localhost:4000", changeOrigin: true } } },
});
