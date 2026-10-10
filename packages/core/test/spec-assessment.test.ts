import { expect, test } from "bun:test";
import { setup, codeOf } from "./helpers";
import { createIssue, getIssue, listIssues } from "../src/ops/issues";
import { setWorkspaceSpecAssessment, findWorkspace } from "../src/ops/workspaces";
import { assessCreatedIssue } from "../src/ops/spec-assessment";
import { startIssue, suggestIssue, nextIssue } from "../src/ops/agent";

test("設定は既定OFFで人間だけが変更でき、既存Issueへ遡及しない", () => {
  const { db, ws, me, llm } = setup();
  expect(findWorkspace(db, ws.key)?.specAssessmentEnabled).toBe(false);
  const old = createIssue(me, { workspaceId: ws.id, title: "既存" });
  expect(codeOf(() => setWorkspaceSpecAssessment(llm, ws.key, true))).toBe("FORBIDDEN_FOR_LLM");
  setWorkspaceSpecAssessment(me, ws.key, true);
  expect(getIssue(db, old.id).specAssessment).toBeNull();
  expect(startIssue(me, old.id).status).toBe("in_progress");
});

test("有効な起票はpendingを保存しtransaction外で本文だけを判定して閾値以上でラベルを付ける", async () => {
  const { db, ws, me } = setup();
  setWorkspaceSpecAssessment(me, ws.key, true);
  const created = createIssue(me, { workspaceId: ws.id, title: "題名", description: "本文" });
  expect(created.specAssessment?.status).toBe("pending");
  const issue = await assessCreatedIssue(me, created.id, async body => {
    expect(body).toBe("本文");
    expect(db.inTransaction).toBe(false);
    expect(getIssue(db, created.id).specAssessment?.status).toBe("pending");
    return { kind: "success", probability: 0.5, model: "jev-1.13.0", inputTokens: 123, elapsedMs: 18 };
  });
  expect(issue.labels).toEqual(["needs-spec"]);
  expect(issue.specAssessment).toMatchObject({ status: "completed", probability: 0.5, threshold: 0.5, criteriaVersion: "needs-spec-v1", inputTokens: 123, elapsedMs: 18 });
  expect(issue.specAssessment?.bodyHash).toMatch(/^[a-f0-9]{64}$/);
  expect(startIssue(me, issue.id).status).toBe("in_progress");
});

test("pendingと失敗は候補と着手から除き、OFFなら制限を解除する", async () => {
  const { db, ws, me, llm } = setup();
  setWorkspaceSpecAssessment(me, ws.key, true);
  const issue = createIssue(me, { workspaceId: ws.id, title: "保存される" });
  for (const ctx of [me, llm]) expect(codeOf(() => startIssue(ctx, issue.id))).toBe("SPEC_ASSESSMENT_REQUIRED");
  expect(listIssues(db, { workspaceId: ws.id, ready: true })).toEqual([]);
  expect(suggestIssue(me, { workspaceId: ws.id })).toBeNull();
  expect(nextIssue(me, { workspaceId: ws.id })).toBeNull();
  const failed = await assessCreatedIssue(me, issue.id, async () => ({ kind: "failed", failureKind: "authentication", elapsedMs: 1 }));
  expect(failed.id).toBe(issue.id);
  expect(failed.specAssessment).toMatchObject({ status: "failed", failureKind: "authentication" });
  expect(codeOf(() => startIssue(me, issue.id))).toBe("SPEC_ASSESSMENT_REQUIRED");
  setWorkspaceSpecAssessment(me, ws.key, false);
  expect(startIssue(me, issue.id).status).toBe("in_progress");
});

test("無効時は外部呼出しをせず、閾値未満でも既存ラベルを削除しない", async () => {
  const { ws, me } = setup();
  const disabled = createIssue(me, { workspaceId: ws.id, title: "対象外" });
  await assessCreatedIssue(me, disabled.id, async () => { throw new Error("呼ばれてはいけない"); });
  expect(disabled.specAssessment).toBeNull();
  setWorkspaceSpecAssessment(me, ws.key, true);
  for (const labels of [[], ["needs-spec"]]) {
    const created = createIssue(me, { workspaceId: ws.id, title: "小修正", labels });
    const assessed = await assessCreatedIssue(me, created.id, async () => ({ kind: "success", probability: 0.49, model: "jev-1.13.0", inputTokens: 1, elapsedMs: 1 }));
    expect(assessed.labels).toEqual(labels);
    expect(assessed.specAssessment?.status).toBe("completed");
  }
});

for (const failureKind of ["missing_key", "authentication", "network", "timeout", "rate_limit", "http_error", "invalid_response"] as const) {
  test(`${failureKind}でも作成したIssueと安全な失敗種別を保持する`, async () => {
    const { db, ws, me } = setup();
    setWorkspaceSpecAssessment(me, ws.key, true);
    const created = createIssue(me, { workspaceId: ws.id, title: "保存される", description: "入力内容" });
    const result = await assessCreatedIssue(me, created.id, async () => ({ kind: "failed", failureKind, elapsedMs: 5 }));
    expect(result).toMatchObject({ id: created.id, description: "入力内容", specAssessment: { status: "failed", failureKind } });
    expect(getIssue(db, created.id).labels).toEqual([]);
  });
}

test("外部clientの例外本文を返さずnetworkとして保存する", async () => {
  const { ws, me } = setup();
  setWorkspaceSpecAssessment(me, ws.key, true);
  const created = createIssue(me, { workspaceId: ws.id, title: "保存される" });
  const result = await assessCreatedIssue(me, created.id, async () => { throw new Error("secret-value"); });
  expect(result.specAssessment?.failureKind).toBe("network");
  expect(JSON.stringify(result)).not.toContain("secret-value");
});
