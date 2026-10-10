import { expect, test } from "bun:test";
import { setup, codeOf } from "./helpers";
import { createIssue, getIssue, listIssues } from "../src/ops/issues";
import { setWorkspaceSpecAssessment, findWorkspace } from "../src/ops/workspaces";
import { assessCreatedIssue } from "../src/ops/spec-assessment";
import { startIssue, suggestIssue, nextIssue } from "../src/ops/agent";
import { declineTriage, duplicateTriage } from "../src/ops/human";
import { updateIssue } from "../src/ops/issues";
import type { JevResult } from "../src/ops/jev-client";

for (const decision of ["decline", "duplicate"] as const) {
  test(`Triageの${decision}後に再開しても取消前の判定応答を適用しない`, async () => {
    const { db, ws, me, llm } = setup();
    const original = createIssue(me, { workspaceId: ws.id, title: "元のIssue" });
    setWorkspaceSpecAssessment(me, ws.key, true);
    const issue = createIssue(llm, { workspaceId: ws.id, title: "判定中のIssue" });
    let resolve!: (result: JevResult) => void;
    const pending = assessCreatedIssue(me, issue.id, () => new Promise(r => { resolve = r; }));
    if (decision === "decline") declineTriage(me, issue.id);
    else duplicateTriage(me, issue.id, original.id);
    updateIssue(me, issue.id, { status: "todo" });
    resolve({ kind: "success", probability: 0.9, model: "jev-1.13.0", inputTokens: 1, elapsedMs: 1 });
    await pending;
    const result = getIssue(db, issue.id);
    expect(result.specAssessment).toMatchObject({ status: "failed", failureKind: "inactive", suspended: true });
    expect(result.labels).toEqual([]);
    expect(startIssue(me, issue.id).status).toBe("in_progress");
  });
}

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

test("初回失敗の明示再試行は同じIssueで回復し、完了後の再評価はラベルを変えない", async () => {
  const { db, ws, me, llm } = setup();
  setWorkspaceSpecAssessment(me, ws.key, true);
  const issue = createIssue(me, { workspaceId: ws.id, title: "再試行" });
  await assessCreatedIssue(me, issue.id, async () => ({ kind: "failed", failureKind: "timeout", elapsedMs: 5 }));
  const { retryIssueAssessment } = await import("../src/ops/spec-assessment");
  const success = async () => ({ kind: "success" as const, probability: 1, model: "jev-1.13.0", inputTokens: 1, elapsedMs: 1 });
  expect((await retryIssueAssessment(llm, issue.id, success)).labels).toEqual(["needs-spec"]);
  const { updateIssue } = await import("../src/ops/issues");
  updateIssue(me, issue.id, { removeLabels: ["needs-spec"] });
  expect((await retryIssueAssessment(me, issue.id, success)).labels).toEqual([]);
  expect(getIssue(db, issue.id).specAssessment?.history?.length).toBe(2);
});

test("本文A→B→Aでも古い応答を採用せず最新本文の明示再試行で回復する", async () => {
  const { ws, me } = setup();
  setWorkspaceSpecAssessment(me, ws.key, true);
  const issue = createIssue(me, { workspaceId: ws.id, title: "本文競合", description: "A" });
  let resolve!: (result: any) => void;
  const pending = assessCreatedIssue(me, issue.id, () => new Promise(r => resolve = r));
  const { updateIssue } = await import("../src/ops/issues");
  updateIssue(me, issue.id, { description: "B" });
  updateIssue(me, issue.id, { description: "A" });
  resolve({ kind: "success", probability: 1, model: "jev-1.13.0", inputTokens: 1, elapsedMs: 1 });
  const stale = await pending;
  expect(stale.specAssessment).toMatchObject({ status: "failed", failureKind: "stale" });
  expect(stale.labels).toEqual([]);
  const { retryIssueAssessment } = await import("../src/ops/spec-assessment");
  const recovered = await retryIssueAssessment(me, issue.id, async () => ({ kind: "success", probability: 0, model: "jev-1.13.0", inputTokens: 1, elapsedMs: 1 }));
  expect(recovered.specAssessment?.status).toBe("completed");
  updateIssue(me, issue.id, { description: "変更後" });
  expect(startIssue(me, issue.id).status).toBe("in_progress");
});

