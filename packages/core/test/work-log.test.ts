import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { findIssueRow, loadActivity } from "../src/issue-query";
import { commentIssue, createIssue, logWork } from "../src/ops/issues";
import { MIGRATIONS } from "../src/schema";
import { detectSecret, WORK_LOG_KINDS, WORK_LOG_MAX_LENGTH } from "../src/work-log";
import { codeOf, setup, tempDbPath } from "./helpers";

function issue() {
  const s = setup();
  const created = createIssue(s.me, { workspaceId: s.ws.id, title: "a" });
  return { ...s, id: created.id };
}

function comments(s: ReturnType<typeof issue>) {
  return loadActivity(s.db, findIssueRow(s.db, s.id).id).filter((a) => a.kind === "comment");
}

describe("作業ログの種類", () => {
  test("種類の固定リストは 経過・方針・判断根拠・実行コマンド・テスト結果・ブロッカー", () => {
    expect([...WORK_LOG_KINDS]).toEqual(["progress", "plan", "rationale", "command", "test", "blocker"]);
  });

  test("種類を付けて記録すると、返り値と Activity に logKind が載る", () => {
    const s = issue();
    const c = logWork(s.llm, s.id, "索引を足す方針にした", { kind: "plan" });
    expect(c).toMatchObject({ body: "索引を足す方針にした", author: "claude-code", logKind: "plan", parentId: null });
    expect(comments(s)).toMatchObject([{ kind: "comment", body: "索引を足す方針にした", logKind: "plan" }]);
  });

  test("種類を省略すると progress（経過）になる", () => {
    const s = issue();
    expect(logWork(s.llm, s.id, "調べ始めた").logKind).toBe("progress");
  });

  test("リスト外の種類は INVALID_ARGS で、何も保存しない", () => {
    const s = issue();
    expect(codeOf(() => logWork(s.llm, s.id, "x", { kind: "thought" }))).toBe("INVALID_ARGS");
    expect(comments(s)).toEqual([]);
  });

  test("通常のコメントは logKind が null（種類なし）", () => {
    const s = issue();
    expect(commentIssue(s.me, s.id, "コメント").logKind).toBeNull();
    expect(comments(s)).toMatchObject([{ logKind: null }]);
  });

  test("空の本文は INVALID_ARGS", () => {
    const s = issue();
    expect(codeOf(() => logWork(s.llm, s.id, "  "))).toBe("INVALID_ARGS");
  });
});

describe("作業ログの長文", () => {
  test(`上限は ${WORK_LOG_MAX_LENGTH} 文字で、超えると INVALID_ARGS で Document を案内し、切り詰めずに保存しない`, () => {
    const s = issue();
    expect(WORK_LOG_MAX_LENGTH).toBe(4000);
    expect(logWork(s.llm, s.id, "あ".repeat(4000)).body.length).toBe(4000);
    let message = "";
    try {
      logWork(s.llm, s.id, "あ".repeat(4001));
    } catch (e) {
      expect((e as { code: string }).code).toBe("INVALID_ARGS");
      message = (e as Error).message;
    }
    expect(message).toContain("nod doc create");
    expect(comments(s)).toHaveLength(1);
  });

  test("文字数はコードポイントで数え、サロゲートペアの文字も 1 文字にする", () => {
    const s = issue();
    expect(logWork(s.llm, s.id, "𠮷".repeat(4000)).body).toBe("𠮷".repeat(4000));
    let message = "";
    try {
      logWork(s.llm, s.id, "𠮷".repeat(4001));
    } catch (e) {
      expect((e as { code: string }).code).toBe("INVALID_ARGS");
      message = (e as Error).message;
    }
    expect(message).toContain("4001 文字");
    expect(comments(s)).toHaveLength(1);
  });
});

