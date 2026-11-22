import { beforeAll, describe, expect, test } from "bun:test";
import { openDb } from "@nod/core";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

let db: string;
let repo: string;

beforeAll(() => {
  db = tempDb();
  repo = makeRepo();
  registerRepo(db, repo, "TS");
});

const json = (args: string[]) => runNod([...args, "--json"], { cwd: repo, db });
const create = async (title: string) => {
  const result = await json(["issue", "create", title]);
  expect(result.exitCode).toBe(0);
  return result.json.id as string;
};
const show = async (id: string) => {
  const result = await json(["issue", "show", id]);
  expect(result.exitCode).toBe(0);
  return result.json;
};

describe("issue relate", () => {
  test("同じ相手への blocks と related を1回で追加して JSON と後続の show に返す", async () => {
    const source = await create("起点");
    const target = await create("相手");
    const result = await json(["issue", "relate", source, "--blocks", target, "--related", target]);
    expect(result.exitCode).toBe(0);
    expect(result.json.relations).toMatchObject({ blocks: [target], related: [target] });
    const detail = await show(source);
    expect(detail.relations).toEqual(result.json.relations);
    expect(detail.activity.filter((a: { type: string }) => a.type === "relation_added")).toMatchObject([
      { type: "relation_added", data: { type: "blocks", to: target } },
      { type: "relation_added", data: { type: "related", to: target } },
    ]);
    expect((await show(target)).relations).toMatchObject({ blockedBy: [source], related: [source] });
  });

  test("有効な blocks と併用しても明示した空文字の related は INVALID_ARGS で無変更", async () => {
    const source = await create("空文字の起点");
    const target = await create("空文字の相手");
    const before = await show(source);
    const result = await json(["issue", "relate", source, "--blocks", target, "--related", ""]);
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ error: { code: "INVALID_ARGS", message: expect.any(String) } });
    const after = await show(source);
    expect(after.relations).toEqual(before.relations);
    expect(after.activity).toEqual(before.activity);
  });

  test("異なる相手への同時追加を従来のテキスト形式と後続の JSON に表示する", async () => {
    const source = await create("別々の起点");
    const blocked = await create("ブロックする相手");
    const related = await create("関連する相手");
    const result = await runNod(["issue", "relate", source, "--blocks", blocked, "--related", related], { cwd: repo, db });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`  ブロックしている: ${blocked}\n`);
    expect(result.stdout).toContain(`  関連: ${related}\n`);
    expect((await show(source)).relations).toMatchObject({ blocks: [blocked], related: [related] });
  });

  for (const existing of ["--blocks", "--related"]) {
    test(`${existing} が既存なら不足分だけ記録し、両方の再実行は Activity も増やさない`, async () => {
      const source = await create("再実行の起点");
      const target = await create("再実行の相手");
      expect((await json(["issue", "relate", source, existing, target])).exitCode).toBe(0);
      const before = await show(source);
      const args = ["issue", "relate", source, "--blocks", target, "--related", target];
      expect((await json(args)).exitCode).toBe(0);
      const added = await show(source);
      expect(added.relations).toMatchObject({ blocks: [target], related: [target] });
      expect(added.activity.filter((a: { type: string }) => a.type === "relation_added")).toMatchObject([
        { data: { type: existing === "--blocks" ? "blocks" : "related", to: target } },
        { data: { type: existing === "--blocks" ? "related" : "blocks", to: target } },
      ]);
      expect(added.activity.slice(0, before.activity.length)).toEqual(before.activity);
      const rerun = await json(args);
      expect(rerun.exitCode).toBe(0);
      expect(rerun.json.relations).toEqual(added.relations);
      expect(rerun.json.activity).toEqual(added.activity);
      const after = await show(source);
      expect(after.relations).toEqual(added.relations);
      expect(after.activity).toEqual(added.activity);
    });
  }

  for (const option of ["--blocks", "--related", "--duplicate-of"]) {
    test(`${option} の単独指定を維持する`, async () => {
      const source = await create("単独の起点");
      const target = await create("単独の相手");
      const result = await json(["issue", "relate", source, option, target]);
      expect(result.exitCode).toBe(0);
      const key = option === "--blocks" ? "blocks" : option === "--related" ? "related" : "duplicateOf";
      expect(result.json.relations[key]).toEqual([target]);
      expect((await show(source)).relations[key]).toEqual([target]);
    });
  }

  for (const invalidOption of ["--blocks", "--related"]) {
    for (const invalid of ["missing", "archived", "self"]) {
      test(`${invalidOption} の相手が ${invalid} なら全新規関係と Activity を取り消し既存を保持する`, async () => {
        const source = await create("失敗の起点");
        const existing = await create("既存の相手");
        const valid = await create("追加されない相手");
        expect((await json(["issue", "relate", source, "--related", existing])).exitCode).toBe(0);
        let target = invalid === "self" ? source : "TS-999999";
        if (invalid === "archived") {
          target = await create("アーカイブ済み");
          expect((await json(["issue", "archive", target])).exitCode).toBe(0);
        }
        const before = await show(source);
        const validBefore = await show(valid);
        const result = await json([
          "issue", "relate", source,
          "--blocks", invalidOption === "--blocks" ? target : valid,
          "--related", invalidOption === "--related" ? target : valid,
        ]);
        expect(result.exitCode).toBe(1);
        expect(result.json).toMatchObject({ error: {
          code: invalid === "missing" ? "NOT_FOUND" : invalid === "archived" ? "ISSUE_ARCHIVED" : "INVALID_ARGS",
          message: expect.any(String),
        } });
        const after = await show(source);
        expect(after.relations).toEqual(before.relations);
        expect(after.activity).toEqual(before.activity);
        const validAfter = await show(valid);
        expect(validAfter.relations).toEqual(validBefore.relations);
        expect(validAfter.activity).toEqual(validBefore.activity);
      });
    }
  }

  for (const failure of ["relation", "activity"]) {
    test(`2件目の ${failure} 登録が失敗しても関係と Activity の全新規書込みを取り消す`, async () => {
      const source = await create("登録失敗の起点");
      const existing = await create("保持する相手");
      const target = await create("登録失敗の相手");
      expect((await json(["issue", "relate", source, "--related", existing])).exitCode).toBe(0);
      const before = await show(source);
      const targetBefore = await show(target);
      // 一時 DB の書込み障害を設定し、結果は実 CLI と後続の show だけで観測する。
      const database = openDb(db);
      database.exec(failure === "relation"
        ? `CREATE TRIGGER fail_related BEFORE INSERT ON relations
            WHEN NEW.type = 'related'
            BEGIN SELECT RAISE(ABORT, 'relation unavailable'); END`
        : `CREATE TRIGGER fail_related BEFORE INSERT ON events
            WHEN NEW.type = 'relation_added' AND json_extract(NEW.data, '$.type') = 'related'
            BEGIN SELECT RAISE(ABORT, 'relation activity unavailable'); END`);
      database.close();
      try {
        const result = await json(["issue", "relate", source, "--blocks", target, "--related", target]);
        expect(result.exitCode).toBe(1);
        expect(result.json).toEqual({ error: {
          code: "UNEXPECTED",
          message: failure === "relation" ? "relation unavailable" : "relation activity unavailable",
        } });
        const after = await show(source);
        expect(after.relations).toEqual(before.relations);
        expect(after.activity).toEqual(before.activity);
        const targetAfter = await show(target);
        expect(targetAfter.relations).toEqual(targetBefore.relations);
        expect(targetAfter.activity).toEqual(targetBefore.activity);
      } finally {
        const cleanup = openDb(db);
        cleanup.exec("DROP TRIGGER fail_related");
        cleanup.close();
      }
    });
  }

  test("指定なし、duplicate-of の混在、各オプションの空文字を INVALID_ARGS で無変更にする", async () => {
    const source = await create("不正な指定の起点");
    const target = await create("不正な指定の相手");
    expect((await json(["issue", "relate", source, "--related", target])).exitCode).toBe(0);
    const before = await show(source);
    const invalidArgs = [
      [],
      ["--blocks", target, "--duplicate-of", target],
      ["--related", target, "--duplicate-of", target],
      ["--blocks", target, "--related", target, "--duplicate-of", target],
      ["--blocks", ""],
      ["--related", ""],
      ["--duplicate-of", ""],
      ["--blocks", "", "--related", target],
      ["--blocks", target, "--duplicate-of", ""],
      ["--related", target, "--duplicate-of", ""],
      ["--blocks", "", "--duplicate-of", target],
      ["--related", "", "--duplicate-of", target],
    ];
    for (const args of invalidArgs) {
      const result = await json(["issue", "relate", source, ...args]);
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({ error: { code: "INVALID_ARGS", message: expect.any(String) } });
      const after = await show(source);
      expect(after.relations).toEqual(before.relations);
      expect(after.activity).toEqual(before.activity);
    }
    const text = await runNod(["issue", "relate", source], { cwd: repo, db });
    expect(text.exitCode).toBe(1);
    expect(text.stderr).toContain("INVALID_ARGS");
    expect(text.stderr).toContain("併用可");
  });
});
