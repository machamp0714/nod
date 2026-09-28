import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type NodServer, startServer } from "@nod/server";
import { openCommand } from "../src/browser";
import { defaultWebDir, startUi, type UiStarted } from "../src/ui";
import { runNod, tempDb, tempDir } from "./helpers";

// index.html を持つ、ビルド済みの web の代わりのディレクトリを作る
function webDist(): string {
  const dist = join(tempDir("nod-web-"), "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><div id=root></div>");
  return dist;
}

// 開こうとした URL を記録する、ブラウザの代わり
function fakeOpener(result = true) {
  const urls: string[] = [];
  return {
    urls,
    deps: {
      openBrowser: async (url: string) => {
        urls.push(url);
        return result;
      },
    },
  };
}

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

function track(ui: UiStarted): UiStarted {
  if (ui.server) {
    const server = ui.server;
    stops.push(() => server.stop());
  }
  return ui;
}

function trackServer(server: NodServer): NodServer {
  stops.push(() => server.stop());
  return server;
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

describe("openCommand", () => {
  test("OS ごとにブラウザを開くコマンドを返す", () => {
    const url = "http://127.0.0.1:4700/";
    expect(openCommand(url, "darwin", {})).toEqual(["open", url]);
    expect(openCommand(url, "win32", {})).toEqual(["cmd", "/c", "start", "", url]);
    expect(openCommand(url, "linux", {})).toEqual(["xdg-open", url]);
  });

  test("BROWSER があればそれで開く", () => {
    const url = "http://127.0.0.1:4700/";
    expect(openCommand(url, "darwin", { BROWSER: "/usr/bin/firefox" })).toEqual(["/usr/bin/firefox", url]);
    expect(openCommand(url, "linux", { BROWSER: "" })).toEqual(["xdg-open", url]);
  });
});

describe("defaultWebDir", () => {
  test("リポジトリの packages/web/dist を指す", () => {
    expect(defaultWebDir()).toBe(resolve(import.meta.dir, "../../web/dist"));
  });
});

describe("startUi", () => {
  test("web を配信する server を起動し、/ をブラウザで開く", async () => {
    const webDir = webDist();
    const dbPath = tempDb();
    const opener = fakeOpener();
    const ui = track(await startUi({ port: 0, webDir, dbPath, open: true }, opener.deps));
    expect(ui.reused).toBe(false);
    expect(ui.opened).toBe(true);
    expect(ui.dbPath).toBe(dbPath);
    expect(ui.webDir).toBe(webDir);
    expect(ui.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(opener.urls).toEqual([ui.url]);
    const page = await fetch(`${ui.url}inbox`);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("id=root");
    expect(await (await fetch(`${ui.url}api/workspaces`)).json()).toEqual([]);
  });

  test("open: false ならブラウザを開かない", async () => {
    const opener = fakeOpener();
    const ui = track(await startUi({ port: 0, webDir: webDist(), dbPath: tempDb(), open: false }, opener.deps));
    expect(ui.opened).toBe(false);
    expect(opener.urls).toEqual([]);
  });

  test("ブラウザを開けなくても server は動いたまま", async () => {
    const opener = fakeOpener(false);
    const ui = track(await startUi({ port: 0, webDir: webDist(), dbPath: tempDb(), open: true }, opener.deps));
    expect(ui.opened).toBe(false);
    expect((await fetch(`${ui.url}api/workspaces`)).status).toBe(200);
  });

  test("index.html がなければ WEB_NOT_BUILT。server を起動せず、ブラウザも開かない", async () => {
    const opener = fakeOpener();
    const empty = tempDir("nod-web-");
    const code = await codeOf(startUi({ port: 0, webDir: empty, dbPath: tempDb(), open: true }, opener.deps));
    expect(code).toBe("WEB_NOT_BUILT");
    expect(opener.urls).toEqual([]);
  });

  test("ポートで nod ui が動いていれば、新しく起動せずにそれを開く", async () => {
    const first = trackServer(startServer({ port: 0, dbPath: tempDb(), staticDir: webDist() }));
    const opener = fakeOpener();
    const ui = await startUi({ port: first.port, webDir: webDist(), dbPath: tempDb(), open: true }, opener.deps);
    expect(ui.reused).toBe(true);
    expect(ui.server).toBeNull();
    expect(ui.dbPath).toBeNull();
    expect(ui.url).toBe(`${first.url}/`);
    expect(opener.urls).toEqual([`${first.url}/`]);
  });

  test("ほかのプログラムや API だけの server がポートを使っていれば PORT_IN_USE。ブラウザは開かない", async () => {
    const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("other") });
    stops.push(() => other.stop(true));
    const apiOnly = trackServer(startServer({ port: 0, dbPath: tempDb() }));
    for (const port of [Number(other.url.port), apiOnly.port]) {
      const opener = fakeOpener();
      const code = await codeOf(startUi({ port, webDir: webDist(), dbPath: tempDb(), open: true }, opener.deps));
      expect([port, code]).toEqual([port, "PORT_IN_USE"]);
      expect(opener.urls).toEqual([]);
    }
  });
});

const MAIN = join(import.meta.dir, "../src/main.ts");
const URL_RE = /http:\/\/127\.0\.0\.1:\d+\//;

