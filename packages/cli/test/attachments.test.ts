import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
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

test("手引きに添付の使い方と Document との使い分けを書く", () => {
  expect(GUIDE).toContain("nod issue attach add <id> --url");
  expect(GUIDE).toContain("nod issue attach add <id> --file");
  expect(GUIDE).toContain("nod issue attach remove");
  expect(GUIDE).toContain("NOD_ATTACHMENTS_DIR");
});
