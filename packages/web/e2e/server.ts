// Playwright の webServer が Bun で起動する e2e の server。
// 1. 本物の server（C の startServer）を一時ファイルの DB で API_PORT に起動する。
// 2. テストのデータを入れる口を CONTROL_PORT に開く。書き込みは server とは別の接続で行うため、
//    nod を別の端末で実行したときと同じく data_version が変わり、SSE の change が届く。
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "@nod/core";
import { startServer } from "@nod/server";
import { CTX_OPS, DB_OPS } from "./support/core-ops";
import type { FakeTogglEntry, FakeTogglFailures, FakeTogglProject } from "./support/nod";
import { type Dataset, datasetContext, wipe } from "./support/dataset";
import { API_PORT, CONTROL_PORT } from "./support/ports";

const dir = process.env.NOD_E2E_DIR;
if (!dir) throw new Error("NOD_E2E_DIR がありません（playwright.config.ts が設定する）");
const dbPath = join(dir, "nod.db");
// web から作る Document も一時ディレクトリの下に置く（~/.local/share/nod/documents に書かない）
const docsDir = join(dir, "documents");
// 添付ファイルのコピーも一時ディレクトリの下に置く（~/.local/share/nod/attachments に書かない）
const attachmentsDir = join(dir, "attachments");

