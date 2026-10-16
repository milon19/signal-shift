import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Fail loudly instead of drifting to another port the server's CORS_ORIGIN doesn't allow.
  server: { port: 5173, strictPort: true },
});
