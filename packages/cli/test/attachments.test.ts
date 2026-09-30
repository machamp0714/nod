import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GUIDE } from "../src/guide";
import { makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

function setupAttachments() {
  const db = tempDb();
  const repo = makeRepo();
  registerRepo(db, repo, "API");
  const root = join(tempDir("nod-attachments-"), "root");
  const nod = (args: string[], actor?: string) => runNod(args, { cwd: repo, db, actor, env: { NOD_ATTACHMENTS_DIR: root } });
  return { repo, root, nod };
}

describe("nod issue attach", () => {
  test("LLM がリンクとファイルを添付し、一覧・詳細で確かめ、削除できる", async () => {
    const { repo, root, nod } = setupAttachments();
    await nod(["issue", "create", "添付の対象"]);
    writeFileSync(join(repo, "result.log"), "ok\n");

    const link = await nod(["issue", "attach", "add", "API-1", "--url", "https://example.com/spec", "--title", "仕様", "--json"], "claude-code");
    expect(link.exitCode).toBe(0);
    expect(link.json).toMatchObject({ kind: "link", url: "https://example.com/spec", title: "仕様", createdBy: "claude-code" });
    const file = await nod(["issue", "attach", "add", "API-1", "--file", "result.log", "--json"], "claude-code");
    expect(file.exitCode).toBe(0);
    expect(file.json).toMatchObject({ kind: "file", fileName: "result.log", size: 3, mime: "text/plain; charset=utf-8" });
    expect(readdirSync(root)).toHaveLength(1);

    const list = await nod(["issue", "attach", "list", "API-1"]);
    expect(list.stdout).toContain(`${link.json.id}  仕様  https://example.com/spec`);
    expect(list.stdout).toContain(`${file.json.id}  result.log  3 B`);
    const shown = await nod(["issue", "show", "API-1"]);
    expect(shown.stdout).toContain("添付:");
    expect(shown.stdout).toContain("仕様");
    expect((await nod(["issue", "show", "API-1", "--json"])).json.attachments).toHaveLength(2);

    expect((await nod(["issue", "attach", "remove", "API-1", String(file.json.id)], "claude-code")).exitCode).toBe(0);
    expect(readdirSync(root)).toEqual([]);
    expect((await nod(["issue", "attach", "list", "API-1", "--json"])).json).toMatchObject([{ id: link.json.id }]);
  });

  test("--url と --file はどちらか一方。危険な URL・symlink・無い添付はエラーコードを返す", async () => {
    const { repo, root, nod } = setupAttachments();
    await nod(["issue", "create", "a"]);
    writeFileSync(join(repo, "a.txt"), "x");
    symlinkSync(join(repo, "a.txt"), join(repo, "link.txt"));
    const code = async (args: string[]) => (await nod([...args, "--json"])).json?.error?.code;
    expect(await code(["issue", "attach", "add", "API-1"])).toBe("INVALID_ARGS");
    expect(await code(["issue", "attach", "add", "API-1", "--url", "https://e.com", "--file", "a.txt"])).toBe("INVALID_ARGS");
    expect(await code(["issue", "attach", "add", "API-1", "--url", "javascript:alert(1)"])).toBe("INVALID_ARGS");
    expect(await code(["issue", "attach", "add", "API-1", "--file", "link.txt"])).toBe("INVALID_ARGS");
    expect(await code(["issue", "attach", "add", "API-1", "--file", "none.txt"])).toBe("FILE_NOT_FOUND");
    expect(await code(["issue", "attach", "remove", "API-1", "9"])).toBe("NOT_FOUND");
    expect(await code(["issue", "attach", "remove", "API-1", "x"])).toBe("INVALID_ARGS");
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
  });

  test("アーカイブ中は追加できない", async () => {
    const { nod } = setupAttachments();
    await nod(["issue", "create", "a"]);
    await nod(["issue", "archive", "API-1"]);
    const r = await nod(["issue", "attach", "add", "API-1", "--url", "https://e.com", "--json"]);
    expect(r.json.error.code).toBe("ISSUE_ARCHIVED");
  });
});

describe("nod attachments gc と Workspace の削除", () => {
  test("gc は参照されないディレクトリだけを消し、--dry-run では消さない。Workspace の削除で添付ファイルも消える", async () => {
    const { repo, root, nod } = setupAttachments();
    await nod(["issue", "create", "a"]);
    writeFileSync(join(repo, "a.txt"), "x");
    expect((await nod(["issue", "attach", "add", "API-1", "--file", "a.txt"])).exitCode).toBe(0);
    const orphan = "00000000-0000-4000-8000-000000000000";
    mkdirSync(join(root, orphan));
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(join(root, orphan), old, old);

    const dry = await nod(["attachments", "gc", "--dry-run", "--json"]);
    expect(dry.json).toMatchObject({ removed: [orphan], dryRun: true });
    expect(existsSync(join(root, orphan))).toBe(true);
    const run = await nod(["attachments", "gc"]);
    expect(run.stdout).toContain("1 件を消しました");
    expect(readdirSync(root)).toHaveLength(1);

    expect((await nod(["workspace", "remove", "API", "--yes"])).exitCode).toBe(0);
    expect(readdirSync(root)).toEqual([]);
  });

  test("LLM は録画（mp4・webm）を Workspace の中から添付できる", async () => {
    const { repo, nod } = setupAttachments();
    await nod(["issue", "create", "録画の対象"]);
    writeFileSync(join(repo, "demo.mp4"), "MP4");
    writeFileSync(join(repo, "demo.webm"), "WEBM");
    const mp4 = await nod(["issue", "attach", "add", "API-1", "--file", "demo.mp4", "--json"], "claude-code");
    expect(mp4.json).toMatchObject({ kind: "file", fileName: "demo.mp4", mime: "video/mp4" });
    const webm = await nod(["issue", "attach", "add", "API-1", "--file", "demo.webm", "--json"], "claude-code");
    expect(webm.json).toMatchObject({ kind: "file", fileName: "demo.webm", mime: "video/webm" });
  });

  test(". で始まるディレクトリの中のファイルは添付できない", async () => {
    const { repo, root, nod } = setupAttachments();
    await nod(["issue", "create", "a"]);
    mkdirSync(join(repo, ".secrets"));
    writeFileSync(join(repo, ".secrets", "token.txt"), "x");
    expect((await nod(["issue", "attach", "add", "API-1", "--file", ".secrets/token.txt", "--json"])).json.error.code).toBe("INVALID_ARGS");
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
  });
});

test("手引きに添付の使い方と Document との使い分けを書く", () => {
  expect(GUIDE).toContain("nod issue attach add <id> --url");
  expect(GUIDE).toContain("nod issue attach add <id> --file");
  expect(GUIDE).toContain("nod issue attach remove");
  expect(GUIDE).toContain("NOD_ATTACHMENTS_DIR");
  expect(GUIDE).toContain("登録済み Workspace か OS の一時ディレクトリの下");
  expect(GUIDE).toContain("mp4/webm は 100MB まで");
});