describe("作業ログの機微情報", () => {
  const secrets = [
    "ghp_" + "a".repeat(36),
    "github_pat_" + "A1b2".repeat(10),
    "sk-" + "x".repeat(40),
    "sk-ant-api03-" + "y".repeat(30),
    "AKIA" + "ABCDEFGHIJKLMNOP",
    "xoxb-1234567890-abcdefghij",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN PGP PRIVATE KEY BLOCK-----",
    "sk-proj-" + "Ab1_".repeat(12),
  ];

  test.each(secrets)("%s を含むと SECRET_DETECTED で拒否し、保存しない", (secret) => {
    const s = issue();
    expect(detectSecret(`token=${secret}`)).not.toBeNull();
    expect(codeOf(() => logWork(s.llm, s.id, `実行結果: token=${secret}`, { kind: "command" }))).toBe("SECRET_DETECTED");
    expect(comments(s)).toEqual([]);
  });

  test("拒否のメッセージに秘密値そのものを出さない", () => {
    expect.assertions(3);
    const s = issue();
    const secret = "ghp_" + "b".repeat(36);
    try {
      logWork(s.llm, s.id, secret);
    } catch (e) {
      expect((e as { code: string }).code).toBe("SECRET_DETECTED");
      expect((e as Error).message).not.toContain(secret);
    }
    expect(comments(s)).toEqual([]);
  });

  test("似ているが秘密値でない語は通す", () => {
    for (const text of ["risk-based の判断", "ask-question を使う", "AKIA の形式を調べた", "BEGIN PUBLIC KEY", "xoxo"]) {
      expect(detectSecret(text)).toBeNull();
    }
  });

  test("パスやブランチ名・単語の途中の sk- は秘密値とみなさない", () => {
    const s = issue();
    for (const text of [
      "cd ~/sk-learn-experiments-notebooks-2026",
      "git switch feature/sk-learn-pipeline-refactor-fix",
      "foo-sk-learn-pipeline-refactor-module",
      "~sk-learn-pipeline-refactor-module-x",
    ]) {
      expect([text, detectSecret(text)]).toEqual([text, null]);
      expect(logWork(s.llm, s.id, text, { kind: "command" }).body).toBe(text);
    }
  });
});

describe("作業ログの移行", () => {
  test("DB では固定リスト外の種類を入れられない", () => {
    const s = issue();
    logWork(s.llm, s.id, "a");
    expect(() => s.db.exec("UPDATE comments SET log_kind = 'thought'")).toThrow();
  });

  test("旧版（種類なし）の DB を開くと列が足され、既存のログは種類なしのまま残る", () => {
    const path = tempDbPath();
    // 種類を足す版の直前までを適用した DB を作る（後ろに版が追記されても壊れないよう、版は探して決める）
    const version = MIGRATIONS.findIndex((steps) =>
      steps.some((step) => typeof step === "string" && step.includes("ADD COLUMN log_kind")),
    );
    expect(version).toBeGreaterThan(0);
    const raw = new Database(path, { create: true });
    raw.exec("PRAGMA foreign_keys = ON");
    for (const steps of MIGRATIONS.slice(0, version)) {
      for (const step of steps) {
        if (typeof step === "string") raw.exec(step);
        else step(raw);
      }
    }
    raw.exec(`PRAGMA user_version = ${version}`);
    // 旧版で書かれた既存のコメント・作業ログを入れておく
    const at = "2026-09-01T00:00:00.000Z";
    raw.exec(`INSERT INTO workspaces (id, key, name, path, color, created_at) VALUES (1, 'OLD', 'old', '/tmp/old', '#3B82F6', '${at}')`);
    raw.exec(
      `INSERT INTO issues (id, workspace_id, number, title, status, created_by, created_at, updated_at)
       VALUES (1, 1, 1, '旧', 'todo', 'me', '${at}', '${at}')`,
    );
    raw.exec(`INSERT INTO comments (id, issue_id, author, body, created_at) VALUES (1, 1, 'me', '旧コメント', '${at}')`);
    raw.exec(`INSERT INTO comments (id, issue_id, author, body, created_at) VALUES (2, 1, 'claude-code', '旧ログ', '${at}')`);
    raw.close();
    const db = openDb(path);
    const cols = (db.query("PRAGMA table_info(comments)").all() as { name: string; notnull: number }[]).filter(
      (c) => c.name === "log_kind",
    );
    expect(cols).toEqual([expect.objectContaining({ name: "log_kind", notnull: 0 })]);
    expect(db.query("SELECT id, body, log_kind FROM comments ORDER BY id").all()).toEqual([
      { id: 1, body: "旧コメント", log_kind: null },
      { id: 2, body: "旧ログ", log_kind: null },
    ]);
    const activity = loadActivity(db, 1).filter((a) => a.kind === "comment");
    expect(activity).toMatchObject([
      { body: "旧コメント", logKind: null },
      { body: "旧ログ", logKind: null },
    ]);
  });
});
