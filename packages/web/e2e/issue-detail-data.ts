// データセット issue-detail の ID と文面。
// Playwright のテスト（Node）とデータセット（Bun）の両方が import するため、ほかのモジュールを import しない。

export const LLM_ACTOR = "claude-code";

export const ISSUE = {
  clarify: "API-1",
  addQuestion: "API-2",
  description: "API-3",
  properties: "API-4",
  comment: "API-5",
  llmQuestion: "API-6",
  stale: "API-7",
  empty: "API-8",
  external: "API-9",
  main: "API-12",
  child: "API-13",
} as const;

export const DOC = { spec: 1, plan: 2, missing: 3 } as const;

export const MAIN_TITLE = "検索 API の N+1 を解消";
export const CHILD_TITLE = "workspace の取得をまとめる";
export const PROJECT_NAME = "検索 API の高速化";

export const CLARIFY_QUESTIONS = ["デフォルト値は 0 限定か任意整数か", "画面に見せるか（プレースホルダー / プリフィル）"] as const;
export const LLM_QUESTION = "リトライ上限を 5 回にしようとしています。既存の設定値 3 回と食い違いますが、5 回に揃えてよいですか？";
export const STALE_QUESTION = "キャッシュの有効期限は 5 分でよいか";
export const MAIN_ANSWERED_QUESTION = "計測は本番相当のデータで行いますか？";
export const MAIN_ANSWER = "ステージングのダンプで計測してください";
export const MAIN_OPEN_QUESTION =
  "インデックスを (workspace_id, created_at) の複合にしようとしています。既存の created_at 単独のインデックスは消してよいですか？";
export const MAIN_COMMENT = "N+1 の原因は検索結果ごとの workspace 取得だった。IN 句で一括取得すれば 2 クエリに減らせる。";

// Workspace のリポジトリからの相対パス
export const SPEC_FILE = "docs/specs/2026-09-20-search-performance.md";
export const PLAN_FILE = "docs/plans/2026-09-27-search-n1.md";
export const MISSING_FILE = "docs/specs/2026-09-27-nod-design.md";
