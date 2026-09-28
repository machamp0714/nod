import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  answerQuestion,
  approveReview,
  askQuestion,
  attachDocument,
  type CreateIssueInput,
  completeIssue,
  createIssue,
  createProject,
  createView,
  type Issue,
  initWorkspace,
  type OpCtx,
  relateIssue,
  startIssue,
  updateIssue,
} from "@nod/core";
import type { Dataset } from "../support/dataset";

// E（Issue 一覧）のデータセット。A のダミーデータ（src/fixtures/）と同じ Issue、Project、View、Document を core の操作で作る。
// 内容を変えたら、E の計画の Task 1 の表も直す。

function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`${index} 番目の値がありません`);
  return value;
}

const LONG_TITLE =
  "数値入力のデフォルト値：未入力の欄を 0 で補完して記録する（合計値制御で割合 0 の欄を空けたまま進めてもローデータに 0 が残るようにし、公開 YAML と API スキーマの初期許可範囲も揃える）";

const LONG_QUESTION =
  "画像の生成に外部 API（有料）を使ってよいですか？使わない場合は Canvas で描画しますが、日本語のフォントを同梱するためリポジトリが約 8MB 増え、記事ごとの生成にも数秒かかります。どちらを選ぶか、使うなら月の上限額も決めてください。";

