import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createIssue, createTogglCache, TOGGL_CACHE_TTL_MS, type TogglClient, type TogglRequest, type TogglResponse } from "@nod/core";
import { createApp } from "../src/app";
import { call, setup, tempDir } from "./helpers";

// 本物の Toggl には触れない。偽のクライアントは受け取った要求を記録し、handler の結果を返す
type Handler = (req: TogglRequest) => TogglResponse | undefined | Promise<TogglResponse | undefined>;
function fakeToggl(handler: Handler = () => undefined) {
  const calls: TogglRequest[] = [];
  const client: TogglClient = async (req) => {
    calls.push(req);
    return (await handler(req)) ?? { kind: "ok", status: 404, body: null };
  };
  return { client, calls };
}

function withToggl(handler?: Handler, opts: { token?: string | null } = {}) {
  const s = setup();
  const configPath = join(tempDir("nod-toggl-"), "toggl.json");
  const token = opts.token === undefined ? "tok-1" : opts.token;
  if (token !== null) writeFileSync(configPath, JSON.stringify({ apiToken: token }));
  const toggl = fakeToggl(handler);
  // 現在の打刻のキャッシュの時計。テストが進める
  const clock = { ms: Date.parse(NOW) };
  const app = createApp({ db: s.db, togglClient: toggl.client, togglConfigPath: configPath, togglCache: createTogglCache({ now: () => clock.ms }) });
  const issue = createIssue(s.me, { workspaceId: s.ws.id, title: "検索 API" });
  return { ...s, app, ref: issue.id, configPath, calls: toggl.calls, clock };
}

const START = "2026-10-07T01:00:00Z";
// キャッシュの時計の初期値（取得時刻）
const NOW = "2026-10-07T02:00:00.000Z";
// Toggl の現在の打刻（GET /me/time_entries/current）の応答
const running = (description: string, id = 501) => ({ id, workspace_id: 77, description, start: START, duration: -1, project_id: null });
const currentIs = (entry: unknown) => (req: TogglRequest): TogglResponse | undefined =>
  req.method === "GET" && req.path === "/me/time_entries/current" ? { kind: "ok", status: 200, body: entry } : undefined;

