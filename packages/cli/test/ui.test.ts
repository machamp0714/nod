import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type NodServer, startServer } from "@nod/server";
import { openCommand } from "../src/browser";
import { defaultWebDir, startUi, type UiStarted } from "../src/ui";
import { tempDb, tempDir } from "./helpers";

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
