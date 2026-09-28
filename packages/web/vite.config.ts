import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// /api を nod の server に転送する（SSE の /api/events もそのまま通る）。
// 開発時はルートの bun run server（4700）に、e2e は NOD_API_URL で e2e の server に向ける
const API_URL = process.env.NOD_API_URL ?? "http://127.0.0.1:4700";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": API_URL } },
});
