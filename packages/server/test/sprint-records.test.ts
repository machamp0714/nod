import { expect, test } from "bun:test";
import { createIssue, initWorkspace, updateIssue } from "@nod/core";
import { createApp } from "../src/app";
import { call, setup, tempDir } from "./helpers";
import { openDb } from "@nod/core";
import { join } from "node:path";
import { legacySprintFixture } from "../../core/test/fixtures/sprint";

async function recordSprint(phase: "draft" | "ready" | "active" = "active") {
  const f = setup();
  const clock = { now: new Date("2026-10-30T03:00:00.000Z") };
  const app = createApp({ db: f.db, sprintClock: clock });
  await call(app, "PUT", `/api/workspaces/${f.ws.key}/scrum`, { expectedVersion: 0, requestKey: "設定", enabled: true, problem: "成果が不明", productGoal: "成果を確認", priorityRationale: "記録を優先" });
  const draft = (await call(app, "POST", "/api/sprints", { workspaceKey: f.ws.key, startDate: "2026-10-30", endDate: "2026-10-30", timezone: "Asia/Tokyo", expectedVersion: 0, requestKey: "作成" })).json;
  const issue = createIssue(f.me, { workspaceId: f.ws.id, title: "成果を記録" });
  if (phase === "draft") return { ...f, app, clock, sprint: draft, issue };
  const added = (await call(app, "POST", `/api/sprints/${draft.id}/candidates`, { expectedVersion: draft.version, requestKey: "候補", issueRef: issue.id })).json;
  const proposed = (await call(app, "POST", `/api/sprints/${draft.id}/plans`, { expectedVersion: added.sprint.version, requestKey: "計画", goal: "成果を確認", verificationMethod: "記録を再取得", items: [{ itemId: added.item.id, contribution: "成果を確認", executionPlan: "記録する" }], definitionOfDone: [{ id: "確認", text: "記録を閲覧" }], constraints: { executionScope: "Workspace", maxParallel: 1, notes: "既存権限" }, changeReason: "初期計画" })).json;
  const ready = (await call(app, "POST", `/api/sprints/${draft.id}/plans/${proposed.plan.id}/accept`, { expectedVersion: proposed.sprint.version, requestKey: "合意", contentHash: proposed.plan.contentHash })).json.sprint;
  if (phase === "ready") return { ...f, app, clock, sprint: ready, issue };
  const sprint = (await call(app, "POST", `/api/sprints/${draft.id}/activate`, { expectedVersion: ready.version, requestKey: "開始" })).json;
  return { ...f, app, clock, sprint, issue };
}

test("成果のリンク・要約・試し方・テスト結果を保存して再取得できる", async () => {
  const { db, app, sprint, issue } = await recordSprint();
  try {
    const path = `/api/sprints/${sprint.id}/records`;
    const content = { summary: "成果画面を追加", howToTry: "Sprint詳細から成果と評価を開く", tests: "HTTP APIで保存して再取得", testResult: "passed", links: [{ kind: "issue", ref: issue.id, label: "関連Issue" }, { kind: "document", ref: "755", label: "仕様" }, { kind: "url", ref: "https://github.com/example/nod/pull/41", label: "PR" }] };
    const saved = await call(app, "POST", path, { requestKey: "成果", kind: "outcome", content });
    expect(saved).toMatchObject({ status: 201, json: { sprintId: sprint.id, kind: "outcome", content, recordedBy: "me", recordedAt: "2026-10-30T03:00:00.000Z", correctsRecordId: null } });
    expect(await call(app, "GET", path)).toEqual({ status: 200, json: [saved.json] });
  } finally { db.close(); }
});

