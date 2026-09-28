// Playwright の webServer が Bun で起動する e2e の server。
// 1. 本物の server（C の startServer）を一時ファイルの DB で API_PORT に起動する。
// 2. テストのデータを入れる口を CONTROL_PORT に開く。書き込みは server とは別の接続で行うため、
//    nod を別の端末で実行したときと同じく data_version が変わり、SSE の change が届く。
import { join } from "node:path";
import * as core from "@nod/core";
import { startServer } from "@nod/server";
import { CTX_OPS, DB_OPS } from "./support/core-ops";
import { type Dataset, datasetContext, wipe } from "./support/dataset";
import { API_PORT, CONTROL_PORT } from "./support/ports";

const dir = process.env.NOD_E2E_DIR;
if (!dir) throw new Error("NOD_E2E_DIR がありません（playwright.config.ts が設定する）");
const dbPath = join(dir, "nod.db");

// 私の DB（~/.local/share/nod/nod.db）に触れないよう、DB のパスを必ず明示する
let server = startServer({ port: API_PORT, dbPath });
const db = core.openDb(dbPath);

const ctxOps = new Set<string>(CTX_OPS);
const dbOps = new Set<string>(DB_OPS);
type AnyFn = (...args: unknown[]) => unknown;

async function reset(dataset: string): Promise<void> {
  if (!/^[a-z0-9-]+$/.test(dataset)) throw new core.NodError("INVALID_ARGS", `データセットの名前が不正です: ${dataset}`);
  wipe(db);
  if (dataset === "empty") return;
  const mod = (await import(`./datasets/${dataset}.ts`)) as { default: Dataset };
  mod.default(datasetContext(db, dir as string));
}

function call(actor: string, op: string, args: unknown[]): unknown {
  const fn = (core as unknown as Record<string, AnyFn>)[op];
  if (fn && ctxOps.has(op)) return fn({ db, actor }, ...args);
  if (fn && dbOps.has(op)) return fn(db, ...args);
  throw new core.NodError("INVALID_ARGS", `e2e から呼べない関数です: ${op}（e2e/support/core-ops.ts に足す）`);
}

function errorResponse(e: unknown): Response {
  const err = core.toNodError(e);
  const code = err instanceof core.NodError ? err.code : "INTERNAL";
  const message = err instanceof Error ? err.message : String(err);
  return Response.json({ error: { code, message } }, { status: code === "INTERNAL" ? 500 : 400 });
}

const control = Bun.serve({
  hostname: "127.0.0.1",
  port: CONTROL_PORT,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    try {
      // SSE の検証だけが使う。初期化済みの DB で接続と通知の基準を作り直し、
      // 初期化由来の未通知の変更を、対象の外部書き込みと取り違えないようにする。
      if (req.method === "POST" && path === "/restart-server") {
        await server.stop();
        server = startServer({ port: API_PORT, dbPath });
        return Response.json({ ok: true });
      }
      if (req.method === "POST" && path === "/reset") {
        const { dataset } = (await req.json()) as { dataset: string };
        await reset(dataset);
        return Response.json({ ok: true });
      }
      if (req.method === "POST" && path === "/call") {
        const { actor, op, args } = (await req.json()) as { actor: string; op: string; args: unknown[] };
        return Response.json({ result: call(actor, op, args) ?? null });
      }
      return Response.json({ error: { code: "NOT_FOUND", message: path } }, { status: 404 });
    } catch (e) {
      return errorResponse(e);
    }
  },
});

console.log(`nod e2e server: ${server.url}、データの口: ${control.url}（DB: ${dbPath}）`);
