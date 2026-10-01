import { beforeAll, describe, expect, test } from "bun:test";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

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
    expect(answered).toContain("me が確認を依頼: 公開ルートはどれか\n    → me: /docs にする");
    expect(answered).not.toContain("question_answered");
    expect(answered).not.toContain("question_id");
    // ほかの event は従来どおり出る
    expect(answered).toContain("me created");
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
});
