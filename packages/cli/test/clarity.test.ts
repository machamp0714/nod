import { beforeAll, describe, expect, test } from "bun:test";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

let db: string;
let repo: string;

beforeAll(() => {
  db = tempDb();
  repo = makeRepo();
  registerRepo(db, repo, "TS");
});

const me = (args: string[]) => runNod([...args, "--json"], { cwd: repo, db });
const llm = (args: string[]) => runNod([...args, "--json"], { cwd: repo, db, actor: "claude-code" });
const text = async (args: string[]) => (await runNod(args, { cwd: repo, db, env: { TZ: "UTC" } })).stdout;
const create = async (title: string, extra: string[] = []) => (await me(["issue", "create", title, ...extra])).json.id as string;

describe("Project の指定（#176 項目1）", () => {
  test("名前の一部では解決せず、近い名前の候補を名前と ID で出す", async () => {
    await me(["project", "create", "nod CLI"]);
    await me(["project", "create", "cli v2"]);
    await me(["project", "create", "Web"]);
    const r = await runNod(["issue", "create", "x", "--project", "CLI"], { cwd: repo, db });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Project CLI はありません。近い名前: cli v2（ID 2）、nod CLI（ID 1）。名前の全体か ID で指定してください");
    const json = await me(["issue", "create", "x", "--project", "CLI"]);
    expect(json.json.error.code).toBe("NOT_FOUND");
    expect(json.json.error.details.candidates).toEqual([
      { id: 2, name: "cli v2" },
      { id: 1, name: "nod CLI" },
    ]);
    // 候補がないときは一覧を案内する
    const none = await runNod(["issue", "create", "x", "--project", "存在しない"], { cwd: repo, db });
    expect(none.stderr).toContain("Project 存在しない はありません。nod project list で名前と ID を確かめてください");
    // 名前の全体と ID は従来どおり解決する
    expect((await me(["issue", "create", "y", "--project", "nod CLI"])).json.project.name).toBe("nod CLI");
    expect((await me(["issue", "create", "z", "--project", "2"])).json.project.name).toBe("cli v2");
  });
});

describe("関係の相手の印（#176 項目2）", () => {
  test("アーカイブ済みの相手に（アーカイブ済み）、数えないブロック元に（完了）（キャンセル）を添える", async () => {
    const target = await create("ブロックされる");
    const archived = await create("アーカイブするブロック元");
    const done = await create("完了するブロック元");
    const canceled = await create("キャンセルするブロック元");
    const open = await create("残るブロック元");
    const related = await create("アーカイブする関連");
    for (const b of [archived, done, canceled, open]) await me(["issue", "relate", b, "--blocks", target]);
    await me(["issue", "relate", target, "--related", related]);
    await me(["issue", "archive", archived]);
    await me(["issue", "archive", related]);
    await me(["issue", "update", done, "--status", "done"]);
    await me(["issue", "update", canceled, "--status", "canceled"]);
    const out = await text(["issue", "show", target]);
    expect(out).toContain(`  ブロックされている: ${archived}（アーカイブ済み）, ${done}（完了）, ${canceled}（キャンセル）, ${open}`);
    expect(out).toContain(`  関連: ${related}（アーカイブ済み）`);
    // ブロック元以外の行では、完了の印は付けない
    expect(await text(["issue", "show", done])).toContain(`  ブロックしている: ${target}\n`);
    // --json は relations を変えず、相手の状態を別の項目で返す
    const json = (await me(["issue", "show", target])).json;
    expect(json.relations.blockedBy).toEqual([archived, done, canceled, open]);
    expect(json.relationStates[archived]).toEqual({ status: "todo", archived: true });
    expect(json.relationStates[done]).toEqual({ status: "done", archived: false });
  });
});

describe("作業状況のタグ（#176 項目3）", () => {
  test("in_review・done の Issue には [done] を出さず、ほかの作業状況は出す", async () => {
    const id = await create("レビューに回す");
    await llm(["issue", "start", id]);
    expect(await text(["issue", "list", "--status", "in_progress"])).toMatch(new RegExp(`${id}\\s+In Progress \\[working\\]`));
    await llm(["issue", "done", id, "--summary", "終えた"]);
    const inReview = await text(["issue", "list", "--status", "in_review"]);
    expect(inReview).toContain(id);
    expect(inReview).not.toContain("[done]");
    expect(await text(["inbox"])).not.toContain("[done]");
    const shown = await text(["issue", "show", id]);
    expect(shown).toContain("ステータス: In Review\n");
    expect(shown).not.toContain("作業状況: done");
    await me(["review", "approve", id]);
    expect(await text(["issue", "list", "--status", "done"])).not.toContain("[done]");
    expect(await text(["issue", "show", id])).toContain("ステータス: Done\n");
    // --json は変えない
    expect((await me(["issue", "show", id])).json.agentState).toBe("done");
  });
});

