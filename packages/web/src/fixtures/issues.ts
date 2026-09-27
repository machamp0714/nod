import type { Issue, Question } from "../api/types";
import { projectRef } from "./projects";
import { ago } from "./time";

function issue(p: Partial<Issue> & Pick<Issue, "id" | "title" | "status">): Issue {
  const [workspace = "", number = "0"] = p.id.split("-");
  return {
    workspace,
    number: Number(number),
    description: null,
    priority: 0,
    assignee: null,
    agentState: null,
    parentId: null,
    project: null,
    labels: [],
    questionCount: { answered: 0, total: 0 },
    snoozedUntil: null,
    prUrl: null,
    branch: null,
    worktree: null,
    closeReason: null,
    createdBy: "me",
    createdAt: ago(60 * 24 * 3),
    updatedAt: ago(60),
    startedAt: null,
    closedAt: null,
    ...p,
  };
}

export const ISSUES: Issue[] = [
  issue({
    id: "API-12",
    title: "検索 API の N+1 を解消",
    status: "in_progress",
    priority: 2,
    assignee: "claude-code",
    agentState: "awaiting_input",
    project: projectRef(1),
    labels: ["perf"],
    branch: "feat-search-n1",
    worktree: "/Users/me/orca/workspaces/api-server/feat-search-n1",
    description:
      "/search で結果1件ごとに workspace を取得しているため、件数に比例してクエリが増える。\n\n## 受け入れ条件\n\n- 100 件の検索でクエリが 3 回以下\n- p95 が 200ms 以下",
    startedAt: ago(48),
    updatedAt: ago(12),
  }),
  issue({ id: "API-13", title: "workspace の取得をまとめる", status: "todo", priority: 2, parentId: "API-12", project: projectRef(1) }),
  issue({
    id: "API-9",
    title:
      "数値入力のデフォルト値：未入力の欄を 0 で補完して記録する（合計値制御で割合 0 の欄を空けたまま進めてもローデータに 0 が残るようにし、公開 YAML と API スキーマの初期許可範囲も揃える）",
    status: "needs_clarification",
    priority: 3,
    project: projectRef(1),
  }),
  issue({
    id: "API-8",
    title: "決済 Webhook の再送処理",
    status: "in_progress",
    priority: 3,
    assignee: "codex",
    agentState: "awaiting_input",
    project: projectRef(2),
    branch: "fix-webhook-retry",
    worktree: "/Users/me/orca/workspaces/api-server/fix-webhook-retry",
    startedAt: ago(90),
    updatedAt: ago(41),
  }),
  issue({
    id: "API-7",
    title: "決済 Webhook の署名検証を追加",
    status: "in_review",
    priority: 2,
    assignee: "claude-code",
    agentState: "done",
    project: projectRef(2),
    prUrl: "https://github.com/example/api-server/pull/128",
    branch: "feature/api-7-webhook-signature",
    worktree: "/Users/me/orca/workspaces/api-server/api-7-webhook-signature",
    startedAt: ago(92),
    updatedAt: ago(20),
  }),
  issue({ id: "API-4", title: "OpenAPI の説明文を更新する", status: "todo", priority: 4 }),
  issue({
    id: "API-15",
    title: "検索結果のページングが 1 件ずれる",
    status: "triage",
    createdBy: "claude-code",
    createdAt: ago(35),
    description: "page=2&per_page=20 のとき、21 件目ではなく 22 件目から返る。offset の計算で 1 を足している可能性がある。",
  }),
  issue({ id: "API-16", title: "レート制限の残り回数をヘッダーで返す", status: "triage", createdBy: "codex", createdAt: ago(180) }),
  issue({
    id: "NOD-3",
    title: "nod issue next の取り合いを防ぐ",
    status: "done",
    priority: 2,
    project: projectRef(4),
    prUrl: "https://github.com/example/nod/pull/12",
    closedAt: ago(60),
  }),
  issue({ id: "NOD-5", title: "Inbox の回答フォームを作る", status: "todo", priority: 3, project: projectRef(3) }),
  issue({ id: "NOD-6", title: "Sidebar に件数を表示する", status: "backlog", project: projectRef(3) }),
  issue({ id: "NOD-2", title: "beads から移行する", status: "canceled", closeReason: "SQLite に切り替えたため" }),
  issue({
    id: "BLOG-2",
    title: "ブログの OGP 画像を自動生成",
    status: "in_progress",
    priority: 3,
    assignee: "claude-code",
    agentState: "awaiting_input",
    project: projectRef(5),
    branch: "feat-ogp",
    worktree: "/Users/me/orca/workspaces/blog/feat-ogp",
    startedAt: ago(200),
    updatedAt: ago(120),
  }),
];

function question(
  id: number,
  issueId: string,
  askedBy: string,
  minutesAgo: number,
  text: string,
  answer: string | null = null,
): Question {
  return {
    id,
    issueId,
    question: text,
    askedBy,
    askedAt: ago(minutesAgo),
    answer,
    answeredBy: answer === null ? null : "me",
    answeredAt: answer === null ? null : ago(minutesAgo - 5),
  };
}

export const QUESTIONS: Question[] = [
  question(1, "API-12", "claude-code", 40, "計測は本番相当のデータで行いますか？", "ステージングのダンプで計測してください"),
  question(
    2,
    "API-12",
    "claude-code",
    12,
    "インデックスを (workspace_id, created_at) の複合にしようとしています。既存の created_at 単独のインデックスは消してよいですか？",
  ),
  question(3, "API-8", "codex", 41, "リトライ上限を 5 回にしようとしています。既存の設定値 3 回と食い違いますが、5 回に揃えてよいですか？"),
  question(
    4,
    "BLOG-2",
    "claude-code",
    120,
    "画像の生成に外部 API（有料）を使ってよいですか？使わない場合は Canvas で描画しますが、日本語のフォントを同梱するためリポジトリが約 8MB 増え、記事ごとの生成にも数秒かかります。どちらを選ぶか、使うなら月の上限額も決めてください。",
  ),
  question(5, "API-9", "me", 600, "機能そのものを採用するか", "採用する"),
  question(6, "API-9", "me", 600, "デフォルト値は 0 限定か任意整数か", "0 限定"),
  question(7, "API-9", "me", 600, "required 設定との意味論"),
  question(8, "API-9", "me", 600, "画面に見せるか（プレースホルダー / プリフィル）"),
  question(9, "API-9", "me", 600, "設定の置き場所と名前"),
  question(10, "API-9", "me", 600, "公開 YAML と API スキーマの初期許可範囲"),
  question(11, "API-7", "claude-code", 70, "署名の検証に失敗したときは 401 と 400 のどちらを返しますか？", "401"),
];

export function findIssue(id: string): Issue | undefined {
  return ISSUES.find((i) => i.id === id);
}

export function questionsOf(issueId: string): Question[] {
  return QUESTIONS.filter((q) => q.issueId === issueId);
}
