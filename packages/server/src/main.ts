import { NodError } from "@nod/core";
import { DEFAULT_PORT, startServer } from "./server";

// 開発用の入口。web の開発サーバー（Vite）が /api をここに転送する
try {
  const port = process.env.NOD_PORT ? Number(process.env.NOD_PORT) : DEFAULT_PORT;
  const server = startServer({ port, staticDir: process.env.NOD_STATIC_DIR || undefined });
  console.log(`nod server: ${server.url}（DB: ${server.dbPath}）`);
} catch (e) {
  console.error(e instanceof NodError ? `${e.code}: ${e.message}` : e);
  process.exit(1);
}
