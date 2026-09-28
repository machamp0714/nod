import { beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

let db: string;
let repo: string;

beforeAll(() => {
  db = tempDb();
  repo = makeRepo();
  registerRepo(db, repo);
});

const me = (args: string[], cwd = repo) => runNod([...args, "--json"], { cwd, db });

describe("nod template", () => {
  test("ファイルから登録し、一覧、表示、置き換え、削除ができる", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "bug.md"), "## 再現手順\n");
    expect((await me(["template", "add", "bug", "--from", "bug.md"], dir)).json).toMatchObject({
      created: true,
      template: { name: "bug", body: "## 再現手順\n" },
    });
    writeFileSync(join(dir, "bug.md"), "## 再現手順\n\n## 期待する動作\n");
    expect((await me(["template", "add", "bug", "--from", "bug.md"], dir)).json.created).toBe(false);
    expect((await me(["template", "list"])).json.map((t: { name: string }) => t.name)).toEqual(["bug"]);
    expect((await runNod(["template", "show", "bug"], { cwd: repo, db })).stdout).toContain("## 期待する動作");
    expect((await me(["template", "add", "x", "--from", "none.md"], dir)).json.error.code).toBe("FILE_NOT_FOUND");
    expect((await me(["template", "remove", "bug"])).exitCode).toBe(0);
    expect((await me(["template", "show", "bug"])).json.error.code).toBe("NOT_FOUND");
  });

  test("issue create --template で説明の初期値にし、-d と同時なら INVALID_ARGS", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "feature.md"), "## 目的\n");
    await me(["template", "add", "feature", "--from", join(dir, "feature.md")]);
    expect((await me(["issue", "create", "検索を足す", "--template", "feature"])).json.description).toBe("## 目的\n");
    expect((await me(["issue", "create", "t", "--template", "feature", "-d", "x"])).json.error.code).toBe("INVALID_ARGS");
    expect((await me(["issue", "create", "t", "--template", "none"])).json.error.code).toBe("NOT_FOUND");
  });

  test("手引きに --template の使い方がある", async () => {
    expect((await runNod(["skills", "get", "nod"], { cwd: repo, db })).stdout).toContain("--template");
  });
});
