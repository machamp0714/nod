import type { Database } from "bun:sqlite";
import { shellQuote, writeEvaluationEnv } from "./shell-env";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  askQuestion, createIssue, getIssue, initWorkspace,
  openDb, relateIssue, retryIssueAssessment, setWorkspaceSpecAssessment, updateIssue,
} from "../../../../../packages/core/src";
import { addActiveSprint } from "../../../../../packages/core/test/fixtures/sprint";

const ROOT = resolve(import.meta.dir, "../../../../..");

/** 一時DBと外部CLIの偽接続先を作る。PMの選定判断はここでは行わない。 */
export type BeforeSprintAdoption = (db: Database, directory: string) => void;

export async function createTask1Scenario(directory?: string, beforeAdoption?: BeforeSprintAdoption) {
  const dir = directory ? resolve(directory) : realpathSync(mkdtempSync(join(tmpdir(), "nod-pm-eval-")));
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "bin");
  const apiPath = join(dir, "api");
  const otherPath = join(dir, "other");
  for (const path of [bin, apiPath, otherPath]) mkdirSync(path, { recursive: true });
  const dbPath = join(dir, "nod.db");
  const db = openDb(dbPath);
  const human = { db, actor: "me" };
  const agent = { db, actor: "codex" };
  const api = initWorkspace(db, { path: apiPath, key: "API" }).workspace;
  const other = initWorkspace(db, { path: otherPath, key: "OTH" }).workspace;

  const names = [
    "一覧の余白を調整", "未確定の集計仕様", "人が担当する変更", "Claudeが担当する変更",
    "別セッションのCodex作業", "未受け入れの提案", "保持期間の確認", "前提の整備待ち",
    "人が進めている前提の整備", "初回判定が未完了", "初回判定が失敗 [再試行も失敗]",
    "自動判定導入前の変更", "判定制限が解除された変更", "任意再評価だけが失敗した変更", "本番DBの更新",
  ];
  // 12は設定を有効にする前に起票し、既存Issueへの遡及なしを再現する。
  const issues = names.map((title, index) => createIssue(index === 5 ? agent : human, {
    workspaceId: api.id, title, labels: index === 1 ? ["needs-spec"] : [],
    description: index === 14
      ? "本番DBへ接続して既存データを更新する運用作業。コード変更は不要。実行の可否を人に確認する。"
      : `${title}。対象は一覧画面。余白を8pxから12pxへ変更し、画面で反映を確認する。`,
  }));
  setWorkspaceSpecAssessment(human, "API", true);
  const success = async () => ({ kind: "success" as const, probability: 0, model: "jev-1.13.0", inputTokens: 2, elapsedMs: 1 });
  const failure = async () => ({ kind: "failed" as const, failureKind: "network" as const, elapsedMs: 1 });
  // 起票後の初回要求にはpublicな再判定APIを使う。初回のpendingは非同期完了前を再現する。
  for (const [index, issue] of issues.entries()) {
    if (index === 9 || index === 11) continue;
    await retryIssueAssessment(human, issue.id, index === 10 || index === 12 ? failure : success);
  }
  setWorkspaceSpecAssessment(human, "API", false);
  setWorkspaceSpecAssessment(human, "API", true);
  await retryIssueAssessment(human, "API-14", failure);
  // suspendedは失敗中に設定を無効化した13だけに残り、11は実効的な初回失敗に戻す。
  await retryIssueAssessment(human, "API-11", failure);
  // 判定サービスから応答が返らない境界を再現する。初回pendingの保存までは同期的に進む。
  void retryIssueAssessment(human, "API-10", () => new Promise<never>(() => {}));
  for (const [id, assignee] of [["API-3", "me"], ["API-4", "claude-code"], ["API-5", "codex"], ["API-9", "me"]]) {
    updateIssue(human, id!, { assignee });
  }
  askQuestion(human, "API-7", "保持期間を30日か90日か、人が決めてください。");
  relateIssue(human, "API-9", { blocks: "API-8" });
  const next = createIssue(human, { workspaceId: api.id, title: "次Sprintの候補" });
  const outside = createIssue(human, { workspaceId: other.id, title: "別Workspaceの変更" });
  // 既存実行や質問待ちの準備は採択前に行う。採択後の通常着手guardは通過させない。
  beforeAdoption?.(db, dir);
  // Sprintの外部状態は評価専用の内部fixture。本番の合意・開始許可を表さない。
  const imported = crypto.randomUUID();
  db.query(`INSERT INTO sprints(id,number,name,phase,start_date,end_date,created_at,updated_at)
    VALUES(?,1,'移行履歴','imported','2026-09-01','2026-09-14','2026-09-01','2026-09-01')`).run(imported);
  const current = addActiveSprint(db, api.id, 2, issues.map(issue => issue.id));
  const draft = crypto.randomUUID();
  db.query(`INSERT INTO sprints(id,number,workspace_id,name,phase,start_date,end_date,timezone,created_at,updated_at)
    VALUES(?,3,?,'次の計画','draft','2999-01-01','2999-01-14','UTC','2026-10-01','2026-10-01')`).run(draft, api.id);
  addActiveSprint(db, other.id, 4, [outside.id]);
  // imported、draft、現在Sprintの未採択候補だけではcurrentの集合へ入らない。
  const nextRow = db.query("SELECT * FROM issues WHERE workspace_id=? AND number=?").get(api.id, next.number) as { id: number };
  const snapshot = JSON.stringify({ schemaVersion: 1, capturedAt: new Date().toISOString(), statusBasis: "migration_snapshot", issue: nextRow, workspace: { id: api.id, key: api.key, name: api.name }, labels: [], project: null });
  for (const sprint of [imported, draft, current]) {
    db.query("INSERT INTO sprint_items VALUES(?,?,?,?,?,?)").run(crypto.randomUUID(), sprint, nextRow.id, next.id, snapshot, sprint === imported ? 'imported' : 'candidate');
  }
  for (const item of [...issues, outside]) {
    const row = db.query("SELECT * FROM issues WHERE number=? AND workspace_id=?").get(item.number, item.workspace === "API" ? api.id : other.id);
    const workspace = item.workspace === "API" ? api : other;
    db.query("UPDATE sprint_items SET snapshot=? WHERE source_issue_key=?").run(JSON.stringify({ schemaVersion: 1, issue: row, workspace, labels: getIssue(db, item.id).labels, project: null }), item.id);
  }
  db.close();

  const log = join(dir, "operations.jsonl");
  writeFileSync(log, "");
  const preloadSource = `globalThis.fetch = async (_input, init) => {
    if (String(init?.body).includes("再試行も失敗")) throw new Error("評価用の通信失敗");
    return Response.json({model:"jev-1.13.0", answers:{needs_spec:{type:"noul",noul:0}},usage:{input_tokens:2}});
  };\n`;
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    NOD_DB: dbPath, NOD_ACTOR: "codex", NOD_ORCA: "0", NOD_GH: join(bin, "gh"),
    NOD_DOCS_DIR: join(dir, "documents"), NOD_ATTACHMENTS_DIR: join(dir, "attachments"),
    PM_EVAL_DIR: dir, PM_EVAL_LOG: log, PM_EVAL_BUN: process.execPath,
    PM_EVAL_NOD_MAIN: join(ROOT, "packages/cli/src/main.ts"),
    // BUN_OPTIONSは空白入りpathを分割するため、偽APIをpath不要のmoduleとして渡す。
    TYPESAFE_API_KEY: "evaluation-only", BUN_OPTIONS: `--preload=data:text/javascript;base64,${Buffer.from(preloadSource).toString("base64")}`,
  };
  for (const name of ["nod", "orca", "gh"]) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\nexec ${shellQuote(process.execPath)} --no-env-file ${shellQuote(join(import.meta.dir, "fake-cli.ts"))} ${shellQuote(name)} "$@"\n`);
    chmodSync(path, 0o755);
  }
  writeEvaluationEnv(dir, env);
  return { dir, bin, dbPath, log, nod: join(bin, "nod"), orca: join(bin, "orca"), gh: join(bin, "gh"), env: { ...process.env, ...env } };
}

if (import.meta.main) {
  const scenario = await createTask1Scenario(process.argv[2]);
  console.log(JSON.stringify({ directory: scenario.dir, source: join(scenario.dir, "env.sh"), operations: scenario.log }, null, 2));
}
