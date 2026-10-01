import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  answerQuestion,
  askQuestion,
  attachDocument,
  commentIssue,
  createIssue,
  type CreateIssueInput,
  createProject,
  getIssue,
  HUMAN_ACTOR,
  importPlan,
  initWorkspace,
  type OpCtx,
  relateIssue,
  setStep,
  startIssue,
  updateIssue,
} from "@nod/core";
import {
  CHILD_TITLE,
  CLARIFY_QUESTIONS,
  DOC,
  ISSUE,
  LLM_ACTOR,
  LLM_QUESTION,
  MAIN_ANSWER,
  MAIN_ANSWERED_QUESTION,
  MAIN_COMMENT,
  MAIN_OPEN_QUESTION,
  MAIN_TITLE,
  MISSING_FILE,
  PLAN_FILE,
  PROJECT_NAME,
  SPEC_FILE,
  STALE_QUESTION,
} from "../issue-detail-data";
import type { Dataset } from "../support/dataset";

const MAIN_DESCRIPTION = `/search で結果1件ごとに workspace を取得しているため、件数に比例してクエリが増える。

## 受け入れ条件

- 100 件の検索でクエリが 3 回以下
- p95 が 200ms 以下`;

const SPEC_BODY = `# 検索 API の高速化 設計

## 目的

/search の p95 を 200ms 以下にする。
計測は本番相当のデータで行う。

## 方針

- 結果ごとの workspace の取得をまとめる
- (workspace_id, created_at) の複合インデックスを足す
`;

const PLAN_BODY = `# 検索 API の N+1 解消 実装計画

### Task 1: 調査

- [x] **Step 1: 遅いクエリを洗い出す**
- [x] **Step 2: N+1 の箇所を特定する**

### Task 2: インデックス設計

- [x] **Step 1: 既存のインデックスを洗い出す**
- [ ] **Step 2: 複合インデックスの案を作る**
- [ ] **Step 3: 移行の手順を書く**

### Task 3: 実装

- [ ] **Step 1: 取得を1回のクエリにまとめる**
- [ ] **Step 2: インデックスを足すマイグレーションを書く**

### Task 4: 計測

- [ ] **Step 1: ステージングのダンプで p95 を測る**
`;

function expectId(actual: string | number, expected: string | number, what: string): void {
  if (actual !== expected) throw new Error(`issue-detail: ${what} の ID が ${expected} ではなく ${actual} になった`);
}

function writeRepoFile(repo: string, file: string, body: string): string {
  const path = join(repo, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

// ID は作った順に振られるため、順番を変えると issue-detail-data.ts の ID とずれる。
// DB を空にする処理はデータの口が先に行う（H）。
const dataset: Dataset = ({ db, repo: repoOf }) => {
  const me: OpCtx = { db, actor: HUMAN_ACTOR };
  const llm: OpCtx = { db, actor: LLM_ACTOR };
  const repo = repoOf("api-server");
  const { workspace } = initWorkspace(db, { path: repo, key: "API", name: "api-server" });
  const project = createProject(me, { name: PROJECT_NAME, description: "p95 を 200ms 以下にする" });
  const create = (title: string, input: Partial<CreateIssueInput> = {}) =>
    createIssue(me, { workspaceId: workspace.id, title, ...input });

  expectId(create("数値入力のデフォルト値を 0 で補完する").id, ISSUE.clarify, "clarify");
  for (const question of CLARIFY_QUESTIONS) askQuestion(me, ISSUE.clarify, question);

  expectId(create("OpenAPI の説明文を更新する").id, ISSUE.addQuestion, "addQuestion");
  expectId(create("README の手順を直す", { description: "初期の説明" }).id, ISSUE.description, "description");

  expectId(create("レート制限の残り回数をヘッダーで返す").id, ISSUE.properties, "properties");
  updateIssue(me, ISSUE.properties, { status: "backlog" });

  expectId(create("ログの出力先を揃える").id, ISSUE.comment, "comment");
  updateIssue(me, ISSUE.comment, { priority: 1, addLabels: ["docs"], description: "ログの出力先を1か所にまとめる" });

  expectId(create("決済 Webhook の再送処理", { priority: 3 }).id, ISSUE.llmQuestion, "llmQuestion");
  startIssue(llm, ISSUE.llmQuestion, { location: { branch: "fix-webhook-retry", worktree: repoOf("fix-webhook-retry") } });
  askQuestion(llm, ISSUE.llmQuestion, LLM_QUESTION);

  expectId(create("キャッシュの有効期限を決める").id, ISSUE.stale, "stale");
  askQuestion(me, ISSUE.stale, STALE_QUESTION);

  expectId(create("空の Issue").id, ISSUE.empty, "empty");
  expectId(create("外から書き込まれる Issue").id, ISSUE.external, "external");

  // API-12 を A のダミーデータと同じ ID にするための Issue
  for (const n of [10, 11]) {
    const filler = create(`番号を揃えるための Issue ${n}`);
    updateIssue(me, filler.id, { status: "canceled" });
  }

  const main = create(MAIN_TITLE, { description: MAIN_DESCRIPTION, projectRef: String(project.id), priority: 2, labels: ["perf"] });
  expectId(main.id, ISSUE.main, "main");
  startIssue(llm, ISSUE.main, { location: { branch: "feat-search-n1", worktree: repoOf("feat-search-n1") } });

  const spec = attachDocument(llm, { issueRef: ISSUE.main }, { path: writeRepoFile(repo, SPEC_FILE, SPEC_BODY), kind: "spec" });
  expectId(spec.id, DOC.spec, "spec の Document");
  importPlan(llm, ISSUE.main, writeRepoFile(repo, PLAN_FILE, PLAN_BODY));
  setStep(llm, ISSUE.main, "2.2", "doing");
  const missingPath = writeRepoFile(repo, MISSING_FILE, "# nod 設計\n\n本文\n");
  const missing = attachDocument(me, { issueRef: ISSUE.main }, { path: missingPath, kind: "spec" });
  expectId(missing.id, DOC.missing, "消えたファイルの Document");
  rmSync(missingPath);
  const plan = getIssue(db, ISSUE.main).documents.find((d) => d.kind === "plan");
  expectId(plan?.id ?? -1, DOC.plan, "plan の Document");

  const answered = askQuestion(llm, ISSUE.main, MAIN_ANSWERED_QUESTION);
  answerQuestion(me, ISSUE.main, MAIN_ANSWER, { questionId: answered.question.id });
  commentIssue(llm, ISSUE.main, MAIN_COMMENT);
  askQuestion(llm, ISSUE.main, MAIN_OPEN_QUESTION);

  const child = create(CHILD_TITLE, { parentRef: ISSUE.main, projectRef: String(project.id), priority: 2 });
  expectId(child.id, ISSUE.child, "child");
  relateIssue(me, ISSUE.main, { blocks: ISSUE.child });
};

export default dataset;