// 標準出力を、正規表現に合う文字列が出るまで（最長 timeoutMs）読む
async function readUntil(stream: ReadableStream<Uint8Array>, re: RegExp, timeoutMs = 10000): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (!re.test(text)) {
    const wait = Math.max(0, deadline - Date.now());
    const chunk = await Promise.race([reader.read(), Bun.sleep(wait).then(() => null)]);
    if (!chunk || chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  reader.releaseLock();
  return text;
}

// BROWSER を実在しないパスにして、テストで本物のブラウザを開かないようにする
function spawnUi(args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NOD_DB: tempDb(),
    NOD_ORCA: "0",
    CLAUDECODE: undefined,
    BROWSER: "/nonexistent/browser",
    ...extraEnv,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return Bun.spawn(["bun", MAIN, "ui", ...args], { cwd: tempDir(), env, stdout: "pipe", stderr: "pipe" });
}

describe("nod ui", () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`URL を出して待ち、SSE がつながっていても ${signal} で止まる`, async () => {
      const proc = spawnUi(["--port", "0", "--no-open", "--web-dir", webDist()]);
      try {
        const out = await readUntil(proc.stdout, URL_RE);
        expect(out).toContain("止めるには Ctrl+C を押してください");
        const url = URL_RE.exec(out)?.[0] ?? "";
        expect(url).not.toBe("");
        expect(await (await fetch(`${url}issues/API-1`)).text()).toContain("id=root");
        const events = await fetch(`${url}api/events`);
        expect(events.headers.get("content-type")).toContain("text/event-stream");
        proc.kill(signal);
        expect(await proc.exited).toBe(0);
        await events.body?.cancel().catch(() => {});
        const closed = await fetch(`${url}api/workspaces`).then(
          () => false,
          () => true,
        );
        expect(closed).toBe(true);
      } finally {
        proc.kill("SIGKILL");
      }
    });
  }

  test("--json で URL と DB の場所を出す", async () => {
    const webDir = webDist();
    const proc = spawnUi(["--port", "0", "--no-open", "--web-dir", webDir, "--json"]);
    try {
      const out = await readUntil(proc.stdout, /\}\s*$/);
      const info = JSON.parse(out);
      expect(info).toMatchObject({ reused: false, opened: false, webDir });
      expect(info.url).toMatch(URL_RE);
      expect(info.dbPath).toEndWith("nod.db");
      expect(info.server).toBeUndefined();
    } finally {
      proc.kill("SIGINT");
      await proc.exited;
    }
  });

  test("web がビルドされていなければ WEB_NOT_BUILT で終了コード 1", async () => {
    const empty = tempDir("nod-web-");
    const r = await runNod(["ui", "--port", "0", "--no-open", "--web-dir", empty, "--json"], { cwd: tempDir(), db: tempDb() });
    expect(r.exitCode).toBe(1);
    expect(r.json.error.code).toBe("WEB_NOT_BUILT");
    const text = await runNod(["ui", "--port", "0", "--no-open", "--web-dir", empty], { cwd: tempDir(), db: tempDb() });
    expect(text.exitCode).toBe(1);
    expect(text.stderr).toContain("bun run web:build");
  });

  test("ポートの指定の誤りは INVALID_ARGS", async () => {
    for (const port of ["abc", "-1", "65536", "80.5"]) {
      const r = await runNod(["ui", "--port", port, "--no-open", "--web-dir", webDist(), "--json"], {
        cwd: tempDir(),
        db: tempDb(),
      });
      expect([port, r.exitCode, r.json?.error?.code]).toEqual([port, 1, "INVALID_ARGS"]);
    }
  });

  test("ブラウザを開けなければ、標準エラーに URL を案内して動き続ける", async () => {
    // spawnUi は BROWSER を実在しないパスにするため、--no-open を付けなければ開くのに失敗する
    const proc = spawnUi(["--port", "0", "--web-dir", webDist()]);
    try {
      const err = await readUntil(proc.stderr, /開いてください/);
      expect(err).toMatch(new RegExp(`ブラウザを開けませんでした。${URL_RE.source} を開いてください`));
      const url = URL_RE.exec(err)?.[0] ?? "";
      expect((await fetch(`${url}api/workspaces`)).status).toBe(200);
    } finally {
      proc.kill("SIGINT");
      expect(await proc.exited).toBe(0);
    }
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`ブラウザの起動待ち中でも ${signal} で速やかに正常終了する`, async () => {
    const browser = join(tempDir(), "browser");
    writeFileSync(browser, '#!/bin/sh\necho "起動待ち" > "$NOD_BROWSER_MARKER"\nexec sleep 4\n', { mode: 0o755 });
    const marker = join(tempDir(), "started");
    const proc = spawnUi(["--port", "0", "--web-dir", webDist()], { BROWSER: browser, NOD_BROWSER_MARKER: marker });
    try {
      const deadline = Date.now() + 3000;
      while (!(await Bun.file(marker).exists()) && Date.now() < deadline) await Bun.sleep(10);
      expect(await Bun.file(marker).exists()).toBe(true);
      proc.kill(signal);
      expect(await Promise.race([proc.exited, Bun.sleep(1000).then(() => "timeout")])).toBe(0);
    } finally {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  });
}
