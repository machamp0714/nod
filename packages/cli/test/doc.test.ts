import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

function setupDocs() {
  const db = tempDb();
  const repo = makeRepo();
  registerRepo(db, repo, "API");
  const docs = tempDir("nod-docs-");
  const nod = (args: string[], actor?: string) => runNod(args, { cwd: repo, db, actor, env: { NOD_DOCS_DIR: docs } });
  return { db, repo, docs, nod };
}

describe("nod doc", () => {
  test("LLM が Issue にリンクした設計メモを作り、双方から参照できる", async () => {
    const { docs, nod } = setupDocs();
    expect((await nod(["issue", "create", "検索を速くする", "--json"])).exitCode).toBe(0);
    const created = await nod(
      ["doc", "create", "design/search.md", "--title", "検索の設計", "--kind", "spec", "--body", "## 目的\n", "--issue", "API-1", "--json"],
      "claude-code",
    );
    expect(created.exitCode).toBe(0);
    expect(created.json).toMatchObject({ path: join(docs, "design", "search.md"), title: "検索の設計", kind: "spec" });
    expect(readFileSync(join(docs, "design", "search.md"), "utf8")).toBe("# 検索の設計\n\n## 目的\n");

    const shown = await nod(["doc", "show", String(created.json.id), "--json"]);
    expect(shown.json).toMatchObject({ issues: [{ id: "API-1", title: "検索を速くする" }], content: "# 検索の設計\n\n## 目的\n" });
    const issue = await nod(["issue", "show", "API-1", "--json"]);
    expect(issue.json.documents).toMatchObject([{ id: created.json.id, attachedBy: "claude-code" }]);

    const text = await nod(["doc", "show", String(created.json.id)]);
    expect(text.stdout).toContain("API-1");
    const list = await nod(["doc", "list"]);
    expect(list.stdout).toContain("検索の設計");
    expect(list.stdout).toContain("API-1");
  });

  test("Document 側からリンク・解除でき、Issue の Activity に残る", async () => {
    const { nod } = setupDocs();
    await nod(["issue", "create", "a"]);
    await nod(["issue", "create", "b"]);
    const id = String((await nod(["doc", "create", "x.md", "--json"])).json.id);
    expect((await nod(["doc", "link", id, "--issue", "API-2"], "codex")).exitCode).toBe(0);
    expect((await nod(["doc", "show", id, "--json"])).json.issues.map((i: { id: string }) => i.id)).toEqual(["API-2"]);
    const unlinked = await nod(["doc", "unlink", id, "--issue", "API-2", "--json"], "codex");
    expect(unlinked.exitCode).toBe(0);
    const activity = (await nod(["issue", "show", "API-2", "--json"])).json.activity.map((a: { type?: string }) => a.type);
    expect(activity).toContain("document_attached");
    expect(activity).toContain("document_detached");
    const again = await nod(["doc", "unlink", id, "--issue", "API-2", "--json"]);
    expect(again.exitCode).not.toBe(0);
    expect(again.json.error.code).toBe("NOT_FOUND");
    const both = await nod(["doc", "link", id, "--json"]);
    expect(both.json.error.code).toBe("INVALID_ARGS");
  });

  test("ルートの外・既存ファイルは拒否し、ファイルを書き換えない", async () => {
    const { docs, nod } = setupDocs();
    for (const path of ["../x.md", "/tmp/x.md", "x.txt"]) {
      const r = await nod(["doc", "create", path, "--json"]);
      expect(r.exitCode).not.toBe(0);
      expect(r.json.error.code).toBe("INVALID_ARGS");
    }
    writeFileSync(join(docs, "x.md"), "元\n");
    const r = await nod(["doc", "create", "x.md", "--json"]);
    expect(r.json.error.code).toBe("FILE_EXISTS");
    expect(readFileSync(join(docs, "x.md"), "utf8")).toBe("元\n");
    const missing = await nod(["doc", "create", "y.md", "--issue", "API-9", "--json"]);
    expect(missing.json.error.code).toBe("NOT_FOUND");
    expect(existsSync(join(docs, "y.md"))).toBe(false);
  });

  test("--body - で標準入力の本文を使う", async () => {
    const { db, repo, docs } = setupDocs();
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), "doc", "create", "s.md", "--title", "S", "--body", "-"], {
      cwd: repo,
      env: { ...process.env, NOD_DB: db, NOD_ORCA: "0", NOD_DOCS_DIR: docs },
      stdin: new Blob(["本文です\n"]),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    expect(readFileSync(join(docs, "s.md"), "utf8")).toBe("# S\n\n本文です\n");
  });
});
