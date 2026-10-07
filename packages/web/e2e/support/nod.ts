// テスト（Node）から e2e の server のデータの口を呼ぶ。Node では bun:sqlite を使えないため、core の関数は e2e の server が実行する。
// @nod/core は型だけを import する（実行時には読み込まない）。
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type * as Core from "@nod/core";
import type { CtxOp, DbOp } from "./core-ops";
import { CONTROL_PORT } from "./ports";

type Tail<T extends unknown[]> = T extends [unknown, ...infer Rest] ? Rest : never;
type Remote<F> = F extends (...args: infer A) => infer R ? (...args: Tail<A>) => Promise<R> : never;

// core の関数から第1引数（OpCtx か Database）を除き、Promise を返すようにしたもの
export type NodClient = { [K in CtxOp | DbOp]: Remote<(typeof Core)[K]> };

const CONTROL_URL = `http://127.0.0.1:${CONTROL_PORT}`;

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${CONTROL_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { result?: unknown; error?: { code: string; message: string } };
  if (json.error) throw new NodCallError(json.error.code, json.error.message);
  return json.result;
}

export class NodCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "NodCallError";
  }
}

// DB を空にし、データセット（e2e/datasets/<名前>.ts）を入れる。"empty" は空のまま
export async function resetData(dataset: string): Promise<void> {
  await post("/reset", { dataset });
}

// データ初期化後、SSE の検証を始める前にだけ使う。DB の内容は変えず、通知の基準を作り直す。
export async function restartApiServer(): Promise<void> {
  await post("/restart-server", {});
}

// PR 状態の取得で e2e の server が gh の代わりに返す結果を決める。gate なら releaseGh まで返さない
export async function stubGh(result: Core.GhRunResult, opts: { gate?: boolean } = {}): Promise<void> {
  await post("/gh", { result, gate: opts.gate ?? false });
}

// サブコマンドごとに結果を返し分ける（PR の差分は gh pr view と gh api の2回呼ぶ）。無いサブコマンドは not_found
export async function stubGhBy(results: Record<string, Core.GhRunResult>, opts: { gate?: boolean } = {}): Promise<void> {
  await post("/gh", { result: { kind: "not_found" }, results, gate: opts.gate ?? false });
}

export async function releaseGh(): Promise<void> {
  await post("/gh/release", {});
}

// Orca 連携で e2e の server が orca の代わりに返す結果を、サブコマンド（"terminal list" など）ごとに決める
export async function stubOrca(results: Record<string, unknown>): Promise<void> {
  await post("/orca", { results });
}

// 偽の orca が受け取った引数（stubOrca・resetData で空に戻る）
export async function orcaCalls(): Promise<string[][]> {
  const res = await fetch(`${CONTROL_URL}/orca/calls`);
  return ((await res.json()) as { calls: string[][] }).calls;
}

// 偽の gh が受け取った引数（stubGh・resetData で空に戻る）
export async function ghCalls(): Promise<string[][]> {
  const res = await fetch(`${CONTROL_URL}/gh/calls`);
  return ((await res.json()) as { calls: string[][] }).calls;
}

// Toggl 打刻（NOD-6）で e2e の server が本物の Toggl の代わりに持つ状態を決める。
// token が null ならトークンの設定ファイルを消し（未設定）、文字列なら書く。current は Toggl の現在の打刻。
// failures は切り替えの途中の失敗（start: 開始が断られる・応答が途絶える、stop: 止めようとした打刻がほかで止められていた、
// currentAfterStart: 開始のあとの取り直しが通信に失敗する）。server の現在の打刻のキャッシュは消す。
// keepCache なら消さない（nod の外で Toggl 側だけが変わったときを表す）
export interface FakeTogglEntry {
  id: number;
  workspace_id: number;
  description: string;
  start: string;
  duration: number;
}
export interface FakeTogglFailures {
  start?: "http_error" | "timeout";
  stop?: "conflict";
  currentAfterStart?: boolean;
}
export async function stubToggl(state: {
  token?: string | null;
  current?: FakeTogglEntry | null;
  failures?: FakeTogglFailures;
  keepCache?: boolean;
}): Promise<void> {
  await post("/toggl", state);
}

// 偽の Toggl が受け取った要求（stubToggl・resetData で空に戻る）と、現在の打刻・設定ファイルの場所
export async function togglState(): Promise<{ calls: Core.TogglRequest[]; current: FakeTogglEntry | null; configPath: string }> {
  const res = await fetch(`${CONTROL_URL}/toggl/calls`);
  return (await res.json()) as { calls: Core.TogglRequest[]; current: FakeTogglEntry | null; configPath: string };
}

// actor を書き手にして core の関数を呼ぶクライアント。
// 末尾の undefined の引数は送らない（JSON では null になり、省略とみなされないため）
export function nodAs(actor: string): NodClient {
  return new Proxy({} as NodClient, {
    get: (_, op: string) =>
      (...args: unknown[]) => {
        while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
        return post("/call", { actor, op, args });
      },
  });
}

export function e2eDir(): string {
  const dir = process.env.NOD_E2E_DIR;
  if (!dir) throw new Error("NOD_E2E_DIR がありません。playwright.config.ts から実行してください");
  return dir;
}

export interface NodData {
  me: NodClient; // 書き手 me（web の操作と同じ書き手）
  claude: NodClient; // 書き手 claude-code（LLM）
  codex: NodClient; // 書き手 codex（LLM）
  as(actor: string): NodClient;
  dir: string; // e2e の一時ディレクトリ
  repo(name: string): string; // <dir>/repos/<name> を作って返す。Workspace の path に使う
  writeFile(path: string, body: string): string; // <dir> からの相対パスにファイルを書き、絶対パスを返す
  removeFile(path: string): void; // 「ファイルが見つかりません」を試すために消す
}

export function nodData(): NodData {
  const dir = e2eDir();
  return {
    me: nodAs("me"),
    claude: nodAs("claude-code"),
    codex: nodAs("codex"),
    as: nodAs,
    dir,
    repo(name) {
      const path = join(dir, "repos", name);
      mkdirSync(path, { recursive: true });
      return path;
    },
    writeFile(path, body) {
      const abs = join(dir, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
      return abs;
    },
    removeFile(path) {
      rmSync(path, { force: true });
    },
  };
}
