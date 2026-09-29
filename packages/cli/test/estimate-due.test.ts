import { beforeAll, describe, expect, test } from "bun:test";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

let db: string;
let repo: string;
beforeAll(() => {
  db = tempDb();
  repo = makeRepo();
  registerRepo(db, repo);
});

const llm = (args: string[]) => runNod(args, { cwd: repo, db, actor: "claude-code" });
const me = (args: string[]) => runNod(args, { cwd: repo, db });

describe("nod issue の見積もりと期限", () => {
  test("起票時に --estimate と --due を設定でき、show に出る", async () => {
    const created = await me(["issue", "create", "--json", "--estimate", "3", "--due", "2026-10-01", "見積もり付き"]);
    expect(created.exitCode).toBe(0);
    expect(created.json).toMatchObject({ estimate: 3, dueDate: "2026-10-01" });
    const shown = await me(["issue", "show", created.json.id]);
    expect(shown.stdout).toContain("見積もり: 3 pt");
    expect(shown.stdout).toContain("期限: 2026-10-01");
  });

  test("LLM も update で設定・変更し、空文字で解除できる", async () => {
    const { id } = (await llm(["issue", "create", "--json", "LLM の見積もり"])).json;
    const set = await llm(["issue", "update", id, "--json", "--estimate", "5", "--due", "2026-12-31"]);
    expect(set.json).toMatchObject({ estimate: 5, dueDate: "2026-12-31" });
    const cleared = await llm(["issue", "update", id, "--json", "--estimate", "", "--due", ""]);
    expect(cleared.json).toMatchObject({ estimate: null, dueDate: null });
    const shown = await llm(["issue", "show", id]);
    expect(shown.stdout).not.toContain("見積もり:");
    expect(shown.stdout).not.toContain("期限:");
  });

  test("範囲外の見積もりや不正な期限は INVALID_ARGS で終了コード 1", async () => {
    const { id } = (await me(["issue", "create", "--json", "不正値"])).json;
    for (const args of [["--estimate", "0"], ["--estimate", "101"], ["--estimate", "1.5"], ["--estimate", "abc"], ["--due", "2026-02-30"], ["--due", "2026-10-01T09:00"]]) {
      const r = await me(["issue", "update", id, "--json", ...args]);
      expect(r.exitCode).toBe(1);
      expect(r.json.error.code).toBe("INVALID_ARGS");
    }
    const r = await me(["issue", "create", "--json", "--estimate", "0", "起票されない"]);
    expect(r.json.error.code).toBe("INVALID_ARGS");
  });
});