test("成果の訂正を追記しても元記録・計画・候補・実行・次Sprintを変更しない", async () => {
  const { db, app, sprint, clock } = await recordSprint();
  try {
    const base = `/api/sprints/${sprint.id}`, path = `${base}/records`;
    const before = (await call(app, "GET", base)).json;
    const execution = (await call(app, "GET", `${base}/execution`)).json;
    const allSprints = (await call(app, "GET", "/api/sprints")).json;
    const input = { requestKey: "元の成果", kind: "outcome", content: { summary: "合格と記録", testResult: "passed" } };
    const original = await call(app, "POST", path, input);
    expect(await call(app, "POST", path, input)).toEqual(original);
    clock.now = new Date("2026-10-31T03:00:00.000Z");
    const correction = await call(app, "POST", path, { requestKey: "訂正", kind: "outcome", correctsRecordId: original.json.id, content: { summary: "未確認の範囲を発見", testResult: "unverified" } });
    expect(correction).toMatchObject({ status: 201, json: { correctsRecordId: original.json.id, recordedBy: "me", recordedAt: "2026-10-31T03:00:00.000Z" } });
    expect((await call(app, "GET", path)).json).toEqual([original.json, correction.json]);
    expect((await call(app, "GET", base)).json).toEqual(before);
    // 観測時刻を元に戻し、記録の追記による実行・計画の変更だけを確認する。
    clock.now = new Date("2026-10-30T03:00:00.000Z");
    expect((await call(app, "GET", `${base}/execution`)).json).toEqual(execution);
    expect((await call(app, "GET", "/api/sprints")).json).toEqual(allSprints);
    expect((await call(app, "POST", path, { ...input, content: { summary: "異なる再送" } })).status).toBe(409);
    expect((await call(app, "POST", path, { ...input, requestKey: "不明な訂正元", correctsRecordId: "存在しない記録" })).status).toBe(400);
    expect((await call(app, "GET", path)).json).toEqual([original.json, correction.json]);
  } finally { db.close(); }
});

test("終了後・中止後も成果を追記でき、終了時の残件とSprintの状態を保持する", async () => {
  for (const operation of ["end", "cancel"]) {
    const { db, app, sprint, clock } = await recordSprint();
    try {
      clock.now = new Date("2026-10-30T15:00:00.000Z");
      const base = `/api/sprints/${sprint.id}`;
      expect((await call(app, "POST", `${base}/${operation}`, { expectedVersion: sprint.version, requestKey: "終了操作", reason: "区切りを記録" })).status).toBe(200);
      const closed = (await call(app, "GET", base)).json;
      clock.now = new Date("2027-10-30T15:00:00.000Z");
      expect((await call(app, "POST", `${base}/records`, { requestKey: "後日の成果", kind: "outcome", content: { summary: "後日の確認" } })).status).toBe(201);
      expect((await call(app, "GET", `${base}/records`)).json).toHaveLength(1);
      expect((await call(app, "GET", base)).json).toEqual(closed);
    } finally { db.close(); }
  }
});

test("下書き・準備済みSprintへの記録と空の記録や入力actorの偽装を拒否する", async () => {
  for (const phase of ["draft", "ready", "active"] as const) {
    const { db, app, sprint } = await recordSprint(phase);
    try {
      const path = `/api/sprints/${sprint.id}/records`;
      const input = { requestKey: "記録", kind: "outcome", content: { summary: "成果" } };
      if (phase !== "active") expect((await call(app, "POST", path, input)).status).toBe(409);
      for (const extra of [{ actor: "me" }, { recordedBy: "claude-code" }, { recordedAt: "2000-01-01" }]) {
        expect((await call(app, "POST", path, { ...input, ...extra })).status).toBe(400);
      }
      for (const content of [{}, { summary: " \n " }, { testResult: "passed" }]) {
        expect((await call(app, "POST", path, { ...input, content })).status).toBe(400);
      }
      expect((await call(app, "GET", path)).json).toEqual([]);
    } finally { db.close(); }
  }
});