test("並行再試行の古い応答は新しい結果を上書きしない", async () => {
  const { ws, me } = setup();
  setWorkspaceSpecAssessment(me, ws.key, true);
  const issue = createIssue(me, { workspaceId: ws.id, title: "並行" });
  const { retryIssueAssessment } = await import("../src/ops/spec-assessment");
  let resolve!: (result: any) => void;
  const old = retryIssueAssessment(me, issue.id, () => new Promise(r => resolve = r));
  await retryIssueAssessment(me, issue.id, async () => ({ kind: "success", probability: 0, model: "jev-1.13.0", inputTokens: 1, elapsedMs: 1 }));
  resolve({ kind: "success", probability: 1, model: "jev-1.13.0", inputTokens: 1, elapsedMs: 1 });
  const result = await old;
  expect(result.specAssessment?.probability).toBe(0);
  expect(result.labels).toEqual([]);
});

for (const change of ["label", "off-on", "done", "canceled", "archive"] as const) {
  test(change + "中の遅延応答は人間の操作を上書きしない", async () => {
    const { db, ws, me } = setup();
    setWorkspaceSpecAssessment(me, ws.key, true);
    const issue = createIssue(me, { workspaceId: ws.id, title: "遅延" });
    let resolve!: (result: any) => void;
    const pending = assessCreatedIssue(me, issue.id, () => new Promise(r => resolve = r));
    const { updateIssue, archiveIssue } = await import("../src/ops/issues");
    if (change === "label") {
      updateIssue(me, issue.id, { addLabels: ["needs-spec"] });
      updateIssue(me, issue.id, { removeLabels: ["needs-spec"] });
    } else if (change === "off-on") {
      setWorkspaceSpecAssessment(me, ws.key, false);
      setWorkspaceSpecAssessment(me, ws.key, true);
    } else if (change === "archive") archiveIssue(me, issue.id);
    else updateIssue(me, issue.id, { status: change });
    resolve({ kind: "success", probability: 1, model: "jev-1.13.0", inputTokens: 1, elapsedMs: 1 });
    expect((await pending).labels).toEqual([]);
    expect(getIssue(db, issue.id).specAssessment).not.toBeNull();
    if (change === "off-on") expect(startIssue(me, issue.id).status).toBe("in_progress");
  });
}

test("既存対象外Issueは個別判定でき、無効時の明示要求はAPIを呼ばない", async () => {
  const { ws, me } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "既存" });
  const { retryIssueAssessment } = await import("../src/ops/spec-assessment");
  let calls = 0;
  const client = async () => { calls++; return { kind: "success" as const, probability: 1, model: "jev-1.13.0", inputTokens: 1, elapsedMs: 1 }; };
  await expect(retryIssueAssessment(me, issue.id, client)).rejects.toThrow();
  expect(calls).toBe(0);
  setWorkspaceSpecAssessment(me, ws.key, true);
  expect((await retryIssueAssessment(me, issue.id, client)).labels).toEqual(["needs-spec"]);
});

test("OFF→ONでは既に失敗した判定による着手制限も復活させず履歴を保持する", async () => {
  const { ws, me } = setup();
  setWorkspaceSpecAssessment(me, ws.key, true);
  const issue = createIssue(me, { workspaceId: ws.id, title: "設定変更" });
  await assessCreatedIssue(me, issue.id, async () => ({ kind: "failed", failureKind: "timeout", elapsedMs: 5 }));
  setWorkspaceSpecAssessment(me, ws.key, false);
  setWorkspaceSpecAssessment(me, ws.key, true);
  expect(startIssue(me, issue.id).status).toBe("in_progress");
});