const dataset: Dataset = ({ db, dir, repo, writeFile }) => {
  const me: OpCtx = { db, actor: "me" };
  const claude: OpCtx = { db, actor: "claude-code" };
  const codex: OpCtx = { db, actor: "codex" };

  const ws = {
    API: initWorkspace(db, { path: repo("api-server"), key: "API", name: "api-server" }).workspace,
    NOD: initWorkspace(db, { path: repo("nod"), key: "NOD", name: "nod" }).workspace,
    BLOG: initWorkspace(db, { path: repo("blog"), key: "BLOG", name: "blog" }).workspace,
  };

  const projects: [string, string, "planned" | "started" | "completed"][] = [
    ["検索 API の高速化", "p95 を 200ms 以下にする", "started"],
    ["決済まわり", "Webhook の信頼性を上げる", "started"],
    ["nod Web UI", "判断のための画面", "started"],
    ["nod CLI", "LLM 向けの CLI", "completed"],
    ["ブログのリニューアル", "デザインと OGP", "planned"],
  ];
  for (const [name, description, status] of projects) {
    const project = createProject(me, { name, description });
    // core には Project のステータスを変える操作がないため、テストのデータとして SQL で書く
    db.query("UPDATE projects SET status = ? WHERE id = ?").run(status, project.id);
  }

  // Issue の番号は Workspace の連番で振られるため、作る直前に次の番号を合わせる
  function issue(ctx: OpCtx, id: string, input: Omit<CreateIssueInput, "workspaceId">): Issue {
    const [key = "", number = "0"] = id.split("-");
    const workspace = ws[key as keyof typeof ws];
    db.query("UPDATE workspaces SET next_number = ? WHERE id = ?").run(Number(number), workspace.id);
    const created = createIssue(ctx, { ...input, workspaceId: workspace.id });
    if (created.id !== id) throw new Error(`${id} を作るつもりが ${created.id} になった`);
    return created;
  }

  // 実行場所（Inbox と Issue 詳細に出る）。ファイルは作らない
  const location = (name: string, branch: string) => ({
    location: { branch, worktree: join(dir, "worktrees", name, branch.replace(/^feature\//, "")) },
  });

  issue(me, "API-12", {
    title: "検索 API の N+1 を解消",
    priority: 2,
    projectRef: "1",
    labels: ["perf"],
    description:
      "/search で結果1件ごとに workspace を取得しているため、件数に比例してクエリが増える。\n\n## 受け入れ条件\n\n- 100 件の検索でクエリが 3 回以下\n- p95 が 200ms 以下",
  });
  startIssue(claude, "API-12", location("api-server", "feat-search-n1"));
  const measured = askQuestion(claude, "API-12", "計測は本番相当のデータで行いますか？").question;
  answerQuestion(me, "API-12", "ステージングのダンプで計測してください", { questionId: measured.id });
  askQuestion(
    claude,
    "API-12",
    "インデックスを (workspace_id, created_at) の複合にしようとしています。既存の created_at 単独のインデックスは消してよいですか？",
  );

  issue(me, "API-13", { title: "workspace の取得をまとめる", priority: 2, parentRef: "API-12", projectRef: "1" });
  relateIssue(me, "API-12", { blocks: "API-13" });

  issue(me, "API-9", { title: LONG_TITLE, priority: 3, projectRef: "1" });
  const decisions = [
    "機能そのものを採用するか",
    "デフォルト値は 0 限定か任意整数か",
    "required 設定との意味論",
    "画面に見せるか（プレースホルダー / プリフィル）",
    "設定の置き場所と名前",
    "公開 YAML と API スキーマの初期許可範囲",
  ].map((text) => askQuestion(me, "API-9", text).question);
  answerQuestion(me, "API-9", "採用する", { questionId: at(decisions, 0).id });
  answerQuestion(me, "API-9", "0 限定", { questionId: at(decisions, 1).id });

  issue(me, "API-8", { title: "決済 Webhook の再送処理", priority: 3, projectRef: "2" });
  startIssue(codex, "API-8", location("api-server", "fix-webhook-retry"));
  askQuestion(codex, "API-8", "リトライ上限を 5 回にしようとしています。既存の設定値 3 回と食い違いますが、5 回に揃えてよいですか？");

  issue(me, "API-7", { title: "決済 Webhook の署名検証を追加", priority: 2, projectRef: "2" });
  startIssue(claude, "API-7", location("api-server", "feature/api-7-webhook-signature"));
  const signature = askQuestion(claude, "API-7", "署名の検証に失敗したときは 401 と 400 のどちらを返しますか？").question;
  answerQuestion(me, "API-7", "401", { questionId: signature.id });
  completeIssue(claude, "API-7", {
    summary: "署名の検証を足し、失敗したときは 401 を返すようにした",
    prUrl: "https://github.com/example/api-server/pull/128",
  });

  issue(me, "API-4", { title: "OpenAPI の説明文を更新する", priority: 4 });
  issue(claude, "API-15", {
    title: "検索結果のページングが 1 件ずれる",
    description: "page=2&per_page=20 のとき、21 件目ではなく 22 件目から返る。offset の計算で 1 を足している可能性がある。",
  });
  issue(codex, "API-16", { title: "レート制限の残り回数をヘッダーで返す" });

  issue(me, "NOD-3", { title: "nod issue next の取り合いを防ぐ", priority: 2, projectRef: "4" });
  startIssue(claude, "NOD-3");
  completeIssue(claude, "NOD-3", {
    summary: "取り合いを UPDATE の件数で防いだ",
    prUrl: "https://github.com/example/nod/pull/12",
  });
  approveReview(me, "NOD-3");

  issue(me, "NOD-5", { title: "Inbox の回答フォームを作る", priority: 3, projectRef: "3" });
  issue(me, "NOD-6", { title: "Sidebar に件数を表示する", projectRef: "3" });
  updateIssue(me, "NOD-6", { status: "backlog" });
  issue(me, "NOD-2", { title: "beads から移行する" });
  updateIssue(me, "NOD-2", { status: "canceled", reason: "SQLite に切り替えたため" });

  issue(me, "BLOG-2", { title: "ブログの OGP 画像を自動生成", priority: 3, projectRef: "5" });
  startIssue(claude, "BLOG-2", location("blog", "feat-ogp"));
  askQuestion(claude, "BLOG-2", LONG_QUESTION);

  // Document は本文を DB に写さず、添付のときにファイルを読むため、一時ディレクトリに本物のファイルを置く
  const spec = writeFile(
    "docs/search-performance.md",
    "# 検索 API の高速化 設計\n\n## 目的\n\n/search の p95 を 200ms 以下にする。\n\n## 方針\n\n- 結果ごとの workspace の取得をまとめる\n- (workspace_id, created_at) の複合インデックスを足す\n",
  );
  const plan = writeFile(
    "docs/search-n1.md",
    "# 検索 API の N+1 解消 実装計画\n\n### Task 1: 調査\n\n### Task 2: インデックス設計\n\n### Task 3: 実装\n\n### Task 4: 計測\n",
  );
  const nodSpec = writeFile("docs/nod-design.md", "# nod 設計\n");
  attachDocument(me, { projectRef: "1" }, { path: spec, kind: "spec" });
  attachDocument(me, { issueRef: "API-12" }, { path: spec, kind: "spec" });
  attachDocument(me, { issueRef: "API-12" }, { path: plan, kind: "plan" });
  attachDocument(me, { projectRef: "3" }, { path: nodSpec, kind: "spec" });
  // 「ファイルが見つかりません」の表示を試すため、添付した後に消す
  rmSync(nodSpec);

  createView(db, { name: "仕事", color: "#7C5CFF", filter: { workspace: ["API"] } });
  createView(db, { name: "プライベート", color: "#DB2777", filter: { workspace: ["BLOG"] } });
};

export default dataset;