describe("Inbox の重複（#176 項目4）", () => {
  test("確認依頼に出ている Issue の入力待ちの通知は、テキスト表示で省いて件数を添える", async () => {
    const id = await create("質問する");
    await llm(["issue", "start", id]);
    await llm(["issue", "ask", id, "A と B のどちらにするか"]);
    const out = await text(["inbox"]);
    expect(out.match(/A と B のどちらにするか/g)).toHaveLength(1);
    expect(out).toContain("Q: A と B のどちらにするか（claude-code）");
    expect(out).toContain("（確認依頼に出ている入力待ちの通知 1 件は省略）");
    // 通知そのものは残る
    expect(await text(["notification", "list"])).toContain("claude-code が確認を求めた（入力待ち）: A と B のどちらにするか");
    const json = (await me(["inbox"])).json;
    expect(json.notifications.some((n: { issueId: string; data: { to?: string } }) => n.issueId === id && n.data.to === "awaiting_input")).toBe(true);
    // 見出しの件数は、省いた後の件数
    const count = Number(out.match(/通知（未読 (\d+)）/)![1]);
    expect(count).toBe(json.notifications.length - 1);
  });
});

describe("ID の検索（#176 項目5）", () => {
  test("検索語と ID が完全一致する Issue を、並び順に関係なく先頭に置く", async () => {
    const other = openIds(await me(["issue", "list", "--status", "triage,todo,backlog,in_progress,in_review,done,canceled"]));
    // TS-6 と TS-60 台がそろうまで起票する
    for (let n = other.length; n < 61; n++) await create(`埋める ${n}`);
    await me(["issue", "update", "TS-2", "-d", "TS-6 を参照"]);
    await me(["issue", "update", "TS-60", "-p", "1"]);
    const all = ["--status", "triage,todo,backlog,in_progress,in_review,done,canceled", "--query", "ts-6"];
    const byId = (await me(["issue", "list", ...all])).json.map((i: { id: string }) => i.id);
    expect(byId[0]).toBe("TS-6");
    expect(byId).toContain("TS-2");
    expect(byId).toContain("TS-60");
    const byPriority = (await me(["issue", "list", ...all, "--sort", "priority"])).json.map((i: { id: string }) => i.id);
    expect(byPriority.slice(0, 2)).toEqual(["TS-6", "TS-60"]);
    const desc = await text(["issue", "list", ...all, "--desc"]);
    expect(desc.split("\n")[0]).toMatch(/^TS-6 /);
  });
});

function openIds(r: { json: { id: string }[] }): string[] {
  return r.json.map((i) => i.id);
}

describe("Activity の文（#198・#176 項目6）", () => {
  test("event を文で出し、起票元を本体と Activity の両方に出す", async () => {
    const source = await create("元の作業");
    const id = (await llm(["issue", "create", "見つけた不具合", "--discovered-from", source])).json.id;
    await me(["triage", "accept", id]);
    await me(["issue", "update", id, "--title", "見つけた不具合（再現あり）", "-d", "とても長い説明", "-p", "2", "--add-label", "bug"]);
    await llm(["issue", "start", id]);
    await llm(["issue", "done", id, "--summary", "直した"]);
    await me(["review", "reject", id, "テストがない", "--delegate", "review_fix"]);
    const out = await text(["issue", "show", id]);
    expect(out).toContain(`起票元: ${source}\n`);
    expect(out).toContain(`claude-code が起票した（状態: Triage、起票元: ${source}）`);
    expect(out).toContain("me が受け入れた");
    expect(out).toContain("me がタイトルを変えた（「見つけた不具合」→「見つけた不具合（再現あり）」）");
    expect(out).toContain("me が説明を変えた\n");
    expect(out).toContain("me が優先度を なし から High に変えた");
    expect(out).toContain("me がラベルを変えた（+bug）");
    expect(out).toContain("claude-code がステータスを Todo から In Progress に変えた");
    expect(out).toContain("claude-code の作業状況が 作業中 になった");
    expect(out).toMatch(/claude-code がステータスを In Progress から In Review に変えた（報告: #\d+）/);
    expect(out).toContain("me が差し戻した：テストがない（対応依頼: review_fix）");
    // 生の JSON と event の種類の名前は出ない
    expect(out).not.toMatch(/\{"/);
    expect(out).not.toContain("status_changed");
    // 説明の全文は Activity に出さない（本体の1回だけ）
    expect(out.match(/とても長い説明/g)).toHaveLength(1);
    // --json は生の event のまま
    const created = (await me(["issue", "show", id])).json.activity[0];
    expect(created).toMatchObject({ kind: "event", type: "created", data: { status: "triage", discovered_from: source } });
  });

  test("入力待ちの行は質問文を繰り返さず、スヌーズは期限をローカル時刻で出す", async () => {
    const id = await create("止める");
    await llm(["issue", "start", id]);
    await llm(["issue", "ask", id, "消してよいか"]);
    const out = await text(["issue", "show", id]);
    expect(out).toContain("claude-code の作業状況が 入力待ち になった\n");
    expect(out).toContain("claude-code が確認を依頼: 消してよいか");
    const triage = (await llm(["issue", "create", "あとで見る"])).json.id;
    await text(["triage", "snooze", triage, "2030-01-02 03:04"]);
    expect(await text(["issue", "show", triage])).toContain("me がスヌーズした（2030-01-02 03:04 まで）");
  });
});
