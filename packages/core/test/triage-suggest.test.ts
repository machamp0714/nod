import { describe, expect, test } from "bun:test";
import { acceptTriage, duplicateTriage } from "../src/ops/human";
import { createIssue, updateIssue } from "../src/ops/issues";
import { similarity, suggestTriage, tokenize } from "../src/ops/triage-suggest";
import { initWorkspace } from "../src/ops/workspaces";
import { codeOf, eventsOf, setup } from "./helpers";

describe("tokenize", () => {
  test("NFKC・小文字化し、英数字は2文字以上の語、日本語は文字bigramにする", () => {
    const t = tokenize("ＡＰＩの Offset が a ずれる検索");
    expect(t.has("api")).toBe(true);
    expect(t.has("offset")).toBe(true);
    expect(t.has("a")).toBe(false);
    expect(t.has("検索")).toBe(true);
    expect(t.has("ずれ")).toBe(true);
    expect(t.has("る検")).toBe(true);
  });

  test("平仮名だけのタイトルでもトークンがゼロにならず、類似度を計算できる", () => {
    expect([...tokenize("ひらがなだけ")].length).toBeGreaterThan(0);
    expect(similarity({ title: "ひらがなだけ", body: null }, { title: "ひらがなだけ", body: null })).toBeCloseTo(1);
  });

  test("_ と拡張ラテン文字は語に含める", () => {
    const t = tokenize("snake_case café");
    expect([...t].sort()).toEqual(["café", "snake_case"]);
  });

  test("英語のよくある機能語を除く", () => {
    const t = tokenize("fix the bug in search");
    expect([...t].sort()).toEqual(["bug", "fix", "search"]);
  });
});

describe("similarity", () => {
  test("タイトル0.7・タイトル+本文0.3で加重し、同一なら1、無関係なら0", () => {
    expect(similarity({ title: "検索のページング", body: "offset" }, { title: "検索のページング", body: "offset" })).toBeCloseTo(1);
    expect(similarity({ title: "検索のページング", body: null }, { title: "ログの時刻", body: null })).toBe(0);
  });
});

function seed() {
  const s = setup();
  const { me, llm, ws } = s;
  const create = (ctx: typeof me, title: string, description?: string) => createIssue(ctx, { workspaceId: ws.id, title, description });
  return { ...s, create };
}