test("成果記録の保存に失敗したら成功を返さず、同じ入力で再試行できる", async () => {
  const { db, app, sprint } = await recordSprint();
  try {
    const base = `/api/sprints/${sprint.id}`, path = `${base}/records`;
    const before = (await call(app, "GET", base)).json;
    // DB境界の書込み拒否をHTTPから観測する。
    db.exec("CREATE TRIGGER 成果保存拒否 BEFORE INSERT ON sprint_records BEGIN SELECT RAISE(ABORT,'成果を保存できません'); END");
    const input = { requestKey: "失敗後の再試行", kind: "outcome", content: { summary: "入力を保持" } };
    expect((await call(app, "POST", path, input)).status).toBe(500);
    expect((await call(app, "GET", path)).json).toEqual([]);
    expect((await call(app, "GET", base)).json).toEqual(before);
    db.exec("DROP TRIGGER 成果保存拒否");
    expect((await call(app, "POST", path, input)).status).toBe(201);
    expect((await call(app, "GET", path)).json).toMatchObject([{ content: { summary: "入力を保持" } }]);
  } finally { db.close(); }
});

test("結果を省略した新しい成果は未確認になり、他の成果やDoneから合格を流用しない", async () => {
  const { db, app, sprint, issue, me } = await recordSprint();
  try {
    const path = `/api/sprints/${sprint.id}/records`;
    updateIssue(me, issue.id, { status: "done" });
    expect((await call(app, "POST", path, { requestKey: "前の成果", kind: "outcome", content: { summary: "前の成果", testResult: "passed" } })).status).toBe(201);
    const saved = await call(app, "POST", path, { requestKey: "次の成果", kind: "outcome", content: { summary: "新しい成果", links: [{ kind: "issue", ref: issue.id }] } });
    expect(saved).toMatchObject({ status: 201, json: { content: { testResult: "unverified", howToTry: "", tests: "" } } });
    expect((await call(app, "GET", path)).json.map((r: any) => r.content.testResult)).toEqual(["passed", "unverified"]);
    expect((await call(app, "POST", path, { requestKey: "不合格", kind: "outcome", content: { tests: "保存でエラー", testResult: "failed" } })).json.content.testResult).toBe("failed");
    for (const testResult of [null, "done", "merged"]) {
      expect((await call(app, "POST", path, { requestKey: "不正結果", kind: "outcome", content: { summary: "結果", testResult } })).status).toBe(400);
    }
  } finally { db.close(); }
});

test("既存の数字始まりWorkspaceのIssueも参照でき、不正なリンクは記録しない", async () => {
  const { db, app, sprint, me } = await recordSprint();
  try {
    const ws = initWorkspace(db, { key: "42", path: "/tmp/repos/numbered" }).workspace;
    const issue = createIssue(me, { workspaceId: ws.id, title: "数字のキーのIssue" });
    const path = `/api/sprints/${sprint.id}/records`;
    const input = { requestKey: "数字Issue", kind: "outcome", content: { links: [{ kind: "issue", ref: issue.id }] } };
    expect(await call(app, "POST", path, input)).toMatchObject({ status: 201, json: { content: { links: [{ kind: "issue", ref: "42-1" }] } } });
    for (const link of [{ kind: "url", ref: "javascript:alert(1)" }, { kind: "url", ref: "/documents/755" }, { kind: "document", ref: "abc" }, { kind: "issue", ref: "存在しない形式" }]) {
      expect((await call(app, "POST", path, { ...input, requestKey: "不正なリンク", content: { links: [link] } })).status).toBe(400);
    }
    expect((await call(app, "GET", path)).json).toHaveLength(1);
  } finally { db.close(); }
});

test("旧Cycleから移行したSprintは閲覧だけでき、記録を追加できない", async () => {
  const path = join(tempDir(), "nod.db");
  legacySprintFixture(path);
  const db = openDb(path);
  const app = createApp({ db });
  try {
    const sprints = (await call(app, "GET", "/api/sprints")).json;
    const sprint = sprints.find((row: any) => row.phase === "imported");
    const base = `/api/sprints/${sprint.id}`;
    const before = (await call(app, "GET", base)).json;
    expect((await call(app, "GET", `${base}/records`)).json).toEqual([]);
    expect((await call(app, "POST", `${base}/records`, { requestKey: "移行履歴", kind: "outcome", content: { summary: "履歴に追加しない" } })).status).toBe(409);
    expect((await call(app, "GET", base)).json).toEqual(before);
    expect((await call(app, "GET", `${base}/records`)).json).toEqual([]);
  } finally { db.close(); }
});