// PR 状態の取得で gh の代わりに使う。実際の gh・GitHub には触れず、/gh で決めた結果を返す。
// 呼び出しの引数を記録し、/gh の gate が true なら /gh/release まで返さない（取得中の表示を確かめるため）
let ghResult: core.GhRunResult = { kind: "not_found" };
// サブコマンド（args[0]: "pr" は gh pr view、"api" は差分の compare）ごとの結果。無ければ ghResult を返す
let ghResults: Record<string, core.GhRunResult> = {};
let ghCalls: string[][] = [];
let ghGate: Promise<void> | null = null;
let releaseGh: () => void = () => {};
const ghRunner: core.GhRunner = async (args) => {
  ghCalls.push(args);
  if (ghGate) await ghGate;
  // サブコマンド（args[0]）の完全一致を先に見る。無ければ、空白を含むキー（"-X POST" など）が引数の文字列に含まれるものを、長い順に使う
  const exact = ghResults[args[0] ?? ""];
  if (exact !== undefined) return exact;
  const joined = args.join(" ");
  const key = Object.keys(ghResults)
    .filter((k) => k.includes(" ") && joined.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  return key === undefined ? ghResult : ghResults[key]!;
};

// Orca 連携（#52・#51・#58）で orca の代わりに使う。実際の orca・Orca には触れず、/orca で決めた結果を
// サブコマンド（"terminal list" など）ごとに返す。無いサブコマンドは not_found（orca が無い）
let orcaResults: Record<string, core.GhRunResult> = {};
let orcaCalls: string[][] = [];
const orcaRunner: core.OrcaRunner = async (args) => {
  orcaCalls.push(args);
  return orcaResults[`${args[0]} ${args[1]}`] ?? { kind: "not_found" };
};

// Toggl 打刻（NOD-6）で本物の Toggl の代わりに使う。/toggl で決めた現在の打刻と Project の一覧を持ち、開始・停止・Project の変更で書き換える。
// トークンの設定ファイルも一時ディレクトリの下に置き（~/.config/nod/toggl.json を読まない）、/toggl で書き換える
const togglConfigPath = join(dir, "toggl.json");
const TOGGL_WORKSPACE_ID = 4242;
let togglCurrent: FakeTogglEntry | null = null;
let togglProjects: FakeTogglProject[] = [];
let togglCalls: core.TogglRequest[] = [];
let togglNextId = 9001;
// 起こす失敗（中身は support/nod.ts の FakeTogglFailures）
let togglFailures: FakeTogglFailures = {};
let togglStartAttempted = false;
// server の現在の打刻のキャッシュ。テストの間で持ち越さないよう、/reset と /toggl で消す
const togglCache = core.createTogglCache();
const togglClient: core.TogglClient = async (req) => {
  togglCalls.push(req);
  const ok = (body: unknown): core.TogglResponse => ({ kind: "ok", status: 200, body });
  // トークンの誤りと利用上限は、現在の打刻の取得に限らずどの呼び出しでも起きる
  if (togglFailures.current === "auth") return { kind: "ok", status: 401, body: "Unauthorized" };
  if (togglFailures.current === "quota") return { kind: "ok", status: 402, body: "quota exceeded", headers: { "x-toggl-quota-resets-in": "600" } };
  if (req.method === "GET" && req.path === "/me") return ok({ id: 1, default_workspace_id: TOGGL_WORKSPACE_ID });
  if (req.method === "GET" && req.path === "/me/time_entries/current") {
    if (togglStartAttempted && togglFailures.currentAfterStart) return { kind: "network_error", detail: "ECONNRESET" };
    if (togglFailures.current === "network") return { kind: "network_error", detail: "ECONNREFUSED" };
    return ok(togglCurrent);
  }
  if (req.method === "GET" && req.path === `/workspaces/${TOGGL_WORKSPACE_ID}/projects?active=true`) {
    if (togglFailures.projects === "network") return { kind: "network_error", detail: "ECONNREFUSED" };
    return ok(togglProjects);
  }
  if (req.method === "POST" && req.path === `/workspaces/${TOGGL_WORKSPACE_ID}/time_entries`) {
    togglStartAttempted = true;
    if (togglFailures.start === "http_error") return { kind: "ok", status: 500, body: "Internal Server Error" };
    const body = req.body as { description: string; start: string; project_id?: number | null };
    togglCurrent = { id: togglNextId++, workspace_id: TOGGL_WORKSPACE_ID, project_id: body.project_id ?? null, description: body.description, start: body.start, duration: -1 };
    if (togglFailures.start === "timeout") return { kind: "timeout" };
    return ok(togglCurrent);
  }
  const update = /^\/workspaces\/(\d+)\/time_entries\/(\d+)$/.exec(req.path);
  if (req.method === "PUT" && update && togglFailures.update === "http_error") return { kind: "ok", status: 500, body: "Internal Server Error" };
  if (req.method === "PUT" && update && togglCurrent?.id === Number(update[2])) {
    togglCurrent = { ...togglCurrent, project_id: (req.body as { project_id: number | null }).project_id };
    return ok(togglCurrent);
  }
  const stop = /^\/workspaces\/(\d+)\/time_entries\/(\d+)\/stop$/.exec(req.path);
  if (req.method === "PATCH" && stop && togglFailures.stop === "conflict") {
    togglCurrent = null;
    return { kind: "ok", status: 409, body: "Time entry already stopped" };
  }
  if (req.method === "PATCH" && stop && togglCurrent?.id === Number(stop[2])) {
    const stopped = { ...togglCurrent, duration: Math.round((Date.now() - Date.parse(togglCurrent.start)) / 1000) };
    togglCurrent = null;
    return ok(stopped);
  }
  return { kind: "ok", status: 404, body: "Not Found" };
};

function serve() {
  return startServer({ port: API_PORT, dbPath, docsDir, ghRunner, attachmentsDir, orcaRunner, togglClient, togglConfigPath, togglCache });
}

// 私の DB（~/.local/share/nod/nod.db）に触れないよう、DB のパスを必ず明示する
let server = serve();
const db = core.openDb(dbPath);

const ctxOps = new Set<string>(CTX_OPS);
const dbOps = new Set<string>(DB_OPS);
type AnyFn = (...args: unknown[]) => unknown;

async function reset(dataset: string): Promise<void> {
  if (!/^[a-z0-9-]+$/.test(dataset)) throw new core.NodError("INVALID_ARGS", `データセットの名前が不正です: ${dataset}`);
  wipe(db);
  rmSync(docsDir, { recursive: true, force: true });
  rmSync(attachmentsDir, { recursive: true, force: true });
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
        server = serve();
        return Response.json({ ok: true });
      }
      if (req.method === "POST" && path === "/reset") {
        const { dataset } = (await req.json()) as { dataset: string };
        await reset(dataset);
        ghResult = { kind: "not_found" };
        ghResults = {};
        ghCalls = [];
        releaseGh();
        ghGate = null;
        orcaResults = {};
        orcaCalls = [];
        rmSync(togglConfigPath, { force: true });
        togglCurrent = null;
        togglProjects = [];
        togglCalls = [];
        togglFailures = {};
        togglStartAttempted = false;
        togglCache.clear();
        return Response.json({ ok: true });
      }
      if (req.method === "POST" && path === "/toggl") {
        // token が null ならトークンの設定ファイルを消す（未設定）。current は Toggl の現在の打刻、projects は既定の Workspace の有効な Project
        // failures は切り替えの途中の失敗（省くと失敗しない）。keepCache なら server のキャッシュを消さない（Toggl 側だけが変わったとき）
        const body = (await req.json()) as { token?: string | null; current?: FakeTogglEntry | null; projects?: FakeTogglProject[]; failures?: FakeTogglFailures; keepCache?: boolean };
        if (body.token === null) rmSync(togglConfigPath, { force: true });
        else if (body.token !== undefined) writeFileSync(togglConfigPath, JSON.stringify({ apiToken: body.token }));
        if (body.current !== undefined) togglCurrent = body.current;
        if (body.projects !== undefined) togglProjects = body.projects;
        togglFailures = body.failures ?? {};
        togglStartAttempted = false;
        togglCalls = [];
        if (!body.keepCache) togglCache.clear();
        return Response.json({ ok: true, configPath: togglConfigPath });
      }
      if (req.method === "GET" && path === "/toggl/calls") {
        return Response.json({ calls: togglCalls, current: togglCurrent, configPath: togglConfigPath });
      }
      if (req.method === "POST" && path === "/orca") {
        orcaResults = ((await req.json()) as { results: Record<string, core.GhRunResult> }).results;
        orcaCalls = [];
        return Response.json({ ok: true });
      }
      if (req.method === "GET" && path === "/orca/calls") return Response.json({ calls: orcaCalls });
      if (req.method === "POST" && path === "/gh") {
        const body = (await req.json()) as { result: core.GhRunResult; results?: Record<string, core.GhRunResult>; gate?: boolean };
        ghResult = body.result;
        ghResults = body.results ?? {};
        ghCalls = [];
        releaseGh();
        ghGate = body.gate ? new Promise<void>((r) => (releaseGh = r)) : null;
        return Response.json({ ok: true });
      }
      if (req.method === "POST" && path === "/gh/release") {
        releaseGh();
        ghGate = null;
        return Response.json({ ok: true });
      }
      if (req.method === "GET" && path === "/gh/calls") return Response.json({ calls: ghCalls });
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
