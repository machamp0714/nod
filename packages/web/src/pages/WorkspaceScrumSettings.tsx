import { SprintEditConflict } from "../components/sprints/SprintEditConflict";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { ScrumWorkspace, SprintRolloverStatus } from "@nod/core";
import { errorMessage } from "../api/errors";
import { useScrumWorkspace, useSetSprintRollover, useSprintCommand, useSprintRolloverStatus } from "../api/hooks/sprint-planning";
import { Button } from "../components/ui";
import { rolloverSuccessorPlan, sprintLinkLabel } from "../lib/sprint-rollover";
import s from "./workspace-settings.module.css";
import f from "../components/planning/planning.module.css";

export function WorkspaceScrumSettings({ workspaceKey }: { workspaceKey: string }) {
  const data = useScrumWorkspace(workspaceKey);
  return <>
    <section className={s.section} aria-label="Sprintの方向設定">
      <h2 className={s.sectionTitle}>Sprintの方向設定</h2>
      <p className={s.description}>問題・目標・優先順位を保存し、Sprintの計画に使います。</p>
      {data.error && <p role="alert">{errorMessage(data.error)} <Button onClick={() => void data.refetch()}>再読み込み</Button></p>}
      {data.data ? <DirectionForm key={workspaceKey} workspaceKey={workspaceKey} saved={data.data} /> : !data.error && <p role="status">読み込み中…</p>}
    </section>
    <RolloverSettings workspaceKey={workspaceKey} saved={data.data} />
  </>;
}

// 期限到来時の自動引継ぎ。方向設定とは別の、値だけを変える操作（人だけ。LLM は変更できない）。
// 状態は読取専用で、設定値・次に処理する時刻・後継の予定・止まっている理由を出す
function RolloverSettings({ workspaceKey, saved }: { workspaceKey: string; saved: ScrumWorkspace | undefined }) {
  const status = useSprintRolloverStatus(workspaceKey);
  const save = useSetSprintRollover(workspaceKey);
  // 方向設定を一度も保存していないWorkspaceには、切り替える設定の行がまだ無い
  const unsaved = saved?.version === 0;
  // 保存して状態を読み直すまでは、選んだ値を出す（読み直しの後は保存済みの値に戻す。失敗したときも保存済みの値に戻る）
  const [requested, setRequested] = useState<boolean | null>(null);
  const enabled = requested ?? status.data?.enabled ?? saved?.autoRollover ?? false;
  return <section className={s.section} aria-label="期限到来時の自動引継ぎ">
    <h2 className={s.sectionTitle}>期限到来時の自動引継ぎ</h2>
    <p className={s.description}>Sprintの期間が終わったら自動で終了し、後継のSprintへ未完了の所属を引き継いで、期間が始まっていれば合意なしで開始します。LLM は設定を変更できません。</p>
    <label><input type="checkbox" checked={enabled} disabled={!saved || unsaved || requested !== null}
      onChange={e => {
        const next = e.target.checked;
        setRequested(next); save.reset();
        void save.mutateAsync(next).catch(() => {}).finally(() => setRequested(null));
      }} /> 期限到来時に自動で引き継ぐ</label>
    {unsaved && <p className={s.description}>先に方向設定を保存すると切り替えられます。</p>}
    {save.error && <p role="alert">自動引継ぎの設定を保存できませんでした：{errorMessage(save.error)}</p>}
    {status.error && <p role="alert">自動引継ぎの状態を取得できません：{errorMessage(status.error)} <Button onClick={() => void status.refetch()}>再読み込み</Button></p>}
    {status.data ? <RolloverStatusList status={status.data} /> : !status.error && <p role="status">読み込み中…</p>}
  </section>;
}
function RolloverStatusList({ status }: { status: SprintRolloverStatus }) {
  const plan = rolloverSuccessorPlan(status.successor);
  return <dl className={s.rolloverStatus} aria-label="自動引継ぎの状態">
    <dt>設定</dt><dd>{status.enabled ? "有効" : "無効"}</dd>
    <dt>次に処理する時刻</dt><dd>{status.nextRunAt
      ? <><time dateTime={status.nextRunAt}>{new Date(status.nextRunAt).toLocaleString("ja-JP")}</time>
        <span className={s.description}>（この時刻以降の次の契機（アプリの起動時と1分ごと、CLIの実行時）に処理します。この時刻ちょうどの実行は保証しません）</span></>
      : "予定なし"}</dd>
    <dt>後継の予定</dt><dd>{plan.text}{plan.sprint && <>：<Link to="/sprints/$sprintId" params={{ sprintId: plan.sprint.id }}>{sprintLinkLabel(plan.sprint)}</Link></>}</dd>
    <dt>止まっている理由</dt><dd>{status.blocked?.message ?? "なし"}</dd>
  </dl>;
}
function DirectionForm({ workspaceKey, saved }: { workspaceKey: string; saved: ScrumWorkspace }) {
  const [version, setVersion] = useState(saved.version);
  const [problem, setProblem] = useState(saved.problem ?? "");
  const [goal, setGoal] = useState(saved.productGoal ?? "");
  const [rationale, setRationale] = useState(saved.priorityRationale ?? "");
  const [enabled, setEnabled] = useState(saved.enabled);
  const [message, setMessage] = useState("");
  const save = useSprintCommand<ScrumWorkspace>();
  return <form aria-label="方向設定" onSubmit={event => {
    event.preventDefault(); if (save.isPending) return;
    setMessage("");
    void save.run(`/workspaces/${encodeURIComponent(workspaceKey)}/scrum`, { expectedVersion: version, enabled, problem, productGoal: goal, priorityRationale: rationale }, "PUT").then(result => { setVersion(result.version); setMessage("保存しました"); }, () => {});
  }}>
    <fieldset disabled={save.isPending} style={{ border: 0, padding: 0, display: "grid", gap: 12 }}>
      <label className={f.field}>解決したい問題<textarea className={f.input} required value={problem} onChange={e => setProblem(e.target.value)} /></label>
      <label className={f.field}>プロダクトの目標<textarea className={f.input} required value={goal} onChange={e => setGoal(e.target.value)} /></label>
      <label className={f.field}>優先順位の根拠<textarea className={f.input} required value={rationale} onChange={e => setRationale(e.target.value)} /></label>
      <label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Sprint運用を有効にする</label>
      <div><Button style={{ minHeight: 32 }} type="submit" variant="primary" disabled={save.isPending}>{save.isPending ? "保存中…" : "方向設定を保存"}</Button></div>
    </fieldset>
    {save.error && <p role="alert">保存できませんでした。入力を保持しています：{errorMessage(save.error)}。方向設定を保存から再試行してください。</p>}
    <SprintEditConflict error={save.error} onContinue={() => { setVersion(saved.version); save.reset(); }}><p>版：{saved.version} / 問題：{saved.problem} / 目標：{saved.productGoal} / 優先順位：{saved.priorityRationale} / 運用：{saved.enabled ? "有効" : "無効"}</p></SprintEditConflict>
    {message && <p role="status">{message}</p>}
  </form>;
}