describe("suggestTriage", () => {
  test("類似Issueを重複候補として一致率・共通語つきで上位に出し、DBを変更しない", () => {
    const { db, me, llm, create } = seed();
    const original = create(me, "検索結果のページングが1件ずれる", "offset の計算が誤っている");
    create(me, "ログのタイムゾーンをUTCに統一");
    const triage = create(llm, "検索結果のページングがずれる", "offset がおかしい");
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
    const snapshot = () => tables.map(({ name }) => db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all());
    const before = snapshot();
    const s = suggestTriage(llm, triage.id);
    expect(snapshot()).toEqual(before);
    expect(s.issueId).toBe(triage.id);
    expect(s.duplicates.map((d) => d.id)).toEqual([original.id]);
    const [d] = s.duplicates;
    expect(d!.title).toBe(original.title);
    expect(d!.status).toBe("todo");
    expect(d!.score).toBeGreaterThanOrEqual(0.25);
    expect(d!.score).toBeLessThanOrEqual(1);
    expect(d!.sharedTerms).toEqual(["検索結果のページングが", "ずれる", "offset"]);
    expect(d!.sharedTerms.length).toBeLessThanOrEqual(5);
  });

  test("別Workspace・自身は除外し、done/canceledとTriage中は含め、上位5件・同点はcreated_at,id順にする", () => {
    const { db, me, llm, create } = seed();
    const other = initWorkspace(db, { path: "/tmp/repos/other", key: "OTHER" }).workspace;
    createIssue(me, { workspaceId: other.id, title: "検索結果のページングがずれる" });
    const ids = Array.from({ length: 6 }, () => create(me, "検索結果のページングがずれる").id);
    updateIssue(me, ids[0]!, { status: "done" });
    updateIssue(me, ids[1]!, { status: "canceled" });
    const otherTriage = create(llm, "検索結果のページングがずれる");
    const triage = create(llm, "検索結果のページングがずれる");
    const s = suggestTriage(me, triage.id);
    expect(s.duplicates.map((d) => d.id)).toEqual(ids.slice(0, 5));
    expect(s.duplicates.map((d) => d.status).slice(0, 2)).toEqual(["done", "canceled"]);
    expect(s.duplicates.some((d) => d.id === otherTriage.id)).toBe(false); // 上位5件に入らない
    expect(s.duplicates.some((d) => d.id === triage.id || d.workspace === "OTHER")).toBe(false);
  });

  test("閾値0.25未満は出さない", () => {
    const { me, llm, create } = seed();
    create(me, "ログの時刻を直す");
    const triage = create(llm, "検索結果のページングがずれる");
    expect(suggestTriage(me, triage.id).duplicates).toEqual([]);
  });

  test("既に重複になっているIssueは除外し、元のIssueに寄せる", () => {
    const { me, llm, create } = seed();
    const original = create(me, "通知の既読が戻らない");
    const dup = create(llm, "検索結果のページングがずれる");
    duplicateTriage(me, dup.id, original.id);
    const triage = create(llm, "検索結果のページングがずれる");
    const s = suggestTriage(me, triage.id);
    expect(s.duplicates.map((d) => d.id)).toEqual([original.id]);
    expect(s.duplicates[0]!.via).toBe(dup.id);
    expect(s.duplicates[0]!.score).toBeCloseTo(1);
  });

  test("重複の寄せ先が別Workspaceなら寄せずに、同一Workspaceの重複側Issueを候補にする", () => {
    const { db, me, llm, create } = seed();
    const other = initWorkspace(db, { path: "/tmp/repos/other", key: "OTHER" }).workspace;
    const original = createIssue(me, { workspaceId: other.id, title: "通知の既読が戻らない" });
    const dup = create(llm, "検索結果のページングがずれる");
    duplicateTriage(me, dup.id, original.id);
    const triage = create(llm, "検索結果のページングがずれる");
    const s = suggestTriage(me, triage.id);
    expect(s.duplicates.map((d) => d.id)).toEqual([dup.id]);
    expect(s.duplicates[0]!.workspace).toBe("API");
    expect(s.duplicates[0]!.via).toBeNull();
  });

  test("重複の寄せは1段だけで、寄せ先がさらに重複でも辿らない", () => {
    const { me, llm, create } = seed();
    const root = create(me, "ログの時刻を直す");
    const middle = create(llm, "通知の既読が戻らない");
    duplicateTriage(me, middle.id, root.id);
    const dup = create(llm, "検索結果のページングがずれる");
    duplicateTriage(me, dup.id, middle.id);
    const triage = create(llm, "検索結果のページングがずれる");
    expect(suggestTriage(me, triage.id).duplicates.map((d) => d.id)).toEqual([middle.id]);
  });

  test("タイトル・本文を編集すると次の提案に反映する（トークンのキャッシュを作り直す）", () => {
    const { me, llm, create } = seed();
    const a = create(me, "ログの時刻を直す");
    const triage = create(llm, "検索結果のページングがずれる");
    expect(suggestTriage(me, triage.id).duplicates).toEqual([]);
    updateIssue(me, a.id, { title: "検索結果のページングがずれる" });
    expect(suggestTriage(me, triage.id).duplicates.map((d) => d.id)).toEqual([a.id]);
    updateIssue(me, a.id, { title: "x", description: "ログの時刻を直す" });
    expect(suggestTriage(me, triage.id).duplicates).toEqual([]);
    updateIssue(me, a.id, { description: "検索結果のページングがずれる" });
    const byBody = suggestTriage(me, triage.id).duplicates;
    expect(byBody.map((d) => [d.id, d.score])).toEqual([[a.id, 0.3]]); // 本文だけの一致は タイトル+本文 の 0.3 だけ
  });

  test("ハイフン・記号入りのラベルがあっても失敗せず、ハイフン入りは語の境界、記号入りは部分文字列で一致させる", () => {
    const { me, llm, ws } = seed();
    createIssue(me, { workspaceId: ws.id, title: "x", labels: ["good-first-issue", "c++", "a.b", "needs review"] });
    const triage = createIssue(llm, { workspaceId: ws.id, title: "good-first-issue の c++ 対応", description: "needs review" });
    expect(suggestTriage(me, triage.id).labels).toEqual([
      { label: "c++", reasons: [{ kind: "text", field: "title" }] },
      { label: "good-first-issue", reasons: [{ kind: "text", field: "title" }] },
      { label: "needs review", reasons: [{ kind: "text", field: "description" }] },
    ]);
    const other = createIssue(llm, { workspaceId: ws.id, title: "good-first-issues と axb" });
    expect(suggestTriage(me, other.id).labels).toEqual([]);
  });

  test("ラベル名の一致は同一Workspaceのラベルだけを使う", () => {
    const { db, me, llm, ws } = seed();
    const other = initWorkspace(db, { path: "/tmp/repos/other", key: "OTHER" }).workspace;
    createIssue(me, { workspaceId: other.id, title: "x", labels: ["search"] });
    const triage = createIssue(llm, { workspaceId: ws.id, title: "search が遅い" });
    expect(suggestTriage(me, triage.id).labels).toEqual([]);
  });

  test("ラベル候補: 類似Issueの付与実績と本文中のラベル名を根拠にし、付与済みを除いて上位3件", () => {
    const { me, llm, ws, create } = seed();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索結果のページングがずれる", labels: ["api", "search"] });
    const b = createIssue(me, { workspaceId: ws.id, title: "検索結果のページングが重複する", labels: ["search"] });
    createIssue(me, { workspaceId: ws.id, title: "無関係なログ", labels: ["perf", "bug"] });
    const triage = createIssue(llm, { workspaceId: ws.id, title: "検索結果のページングが壊れた bug", labels: ["api"] });
    const s = suggestTriage(me, triage.id);
    expect(s.labels.map((l) => l.label)).toEqual(["search", "bug"]);
    expect(s.labels[0]!.reasons).toEqual([{ kind: "similar", issues: [a.id, b.id] }]);
    expect(s.labels[1]!.reasons).toEqual([{ kind: "text", field: "title" }]);
  });

  test("ラベル名は語の境界で一致させ、本文中なら field=description", () => {
    const { me, llm, ws } = seed();
    createIssue(me, { workspaceId: ws.id, title: "x", labels: ["ui", "db"] });
    const triage = createIssue(llm, { workspaceId: ws.id, title: "画面が遅い", description: "guide を読む。DB が重い" });
    expect(suggestTriage(me, triage.id).labels).toEqual([{ label: "db", reasons: [{ kind: "text", field: "description" }] }]);
  });

  test("担当候補: 起票元Issueの担当と類似Issueの担当実績を根拠にし、未割当を除いて上位2件", () => {
    const { me, llm, ws, create } = seed();
    const source = create(me, "検索 API の N+1 を解消");
    updateIssue(me, source.id, { assignee: "claude-code" });
    const a = create(me, "検索結果のページングがずれる");
    updateIssue(me, a.id, { assignee: "codex" });
    const b = create(me, "検索結果のページングが重複する");
    updateIssue(me, b.id, { assignee: "codex" });
    const c = create(me, "検索結果のページングが遅い");
    updateIssue(me, c.id, { assignee: "gemini" });
    create(me, "検索結果のページング");
    const triage = createIssue(llm, { workspaceId: ws.id, title: "検索結果のページングが壊れた", discoveredFromRef: source.id });
    const s = suggestTriage(me, triage.id);
    expect(s.assignees.map((x) => x.assignee)).toEqual(["codex", "claude-code"]);
    expect(s.assignees[0]!.reasons).toEqual([{ kind: "similar", issues: [a.id, b.id] }]);
    expect(s.assignees[1]!.reasons).toEqual([{ kind: "source", issue: source.id }]);
  });

  test("Triage以外はNOT_IN_TRIAGE、存在しないIssueはNOT_FOUND", () => {
    const { me, create } = seed();
    const todo = create(me, "受け入れ済み");
    expect(codeOf(() => suggestTriage(me, todo.id))).toBe("NOT_IN_TRIAGE");
    expect(codeOf(() => suggestTriage(me, "API-999"))).toBe("NOT_FOUND");
  });

  test("数千件でも妥当な時間で計算する", () => {
    const { db, me, llm, ws } = seed();
    const words = ["検索", "ページング", "通知", "ログ", "API", "offset", "timezone", "画面", "遅い", "ずれる", "壊れた", "設定"];
    const body = "再現手順と期待する動作、実際の動作を記載する。".repeat(40);
    const insert = db.query(
      "INSERT INTO issues (workspace_id, number, title, description, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'todo', 'me', '2026-01-01', '2026-01-01')",
    );
    db.transaction(() => {
      for (let n = 1; n <= 5000; n++) {
        insert.run(ws.id, 10000 + n, `${words[n % 12]}の${words[(n * 7) % 12]}が${words[(n * 5) % 12]} ${n}`, body);
      }
    })();
    const triage = createIssue(llm, { workspaceId: ws.id, title: "検索のページングがずれる", description: body });
    const started = performance.now();
    const s = suggestTriage(me, triage.id);
    const elapsed = performance.now() - started;
    expect(s.duplicates.length).toBeLessThanOrEqual(5);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("acceptTriage の assignee", () => {
  test("受け入れと同時に担当を設定し、LLMはFORBIDDEN_FOR_LLMで何も変えない", () => {
    const { me, llm, create } = seed();
    const triage = create(llm, "検索結果のページングがずれる");
    expect(codeOf(() => acceptTriage(llm, triage.id, { assignee: "codex" }))).toBe("FORBIDDEN_FOR_LLM");
    expect(eventsOf(me.db, triage.id).map((e) => e.type)).toEqual(["created"]);
    const accepted = acceptTriage(me, triage.id, { assignee: "codex" });
    expect(accepted.assignee).toBe("codex");
    expect(accepted.status).toBe("todo");
  });

  test("assignee の空文字・空白だけはINVALID_ARGSで何も変えず、前後の空白は除いて設定する", () => {
    const { me, llm, create } = seed();
    const triage = create(llm, "検索結果のページングがずれる");
    expect(codeOf(() => acceptTriage(me, triage.id, { assignee: "" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => acceptTriage(me, triage.id, { assignee: "  " }))).toBe("INVALID_ARGS");
    expect(eventsOf(me.db, triage.id).map((e) => e.type)).toEqual(["created"]);
    expect(acceptTriage(me, triage.id, { assignee: " codex " }).assignee).toBe("codex");
  });
});
