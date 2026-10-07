import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createIssue, type TogglClient, type TogglRequest, type TogglResponse } from "@nod/core";
import { createApp } from "../src/app";
import { call, setup, tempDir } from "./helpers";

// 本物の Toggl には触れない。偽のクライアントは受け取った要求を記録し、handler の結果を返す
function fakeToggl(handler: (req: TogglRequest) => TogglResponse | undefined = () => undefined) {
  const calls: TogglRequest[] = [];
  const client: TogglClient = async (req) => {
    calls.push(req);
    return handler(req) ?? { kind: "ok", status: 404, body: null };
  };
  return { client, calls };
}

function withToggl(handler?: (req: TogglRequest) => TogglResponse | undefined, opts: { token?: string | null } = {}) {
  const s = setup();
  const configPath = join(tempDir("nod-toggl-"), "toggl.json");
  const token = opts.token === undefined ? "tok-1" : opts.token;
  if (token !== null) writeFileSync(configPath, JSON.stringify({ apiToken: token }));
  const toggl = fakeToggl(handler);
  const app = createApp({ db: s.db, togglClient: toggl.client, togglConfigPath: configPath });
  const issue = createIssue(s.me, { workspaceId: s.ws.id, title: "検索 API" });
  return { ...s, app, ref: issue.id, configPath, calls: toggl.calls };
}

const START = "2026-10-07T01:00:00Z";
// Toggl の現在の打刻（GET /me/time_entries/current）の応答
const running = (description: string, id = 501) => ({ id, workspace_id: 77, description, start: START, duration: -1, project_id: null });
const currentIs = (entry: unknown) => (req: TogglRequest): TogglResponse | undefined =>
  req.method === "GET" && req.path === "/me/time_entries/current" ? { kind: "ok", status: 200, body: entry } : undefined;

const ORIGINAL_CONFIG = process.env.NOD_TOGGL_CONFIG;
afterEach(() => {
  if (ORIGINAL_CONFIG === undefined) delete process.env.NOD_TOGGL_CONFIG;
  else process.env.NOD_TOGGL_CONFIG = ORIGINAL_CONFIG;
});

