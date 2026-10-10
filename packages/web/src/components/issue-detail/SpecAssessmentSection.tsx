import { useState } from "react";
import { errorMessage } from "../../api/errors";
import { useAssessSpec } from "../../api/hooks/spec-assessment";
import { useWorkspaces } from "../../api/hooks/shared";
import type { Issue } from "../../api/types";
import { Button } from "../ui";
import { formatDateTime } from "../../lib/format";
import s from "./issue-detail.module.css";

const failures: Record<string, string> = {
  missing_key: "APIキーが未設定です", authentication: "認証に失敗しました", network: "通信に失敗しました",
  timeout: "待機時間を超えました", rate_limit: "利用上限に達しました", http_error: "サービスが正常に応答しませんでした",
  invalid_response: "応答形式が不正です", stale: "判定中に本文が変更されました", disabled: "自動判定が無効になりました", inactive: "Issueが完了・キャンセル・アーカイブされました",
};

export function SpecAssessmentSection({ issue }: { issue: Issue }) {
  const workspaces = useWorkspaces();
  const enabled = workspaces.data?.find(w => w.key === issue.workspace)?.specAssessmentEnabled;
  const assess = useAssessSpec(issue.id);
  const [error, setError] = useState<string | null>(null);
  const assessment = issue.specAssessment;
  async function retry() {
    setError(null);
    try { await assess.mutateAsync(); } catch (err) { setError(errorMessage(err)); }
  }
  const canAssess = enabled && !issue.archivedAt && !["done", "canceled"].includes(issue.status);
  return <section className={s.section} aria-label="仕様要否判定">
    <h2 className={s.sectionTitle}>仕様要否判定</h2>
    {assess.isPending ? <p role="status">判定の応答を待っています…</p> : !assessment ? <p className={s.muted}>対象外（未判定）</p> :
      <AssessmentRecord assessment={assessment} />}
    {!enabled && <p className={s.muted}>Workspace の自動判定は無効です。記録とラベルは保持されます。</p>}
    {assessment?.status === "completed" && <p className={s.muted}>判定は記録時の本文に対する結果です。現在のラベルは人間が管理します。</p>}
    {canAssess && <Button disabled={assess.isPending} onClick={() => void retry()}>
      {assessment?.status === "completed" || assessment?.recordOnly ? "判定を再評価（ラベルは変更しません）" : assessment ? "判定を再試行" : "このIssueを判定"}
    </Button>}
    {error && <p role="alert">{error}</p>}
    {!!assessment?.history?.length && <details><summary>過去の判定記録（{assessment.history.length}件）</summary>
      {assessment.history.map(record => <AssessmentRecord key={record.generation} assessment={record} />)}
    </details>}
  </section>;
}

function AssessmentRecord({ assessment: a }: { assessment: NonNullable<Issue["specAssessment"]> }) {
  return <div>
    <p>{a.status === "pending" ? "判定待ち" : a.status === "failed" ? `判定失敗：${failures[a.failureKind ?? ""] ?? "判定できませんでした"}` :
      `判定済み：${(a.probability ?? 0) >= a.threshold ? "仕様整理が必要" : "本文で実装可能"}（確率 ${a.probability}）`}</p>
    <details><summary>判定条件と記録</summary>
      <p>モデル：{a.model} / 基準版：{a.criteriaVersion} / 閾値：{a.threshold}</p>
      <p>要求時刻：{formatDateTime(a.requestedAt)}{a.finishedAt && ` / 終了時刻：${formatDateTime(a.finishedAt)}`}</p>
      <p>本文識別情報：<code>{a.bodyHash}</code> / 要求世代：{a.generation}</p>
      <p>入力token：{a.inputTokens ?? "未取得"} / 所要時間：{a.elapsedMs === null ? "未取得" : `${a.elapsedMs} ms`}</p>
      {a.recordOnly && <p>記録のみ（ラベルの自動変更なし）</p>}
    </details>
  </div>;
}
