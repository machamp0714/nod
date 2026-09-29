import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

test("リマインダーを CLI で設定・一覧・解除でき、期限が来ると通知に出る。LLM は設定できない", async () => {
  const db = tempDb();
  const repo = makeRepo();
  registerRepo(db, repo, "API");
  const nod = (args: string[], actor = "me") => runNod(args, { cwd: repo, db, actor });
  await nod(["issue", "create", "検索", "--json"]);

  const denied = await nod(["issue", "remind", "API-1", "--at", "2999-01-01", "--json"], "claude-code");
  expect(denied.json.error.code).toBe("FORBIDDEN_FOR_LLM");
  const past = await nod(["issue", "remind", "API-1", "--at", "2000-01-01", "--json"]);
  expect(past.json.error.code).toBe("INVALID_ARGS");
  const noAt = await nod(["issue", "remind", "API-1", "--json"]);
  expect(noAt.json.error.code).toBe("INVALID_ARGS");
  const both = await nod(["issue", "remind", "API-1", "--clear", "--at", "2999-01-01", "--json"]);
  expect(both.json.error.code).toBe("INVALID_ARGS");

  const set = await nod(["issue", "remind", "API-1", "--at", "2999-01-01T09:00:00Z", "--note", "レビューを見る"]);
  expect(set.exitCode).toBe(0);
  expect(set.stdout.trim()).toBe("API-1 に 2999-01-01T09:00:00.000Z のリマインダーを設定しました: レビューを見る");
  expect((await nod(["issue", "show", "API-1"])).stdout).toContain("リマインダー: 2999-01-01T09:00:00.000Z  レビューを見る");
  const list = await nod(["reminder", "list", "--json"]);
  expect(list.json).toHaveLength(1);
  expect(list.json[0]).toMatchObject({ issueId: "API-1", note: "レビューを見る" });

  const raw = new Database(db);
  raw.query("UPDATE reminders SET remind_at = '2000-01-01T00:00:00.000Z'").run();
  raw.close();
  const inbox = await nod(["inbox"]);
  expect(inbox.stdout).toContain("通知（未読 1）");
  expect(inbox.stdout).toContain("リマインダー: レビューを見る");
  expect((await nod(["reminder", "list"])).stdout.trim()).toBe("リマインダーはありません");

  await nod(["issue", "remind", "API-1", "--at", "2999-01-01"]);
  expect((await nod(["issue", "remind", "API-1", "--clear"])).stdout.trim()).toBe("API-1 のリマインダーを解除しました");
  expect((await nod(["issue", "remind", "API-1", "--clear"])).stdout.trim()).toBe("API-1 にリマインダーはありません");
});
