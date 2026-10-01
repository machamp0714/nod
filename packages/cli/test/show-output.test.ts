import { beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "@nod/core";
import { makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

let db: string;
let repo: string;

beforeAll(() => {
  db = tempDb();
  repo = makeRepo();
  registerRepo(db, repo);
});

const me = (args: string[]) => runNod([...args, "--json"], { cwd: repo, db });
const llm = (args: string[]) => runNod([...args, "--json"], { cwd: repo, db, actor: "claude-code" });
const show = async (id: string, tz: string) => (await runNod(["issue", "show", id], { cwd: repo, db, env: { TZ: tz } })).stdout;

// 記録時刻（UTC の ISO）を、時差（分）だけずらした YYYY-MM-DD HH:mm にする
function shifted(iso: string, offsetMinutes: number): string {
  return new Date(new Date(iso).getTime() + offsetMinutes * 60_000).toISOString().slice(0, 16).replace("T", " ");
}

const TOKYO = 9 * 60;

// 同じコマンドのテキスト出力を TZ ごとに取る
async function texts(args: string[], actor?: string): Promise<{ utc: string; tokyo: string }> {
  const run = async (tz: string) => (await runNod(args, { cwd: repo, db, actor, env: { TZ: tz } })).stdout;
  return { utc: await run("UTC"), tokyo: await run("Asia/Tokyo") };
}

describe("issue show の Activity（#168）", () => {
  test("確認依頼は整形済みの1行だけを出し、生の question_asked・question_answered を出さない", async () => {
    const id = (await me(["issue", "create", "redoc を公開する"])).json.id;
    await me(["issue", "ask", id, "公開ルートはどれか"]);
    const open = await show(id, "UTC");
    expect(open.match(/公開ルートはどれか/g)).toHaveLength(2); // 未決事項の欄と Activity の1行
    expect(open).toContain("me が確認を依頼: 公開ルートはどれか");
    expect(open).not.toContain("question_asked");
    expect(open).not.toContain("question_id");

    const q = (await me(["issue", "show", id])).json.questions[0].id;
    await me(["answer", id, "/docs にする", "--question", String(q)]);
    const answered = await show(id, "UTC");
    const { askedAt, answeredAt } = (await me(["issue", "show", id])).json.questions[0];
    expect(answered).toContain(`  ${shifted(askedAt, 0)}  me が確認を依頼: 公開ルートはどれか\n    → me（${shifted(answeredAt, 0)}）: /docs にする`);
    expect(answered).not.toContain("question_answered");
    expect(answered).not.toContain("question_id");
    // ほかの event は従来どおり出る
    expect(answered).toContain("me created");
  });

  test("質問の行は依頼した時刻の位置のまま、回答の行に回答した時刻をローカル時刻で付ける", async () => {
    const id = (await me(["issue", "create", "回答の時刻を出す"])).json.id;
    await me(["issue", "ask", id, "期限はいつか"]);
    const q = (await me(["issue", "show", id])).json.questions[0].id;
    await me(["answer", id, "来週", "--question", String(q)]);
    // 依頼の翌日に、依頼と回答の間にコメントが入ったことにする
    const c = openDb(db);
    c.query("UPDATE questions SET asked_at = ?, answered_at = ? WHERE id = ?").run("2026-10-01T20:00:00.000Z", "2026-10-02T00:00:00.000Z", q);
    c.close();
    await me(["issue", "comment", id, "あとのコメント"]);
    const { utc, tokyo } = await texts(["issue", "show", id]);
    expect(utc).toContain("  2026-10-01 20:00  me が確認を依頼: 期限はいつか\n    → me（2026-10-02 00:00）: 来週");
    expect(tokyo).toContain("  2026-10-02 05:00  me が確認を依頼: 期限はいつか\n    → me（2026-10-02 09:00）: 来週");
    // 回答の時刻（00:00）より前に書いたコメントがあっても、質問の行は依頼した時刻（20:00）の位置から動かさない
    const c2 = openDb(db);
    c2.query("UPDATE comments SET created_at = ? WHERE body = ?").run("2026-10-01T22:00:00.000Z", "あとのコメント");
    c2.close();
    const moved = (await texts(["issue", "show", id])).utc;
    expect(moved.indexOf("me が確認を依頼: 期限はいつか")).toBeLessThan(moved.indexOf("あとのコメント"));
    expect(moved.indexOf("→ me（2026-10-02 00:00）: 来週")).toBeLessThan(moved.indexOf("あとのコメント"));
  });

  test("未回答の質問には回答の行も時刻も出さない", async () => {
    const id = (await me(["issue", "create", "未回答"])).json.id;
    await me(["issue", "ask", id, "まだ決まっていない"]);
    expect(await show(id, "UTC")).not.toContain("→ ");
  });

  test("LLM の確認依頼も1行だけ", async () => {
    const id = (await me(["issue", "create", "検索を速くする"])).json.id;
    await llm(["issue", "start", id]);
    await llm(["issue", "ask", id, "対象の画面はどれか"]);
    const text = await show(id, "UTC");
    expect(text).toContain("claude-code が確認を依頼: 対象の画面はどれか");
    expect(text).not.toContain("question_asked");
  });

  test("--json の activity は変えない（question_asked の event と UTC の ISO を保つ）", async () => {
    const id = (await me(["issue", "create", "一覧を直す"])).json.id;
    await me(["issue", "ask", id, "列の順は"]);
    const detail = (await runNod(["issue", "show", id, "--json"], { cwd: repo, db, env: { TZ: "Asia/Tokyo" } })).json;
    const types = detail.activity.filter((a: { kind: string }) => a.kind === "event").map((a: { type: string }) => a.type);
    expect(types).toContain("question_asked");
    for (const a of detail.activity) expect(a.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("CLI の時刻はローカル時刻（#171）", () => {
  test("Activity とアーカイブ日時を TZ に合わせて出す", async () => {
    const id = (await me(["issue", "create", "時刻をそろえる"])).json.id;
    await me(["issue", "comment", id, "メモ"]);
    await me(["issue", "archive", id]);
    const detail = (await runNod(["issue", "show", id, "--json"], { cwd: repo, db })).json;
    const created = detail.activity.find((a: { kind: string; type?: string }) => a.kind === "event" && a.type === "created");
    const comment = detail.activity.find((a: { kind: string }) => a.kind === "comment");

    const utc = await show(id, "UTC");
    expect(utc).toContain(`  ${shifted(created.at, 0)}  me created`);
    expect(utc).toContain(`  ${shifted(comment.at, 0)}  #${comment.id} me: メモ`);
    expect(utc).toContain(`アーカイブ済み: ${shifted(detail.archivedAt, 0)}（`);

    const tokyo = await show(id, "Asia/Tokyo");
    expect(tokyo).toContain(`  ${shifted(created.at, TOKYO)}  me created`);
    expect(tokyo).toContain(`  ${shifted(comment.at, TOKYO)}  #${comment.id} me: メモ`);
    expect(tokyo).toContain(`アーカイブ済み: ${shifted(detail.archivedAt, TOKYO)}（`);
    expect(tokyo).not.toContain(`  ${shifted(created.at, 0)}  me created`);
  });

  test("issue show と summary の時刻が同じになる", async () => {
    const id = (await me(["issue", "create", "着手を確かめる"])).json.id;
    await llm(["issue", "start", id]);
    const env = { TZ: "Asia/Tokyo" };
    const detail = (await runNod(["issue", "show", id, "--json"], { cwd: repo, db, env })).json;
    const started = detail.activity.find(
      (a: { kind: string; type?: string; data?: { to?: string } }) => a.kind === "event" && a.type === "status_changed" && a.data?.to === "in_progress",
    );
    const at = shifted(started.at, TOKYO);
    expect((await runNod(["issue", "show", id], { cwd: repo, db, env })).stdout).toContain(`  ${at}  claude-code status_changed`);
    expect((await runNod(["summary"], { cwd: repo, db, env })).stdout).toContain(`  ${at}  ${id}`);
  });

  test("Triage の後回しの日時もローカル時刻で出す", async () => {
    const id = (await llm(["issue", "create", "あとで見る"])).json.id;
    const args = ["triage", "snooze", id, "2999-01-01T09:00:00+09:00"];
    expect((await runNod(args, { cwd: repo, db, env: { TZ: "Asia/Tokyo" } })).stdout).toContain("2999-01-01 09:00 まで後回しにしました: ");
    expect((await runNod(args, { cwd: repo, db, env: { TZ: "UTC" } })).stdout).toContain("2999-01-01 00:00 まで後回しにしました: ");
    expect((await me(["issue", "show", id])).json.snoozedUntil).toBe("2999-01-01T00:00:00.000Z");
  });

  test("表示した YYYY-MM-DD HH:mm を --at・--until・triage snooze に貼ると、ローカル時刻として受け付ける", async () => {
    const env = { TZ: "Asia/Tokyo" };
    const snoozed = (await llm(["issue", "create", "貼り付けで後回し"])).json.id;
    const r = await runNod(["triage", "snooze", snoozed, "2999-01-01 09:00"], { cwd: repo, db, env });
    expect(r.stdout).toContain("2999-01-01 09:00 まで後回しにしました: ");
    expect((await me(["issue", "show", snoozed])).json.snoozedUntil).toBe("2999-01-01T00:00:00.000Z");

    const id = (await me(["issue", "create", "貼り付けでリマインド"])).json.id;
    const remind = await runNod(["issue", "remind", id, "--at", "2999-01-01 09:00"], { cwd: repo, db, env });
    expect(remind.stdout).toContain(`${id} に 2999-01-01 09:00 のリマインダーを設定しました`);
    expect((await me(["issue", "show", id])).json.reminder.remindAt).toBe("2999-01-01T00:00:00.000Z");
    // UTC より西でも同じ（ローカルの 09:00 は UTC の 17:00）
    await runNod(["issue", "remind", id, "--at", "2999-01-01 09:00"], { cwd: repo, db, env: { TZ: "America/Los_Angeles" } });
    expect((await me(["issue", "show", id])).json.reminder.remindAt).toBe("2999-01-01T17:00:00.000Z");

    await me(["issue", "subscribe", id]);
    await llm(["issue", "comment", id, "通知を作る"]);
    const snooze = await runNod(["notification", "snooze", "--issue", id, "--until", "2999-01-01 09:00", "--json"], { cwd: repo, db, env });
    expect(snooze.json.snoozedUntil).toBe("2999-01-01T00:00:00.000Z");
  });

  test("project report list の進捗報告", async () => {
    await me(["project", "create", "時差"]);
    const report = (await me(["project", "report", "add", "時差", "索引を作り直した"])).json;
    const { utc, tokyo } = await texts(["project", "report", "list", "時差"]);
    expect(utc).toContain(`  ${shifted(report.createdAt, 0)}  me`);
    expect(tokyo).toContain(`  ${shifted(report.createdAt, TOKYO)}  me`);
    expect(tokyo).not.toContain(`  ${shifted(report.createdAt, 0)}  me`);
  });

  test("issue instructions の追加指示", async () => {
    const id = (await me(["issue", "create", "指示の時刻"])).json.id;
    await llm(["issue", "start", id]);
    const i = (await me(["issue", "instruct", id, "テストも追加して"])).json;
    const { utc, tokyo } = await texts(["issue", "instructions", id]);
    expect(utc).toContain(`#${i.id} ${shifted(i.createdAt, 0)} me`);
    expect(tokyo).toContain(`#${i.id} ${shifted(i.createdAt, TOKYO)} me`);
    expect(tokyo).not.toContain(`#${i.id} ${shifted(i.createdAt, 0)} me`);
  });

  test("workspace audit の削除日時", async () => {
    const id = (await me(["issue", "create", "消して確かめる"])).json.id;
    await me(["issue", "archive", id]);
    await me(["issue", "delete", id, "--yes"]);
    const row = (await me(["workspace", "audit"])).json.find((d: { issueId: string }) => d.issueId === id);
    const { utc, tokyo } = await texts(["workspace", "audit"]);
    expect(utc).toContain(`${shifted(row.deletedAt, 0)}  ${id}  消して確かめる`);
    expect(tokyo).toContain(`${shifted(row.deletedAt, TOKYO)}  ${id}  消して確かめる`);
    expect(tokyo).not.toContain(`${shifted(row.deletedAt, 0)}  ${id}  消して確かめる`);
  });

  test("template list の更新日は、UTC では前日でもローカルの暦日で出す", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "tz.md"), "## 手順\n");
    await runNod(["template", "add", "tz-check", "--from", "tz.md"], { cwd: dir, db });
    const c = openDb(db);
    c.query("UPDATE templates SET updated_at = ? WHERE name = ?").run("2020-01-01T23:30:00.000Z", "tz-check");
    c.close();
    const { utc, tokyo } = await texts(["template", "list"]);
    expect(utc).toContain("tz-check  （更新 2020-01-01）");
    expect(tokyo).toContain("tz-check  （更新 2020-01-02）");
    const la = (await runNod(["template", "list"], { cwd: repo, db, env: { TZ: "America/Los_Angeles" } })).stdout;
    expect(la).toContain("tz-check  （更新 2020-01-01）");
  });

  test("triage proposals の更新日時", async () => {
    const id = (await llm(["issue", "create", "提案の時刻"])).json.id;
    const p = (await llm(["triage", "propose", id, "--accept", "--reason", "再現できた"])).json;
    const { utc, tokyo } = await texts(["triage", "proposals", id]);
    expect(utc).toContain(`  ${shifted(p.updatedAt, 0)}\n`);
    expect(tokyo).toContain(`  ${shifted(p.updatedAt, TOKYO)}\n`);
    expect(tokyo).not.toContain(`  ${shifted(p.updatedAt, 0)}\n`);
  });
});