// 現在の打刻を持ち、開始・停止で書き換える偽の Toggl。over で要求ごとの応答を差し替える（undefined なら既定の動き）
function togglWorld(initial: ReturnType<typeof running> | null, over: Handler = () => undefined) {
  const world = { current: initial, nextId: 601 };
  const handler: Handler = async (req) => {
    const o = await over(req);
    if (o) return o;
    const ok = (body: unknown): TogglResponse => ({ kind: "ok", status: 200, body });
    if (req.method === "GET" && req.path === "/me") return ok({ id: 9, default_workspace_id: 77 });
    if (req.method === "GET" && req.path === "/me/time_entries/current") return ok(world.current);
    if (req.method === "POST" && req.path === "/workspaces/77/time_entries") {
      const body = req.body as { description: string; start: string };
      world.current = { id: world.nextId++, workspace_id: 77, description: body.description, start: body.start, duration: -1, project_id: null };
      return ok(world.current);
    }
    const stop = /^\/workspaces\/77\/time_entries\/(\d+)\/stop$/.exec(req.path);
    if (req.method === "PATCH" && stop && world.current?.id === Number(stop[1])) {
      const stopped = { ...world.current, duration: 60 };
      world.current = null;
      return ok(stopped);
    }
  };
  return { world, handler };
}
const callNames = (calls: TogglRequest[]) => calls.map((c) => `${c.method} ${c.path}`);

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
    expect(res.json).toEqual({ configured: false, configPath, current: null, fetchedAt: null });
    expect(calls).toEqual([]);
  });

  test("打刻が動いていなければ current: null を返し、設定ファイルのトークンで現在の打刻を読む", async () => {
    const { app, ref, configPath, calls } = withToggl(currentIs(null));
    const res = await call(app, "GET", `/api/issues/${ref}/toggl`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ configured: true, configPath, current: null, fetchedAt: NOW });
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
      return currentIs(null)(req);
    });
    const before = Date.now();
    const res = await call(app, "POST", `/api/issues/${ref}/toggl/start`);
    expect(res.status).toBe(200);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /me/time_entries/current", "GET /me", "POST /workspaces/77/time_entries"]);
    expect(calls.every((c) => c.token === "tok-1")).toBe(true);
    const body = calls[2]!.body as Record<string, unknown>;
    expect(body).toEqual({ created_with: "nod", workspace_id: 77, description: "API-1 検索 API", start: body.start, duration: -1 });
    expect(Date.parse(body.start as string)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(body.start as string)).toBeLessThanOrEqual(Date.now());
    expect(res.json).toEqual({
      configured: true,
      configPath,
      current: { id: 601, workspaceId: 77, description: "API-1 検索 API", start: body.start, thisIssue: true },
      fetchedAt: NOW,
    });
  });

  test("別の打刻が動いていれば、開始の直前に取り直した打刻を明示的に止めてから開始する", async () => {
    const { world, handler } = togglWorld(running("API-10 別の作業"));
    const { app, ref, calls } = withToggl(handler);
    const res = await call(app, "POST", `/api/issues/${ref}/toggl/start`);
    expect(res.status).toBe(200);
    expect(callNames(calls)).toEqual([
      "GET /me/time_entries/current",
      "GET /me",
      "PATCH /workspaces/77/time_entries/501/stop",
      "POST /workspaces/77/time_entries",
    ]);
    expect(res.json.current).toMatchObject({ id: 601, description: "API-1 検索 API", thisIssue: true });
    expect(world.current?.id).toBe(601);
  });

  test("この Issue の打刻がすでに動いていれば、開始は新しい打刻を作らずに今の打刻を返す", async () => {
    const { handler } = togglWorld(running("API-1 検索 API"));
    const { app, ref, calls } = withToggl(handler);
    const res = await call(app, "POST", `/api/issues/${ref}/toggl/start`);
    expect(res.status).toBe(200);
    expect(res.json.current).toMatchObject({ id: 501, thisIssue: true });
    expect(callNames(calls)).toEqual(["GET /me/time_entries/current"]);
  });

  test("開始・停止は 1 つずつ処理する。2 つのタブから同時に開始しても打刻は 1 つだけ作る", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const { handler } = togglWorld(null, async (req) => {
      if (req.method === "GET" && req.path === "/me/time_entries/current" && first) {
        first = false;
        await gate;
      }
      return undefined;
    });
    const { app, ref, calls } = withToggl(handler);
    const a = call(app, "POST", `/api/issues/${ref}/toggl/start`);
    const b = call(app, "POST", `/api/issues/${ref}/toggl/start`);
    await Bun.sleep(20);
    // 1 つめが Toggl の応答を待つ間、2 つめは Toggl を呼ばない
    expect(calls.length).toBe(1);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(callNames(calls)).toEqual(["GET /me/time_entries/current", "GET /me", "POST /workspaces/77/time_entries", "GET /me/time_entries/current"]);
    expect(rb.json.current).toMatchObject({ id: 601, thisIssue: true });
  });

  test("止めようとした打刻がすでに止まっていた（404・409）ら開始せずに中断し、取り直した状態を返す", async () => {
    for (const status of [404, 409]) {
      const { world, handler } = togglWorld(running("API-10 別の作業"), (req) => {
        if (req.method !== "PATCH") return undefined;
        // 外で止められ、別の打刻が始まっていた
        world.current = running("外で始めた打刻", 777);
        return { kind: "ok", status, body: "Time entry already stopped" };
      });
      const { app, ref, configPath, calls } = withToggl(handler);
      const res = await call(app, "POST", `/api/issues/${ref}/toggl/start`);
      expect(res.status).toBe(409);
      expect(res.json.error.code).toBe("TOGGL_CONFLICT");
      expect(res.json.error.details).toEqual({
        view: {
          configured: true,
          configPath,
          current: { id: 777, workspaceId: 77, description: "外で始めた打刻", start: START, thisIssue: false },
          fetchedAt: NOW,
        },
      });
      expect(calls.some((c) => c.method === "POST")).toBe(false);
      expect(callNames(calls).at(-1)).toBe("GET /me/time_entries/current");
    }
  });

  test("この Issue の打刻の停止で、打刻がすでに止まっていたら競合として取り直した状態を返す", async () => {
    const { world, handler } = togglWorld(running("API-1 検索 API"), (req) => {
      if (req.method !== "PATCH") return undefined;
      world.current = null;
      return { kind: "ok", status: 404, body: null };
    });
    const { app, ref, calls } = withToggl(handler);
    const res = await call(app, "POST", `/api/issues/${ref}/toggl/stop`);
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("TOGGL_CONFLICT");
    expect(res.json.error.details.view.current).toBeNull();
    expect(callNames(calls).at(-1)).toBe("GET /me/time_entries/current");
  });

  test("切り替えで前の打刻を止めたあと開始に失敗したら、再送せずに取り直し、前の打刻が止まったことと開始の失敗を返す", async () => {
    const { handler } = togglWorld(running("API-10 別の作業"), (req) =>
      req.method === "POST" ? { kind: "ok", status: 500, body: "Internal Server Error" } : undefined,
    );
    const { app, ref, configPath, calls } = withToggl(handler);
    const res = await call(app, "POST", `/api/issues/${ref}/toggl/start`);
    expect(res.status).toBe(502);
    expect(res.json.error.code).toBe("TOGGL_START_FAILED");
    expect(res.json.error.details).toEqual({
      previous: { description: "API-10 別の作業", stopped: true },
      start: "failed",
      view: { configured: true, configPath, current: null, fetchedAt: NOW },
    });
    expect(res.json.error.message).toBe("前の打刻「API-10 別の作業」は止まりました。この Issue の打刻は開始できませんでした（HTTP 500）");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(callNames(calls).at(-1)).toBe("GET /me/time_entries/current");
  });

  test("開始の応答が途絶えたら成否不明として返し、再送しない。取り直した状態はそのまま返す", async () => {
    const { world, handler } = togglWorld(running("API-10 別の作業"), (req) => {
      if (req.method !== "POST") return undefined;
      // Toggl 側では打刻が作られたが、応答が届かなかった
      world.current = running("API-1 検索 API", 602);
      return { kind: "timeout" };
    });
    const { app, ref, calls } = withToggl(handler);
    const res = await call(app, "POST", `/api/issues/${ref}/toggl/start`);
    expect(res.status).toBe(502);
    expect(res.json.error.details).toMatchObject({ previous: { description: "API-10 別の作業", stopped: true }, start: "unknown" });
    expect(res.json.error.details.view.current).toMatchObject({ id: 602, thisIssue: true });
    expect(res.json.error.message).toBe("前の打刻「API-10 別の作業」は止まりました。この Issue の打刻が開始されたかは分かりません（15秒以内に応答がありませんでした）");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  test("開始に失敗し、取り直しにも失敗したら「成否を確認できません」と返す", async () => {
    let started = false;
    const { handler } = togglWorld(running("API-10 別の作業"), (req) => {
      if (req.method === "POST") {
        started = true;
        return { kind: "network_error", detail: "socket hang up" };
      }
      if (started && req.path === "/me/time_entries/current") return { kind: "network_error", detail: "ECONNREFUSED" };
    });
    const { app, ref } = withToggl(handler);
    const res = await call(app, "POST", `/api/issues/${ref}/toggl/start`);
    expect(res.status).toBe(502);
    expect(res.json.error.details).toEqual({ previous: { description: "API-10 別の作業", stopped: true }, start: "unknown", view: null });
    expect(res.json.error.message).toContain("成否を確認できません");
  });

  test("動いている打刻が無いときの開始の失敗は、止めた打刻なしとして返す", async () => {
    const { handler } = togglWorld(null, (req) => (req.method === "POST" ? { kind: "ok", status: 400, body: "bad" } : undefined));
    const { app, ref } = withToggl(handler);
    const res = await call(app, "POST", `/api/issues/${ref}/toggl/start`);
    expect(res.status).toBe(502);
    expect(res.json.error.details).toMatchObject({ previous: null, start: "failed" });
    expect(res.json.error.message).toBe("この Issue の打刻は開始できませんでした（HTTP 400）");
  });

  test("切り替えで前の打刻を止められなかったら開始せず、前の打刻の停止の成否を返す", async () => {
    for (const [resp, stopped] of [
      [{ kind: "ok", status: 500, body: null }, false],
      [{ kind: "timeout" }, "unknown"],
    ] as const) {
      const { handler } = togglWorld(running("API-10 別の作業"), (req) => (req.method === "PATCH" ? resp : undefined));
      const { app, ref, calls } = withToggl(handler);
      const res = await call(app, "POST", `/api/issues/${ref}/toggl/start`);
      expect(res.status).toBe(502);
      expect(res.json.error.code).toBe("TOGGL_START_FAILED");
      expect(res.json.error.details).toMatchObject({ previous: { description: "API-10 別の作業", stopped }, start: "not_attempted" });
      expect(res.json.error.details.view.current).toMatchObject({ id: 501 });
      expect(calls.some((c) => c.method === "POST")).toBe(false);
    }
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
    expect(res.json).toEqual({ configured: true, configPath, current: null, fetchedAt: expect.any(String) });
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

  describe("現在の打刻のキャッシュ", () => {
    test("取得時刻を添えて返し、期限内に何度開いても Toggl を呼ばない", async () => {
      const { app, ref, calls } = withToggl(currentIs(running("API-1 検索 API")));
      const a = await call(app, "GET", `/api/issues/${ref}/toggl`);
      const b = await call(app, "GET", `/api/issues/${ref}/toggl`);
      expect(a.json.fetchedAt).toBe(NOW);
      expect(b.json).toEqual(a.json);
      expect(callNames(calls)).toEqual(["GET /me/time_entries/current"]);
    });

    test("キャッシュはすべての Issue で共有し、この Issue の打刻かどうかは Issue ごとに決める", async () => {
      const { app, ref, calls, me, ws } = withToggl(currentIs(running("API-1 検索 API")));
      const other = createIssue(me, { workspaceId: ws.id, title: "別の Issue" });
      const mine = await call(app, "GET", `/api/issues/${ref}/toggl`);
      const theirs = await call(app, "GET", `/api/issues/${other.id}/toggl`);
      expect(mine.json.current).toMatchObject({ id: 501, thisIssue: true });
      expect(theirs.json.current).toMatchObject({ id: 501, thisIssue: false });
      expect(theirs.json.fetchedAt).toBe(NOW);
      expect(callNames(calls)).toEqual(["GET /me/time_entries/current"]);
    });

    test("5 分が過ぎたら次の表示で取り直す", async () => {
      const { app, ref, calls, clock } = withToggl(currentIs(null));
      await call(app, "GET", `/api/issues/${ref}/toggl`);
      clock.ms += TOGGL_CACHE_TTL_MS - 1;
      expect((await call(app, "GET", `/api/issues/${ref}/toggl`)).json.fetchedAt).toBe(NOW);
      expect(calls).toHaveLength(1);
      clock.ms += 1;
      const res = await call(app, "GET", `/api/issues/${ref}/toggl`);
      expect(res.json.fetchedAt).toBe(new Date(clock.ms).toISOString());
      expect(callNames(calls)).toEqual(["GET /me/time_entries/current", "GET /me/time_entries/current"]);
    });

    test("「最新にする」は期限内でもキャッシュを無視して取り直し、以後の表示もその結果を使う", async () => {
      const { world, handler } = togglWorld(null);
      const { app, ref, calls, clock } = withToggl(handler);
      await call(app, "GET", `/api/issues/${ref}/toggl`);
      // Toggl 側で打刻が始まった
      world.current = running("外で始めた打刻", 777);
      clock.ms += 60_000;
      expect((await call(app, "GET", `/api/issues/${ref}/toggl`)).json.current).toBeNull();
      const refreshed = await call(app, "POST", `/api/issues/${ref}/toggl/refresh`);
      expect(refreshed.status).toBe(200);
      expect(refreshed.json.current).toMatchObject({ id: 777, thisIssue: false });
      expect(refreshed.json.fetchedAt).toBe(new Date(clock.ms).toISOString());
      expect((await call(app, "GET", `/api/issues/${ref}/toggl`)).json).toEqual(refreshed.json);
      expect(callNames(calls)).toEqual(["GET /me/time_entries/current", "GET /me/time_entries/current"]);
    });

    test("「最新にする」もトークンが未設定なら Toggl を呼ばない", async () => {
      const { app, ref, calls } = withToggl(undefined, { token: null });
      const res = await call(app, "POST", `/api/issues/${ref}/toggl/refresh`);
      expect(res.json).toMatchObject({ configured: false, current: null, fetchedAt: null });
      expect(calls).toEqual([]);
    });

    test("開始・停止の応答でキャッシュを更新し、続く表示では Toggl を呼ばない", async () => {
      const { handler } = togglWorld(null);
      const { app, ref, calls, clock } = withToggl(handler);
      clock.ms += 1000;
      const started = await call(app, "POST", `/api/issues/${ref}/toggl/start`);
      expect(started.json.fetchedAt).toBe(new Date(clock.ms).toISOString());
      expect((await call(app, "GET", `/api/issues/${ref}/toggl`)).json).toEqual(started.json);
      const before = calls.length;
      clock.ms += 1000;
      const stopped = await call(app, "POST", `/api/issues/${ref}/toggl/stop`);
      expect(stopped.json).toMatchObject({ current: null, fetchedAt: new Date(clock.ms).toISOString() });
      expect((await call(app, "GET", `/api/issues/${ref}/toggl`)).json).toEqual(stopped.json);
      // 停止はキャッシュの打刻 ID で行い、直前に取り直さない
      expect(callNames(calls.slice(before))).toEqual(["PATCH /workspaces/77/time_entries/601/stop"]);
    });

    test("切り替えの途中の失敗で取り直した状態もキャッシュに入れる", async () => {
      const { handler } = togglWorld(running("API-10 別の作業"), (req) =>
        req.method === "POST" ? { kind: "ok", status: 500, body: "Internal Server Error" } : undefined,
      );
      const { app, ref, calls } = withToggl(handler);
      const res = await call(app, "POST", `/api/issues/${ref}/toggl/start`);
      expect(res.status).toBe(502);
      const before = calls.length;
      expect((await call(app, "GET", `/api/issues/${ref}/toggl`)).json).toEqual(res.json.error.details.view);
      expect(calls).toHaveLength(before);
    });

    test("開始の直前は期限内でも取り直す", async () => {
      const { world, handler } = togglWorld(null);
      const { app, ref, calls } = withToggl(handler);
      await call(app, "GET", `/api/issues/${ref}/toggl`);
      world.current = running("API-10 別の作業");
      const res = await call(app, "POST", `/api/issues/${ref}/toggl/start`);
      expect(res.status).toBe(200);
      expect(callNames(calls)).toEqual([
        "GET /me/time_entries/current",
        "GET /me/time_entries/current",
        "GET /me",
        "PATCH /workspaces/77/time_entries/501/stop",
        "POST /workspaces/77/time_entries",
      ]);
    });

    test("キャッシュの打刻がほかで止められていたら、停止は競合として取り直した状態を返す（期限切れのキャッシュも ID に使う）", async () => {
      const { world, handler } = togglWorld(running("API-1 検索 API"));
      const { app, ref, calls, clock } = withToggl(handler);
      await call(app, "GET", `/api/issues/${ref}/toggl`);
      // Toggl 側で止められ、別の打刻が始まっていた
      world.current = running("外で始めた打刻", 777);
      clock.ms += TOGGL_CACHE_TTL_MS * 2;
      const res = await call(app, "POST", `/api/issues/${ref}/toggl/stop`);
      expect(res.status).toBe(409);
      expect(res.json.error.code).toBe("TOGGL_CONFLICT");
      expect(res.json.error.details.view.current).toMatchObject({ id: 777, thisIssue: false });
      expect(callNames(calls)).toEqual(["GET /me/time_entries/current", "PATCH /workspaces/77/time_entries/501/stop", "GET /me/time_entries/current"]);
      expect((await call(app, "GET", `/api/issues/${ref}/toggl`)).json).toEqual(res.json.error.details.view);
    });

    test("停止に失敗したら再送せずに取り直し、その状態を返す", async () => {
      for (const [resp, message] of [
        [{ kind: "ok", status: 500, body: null }, "打刻を停止できませんでした（HTTP 500）"],
        [{ kind: "timeout" }, "打刻が止まったかは分かりません（15秒以内に応答がありませんでした）"],
      ] as const) {
        const { handler } = togglWorld(running("API-1 検索 API"), (req) => (req.method === "PATCH" ? resp : undefined));
        const { app, ref, calls } = withToggl(handler);
        await call(app, "GET", `/api/issues/${ref}/toggl`);
        const res = await call(app, "POST", `/api/issues/${ref}/toggl/stop`);
        expect(res.status).toBe(502);
        expect(res.json.error.message).toBe(message);
        expect(res.json.error.details.view.current).toMatchObject({ id: 501, thisIssue: true });
        expect(callNames(calls)).toEqual(["GET /me/time_entries/current", "PATCH /workspaces/77/time_entries/501/stop", "GET /me/time_entries/current"]);
      }
    });

    test("トークンが変わったらキャッシュを捨てて取り直す", async () => {
      const { app, ref, configPath, calls } = withToggl(currentIs(running("API-1 検索 API")));
      await call(app, "GET", `/api/issues/${ref}/toggl`);
      await call(app, "GET", `/api/issues/${ref}/toggl`);
      writeFileSync(configPath, JSON.stringify({ apiToken: "tok-2" }));
      await call(app, "GET", `/api/issues/${ref}/toggl`);
      // 元のトークンに戻しても、別のトークンの結果は使わない
      writeFileSync(configPath, JSON.stringify({ apiToken: "tok-1" }));
      await call(app, "GET", `/api/issues/${ref}/toggl`);
      expect(calls.map((c) => c.token)).toEqual(["tok-1", "tok-2", "tok-1"]);
    });
  });
});