describe("Toggl 打刻 API", () => {
  test("トークンが未設定なら configured: false と設定ファイルの場所を返し、Toggl を呼ばない", async () => {
    const { app, ref, configPath, calls } = withToggl(undefined, { token: null });
    const res = await call(app, "GET", `/api/issues/${ref}/toggl`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ configured: false, configPath, current: null });
    expect(calls).toEqual([]);
  });

  test("打刻が動いていなければ current: null を返し、設定ファイルのトークンで現在の打刻を読む", async () => {
    const { app, ref, configPath, calls } = withToggl(currentIs(null));
    const res = await call(app, "GET", `/api/issues/${ref}/toggl`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ configured: true, configPath, current: null });
    expect(calls).toEqual([{ method: "GET", path: "/me/time_entries/current", token: "tok-1" }]);
  });

  test("説明が「<Issue ID> 」で始まる打刻はこの Issue の打刻と判定する", async () => {
    const { app, ref } = withToggl(currentIs(running("API-1 検索 API")));
    expect(ref).toBe("API-1");
    const res = await call(app, "GET", `/api/issues/${ref}/toggl`);
    expect(res.json.current).toEqual({ id: 501, workspaceId: 77, description: "API-1 検索 API", start: START, thisIssue: true });
  });

  test("API-10 の打刻や空白の無い説明を API-1 の打刻と取り違えない", async () => {
    for (const description of ["API-10 別の作業", "API-1", "API-1検索", "x API-1 検索"]) {
      const { app, ref } = withToggl(currentIs(running(description)));
      const res = await call(app, "GET", `/api/issues/${ref}/toggl`);
      expect(res.json.current).toMatchObject({ description, thisIssue: false });
    }
  });

  test("開始は既定の Workspace に「<Issue ID> <タイトル>」の打刻を Project・タグなしで作り、この Issue の打刻を返す", async () => {
    const { app, ref, configPath, calls } = withToggl((req) => {
      if (req.method === "GET" && req.path === "/me") return { kind: "ok", status: 200, body: { id: 9, default_workspace_id: 77 } };
      if (req.method === "POST" && req.path === "/workspaces/77/time_entries") {
        const body = req.body as { description: string; start: string };
        return { kind: "ok", status: 200, body: { id: 601, workspace_id: 77, description: body.description, start: body.start, duration: -1 } };
      }
    });
    const before = Date.now();
    const res = await call(app, "POST", `/api/issues/${ref}/toggl/start`);
    expect(res.status).toBe(200);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /me", "POST /workspaces/77/time_entries"]);
    expect(calls.every((c) => c.token === "tok-1")).toBe(true);
    const body = calls[1]!.body as Record<string, unknown>;
    expect(body).toEqual({ created_with: "nod", workspace_id: 77, description: "API-1 検索 API", start: body.start, duration: -1 });
    expect(Date.parse(body.start as string)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(body.start as string)).toBeLessThanOrEqual(Date.now());
    expect(res.json).toEqual({
      configured: true,
      configPath,
      current: { id: 601, workspaceId: 77, description: "API-1 検索 API", start: body.start, thisIssue: true },
    });
  });

  test("トークンが未設定なら開始も停止も 409 で、Toggl を呼ばない", async () => {
    const { app, ref, calls } = withToggl(undefined, { token: null });
    for (const op of ["start", "stop"]) {
      const res = await call(app, "POST", `/api/issues/${ref}/toggl/${op}`);
      expect(res.status).toBe(409);
      expect(res.json.error.code).toBe("TOGGL_NOT_CONFIGURED");
    }
    expect(calls).toEqual([]);
  });

  test("停止はこの Issue の打刻を PATCH .../stop で止め、current: null を返す", async () => {
    const { app, ref, calls } = withToggl((req) => {
      if (req.method === "PATCH") return { kind: "ok", status: 200, body: { ...running("API-1 検索 API"), duration: 60 } };
      return currentIs(running("API-1 検索 API"))(req);
    });
    const res = await call(app, "POST", `/api/issues/${ref}/toggl/stop`);
    expect(res.status).toBe(200);
    expect(res.json.current).toBeNull();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /me/time_entries/current", "PATCH /workspaces/77/time_entries/501/stop"]);
  });

  test("動いている打刻がほかの Issue のものなら停止は 409 で、止めない", async () => {
    const { app, ref, calls } = withToggl(currentIs(running("API-10 別の作業")));
    const res = await call(app, "POST", `/api/issues/${ref}/toggl/stop`);
    expect(res.status).toBe(409);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  test("設定ファイルのトークンの書き換えは、再起動せずに次の呼び出しから使われる。トークンは応答に含めない", async () => {
    const { app, ref, configPath, calls } = withToggl(currentIs(null), { token: null });
    expect((await call(app, "GET", `/api/issues/${ref}/toggl`)).json.configured).toBe(false);
    writeFileSync(configPath, JSON.stringify({ apiToken: "secret-A" }));
    const a = await call(app, "GET", `/api/issues/${ref}/toggl`);
    writeFileSync(configPath, JSON.stringify({ apiToken: "secret-B" }));
    const b = await call(app, "GET", `/api/issues/${ref}/toggl`);
    expect(calls.map((c) => c.token)).toEqual(["secret-A", "secret-B"]);
    expect(a.json.configured).toBe(true);
    expect(JSON.stringify([a.json, b.json])).not.toContain("secret-");
  });

  test("apiToken の無い・JSON でない設定ファイルは未設定として扱う", async () => {
    for (const text of ["{}", '{"apiToken": ""}', "not json"]) {
      const { app, ref, configPath, calls } = withToggl(currentIs(null), { token: null });
      writeFileSync(configPath, text);
      expect((await call(app, "GET", `/api/issues/${ref}/toggl`)).json.configured).toBe(false);
      expect(calls).toEqual([]);
    }
  });

  test("togglConfigPath を省くと NOD_TOGGL_CONFIG の設定ファイルを毎回読む", async () => {
    const s = setup();
    const issue = createIssue(s.me, { workspaceId: s.ws.id, title: "検索 API" });
    const toggl = fakeToggl(currentIs(null));
    const app = createApp({ db: s.db, togglClient: toggl.client });
    const configPath = join(tempDir("nod-toggl-env-"), "toggl.json");
    writeFileSync(configPath, JSON.stringify({ apiToken: "tok-env" }));
    process.env.NOD_TOGGL_CONFIG = configPath;
    const res = await call(app, "GET", `/api/issues/${issue.id}/toggl`);
    expect(res.json).toEqual({ configured: true, configPath, current: null });
    expect(toggl.calls.map((c) => c.token)).toEqual(["tok-env"]);
  });

  test("外部サイトからの開始・停止は拒む", async () => {
    const { app, ref, calls } = withToggl();
    for (const op of ["start", "stop"]) {
      const res = await app.request(`/api/issues/${ref}/toggl/${op}`, { method: "POST", headers: { Origin: "https://evil.example" } });
      expect(res.status).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  test("無い Issue は 404", async () => {
    const { app } = withToggl();
    expect((await call(app, "GET", "/api/issues/API-999/toggl")).status).toBe(404);
    expect((await call(app, "POST", "/api/issues/API-999/toggl/start")).status).toBe(404);
  });
});
