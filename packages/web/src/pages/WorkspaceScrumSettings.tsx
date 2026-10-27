import { SprintEditConflict } from "../components/sprints/SprintEditConflict";
import { useState } from "react";
import type { ScrumWorkspace } from "@nod/core";
import { errorMessage } from "../api/errors";
import { useScrumWorkspace, useSprintCommand } from "../api/hooks/sprint-planning";
import { Button } from "../components/ui";
import s from "./workspace-settings.module.css";
import f from "../components/planning/planning.module.css";

export function WorkspaceScrumSettings({ workspaceKey }: { workspaceKey: string }) {
  const data = useScrumWorkspace(workspaceKey);
  return <section className={s.section} aria-label="Sprintの方向設定">
    <h2 className={s.sectionTitle}>Sprintの方向設定</h2>
    <p className={s.description}>問題・目標・優先順位を保存し、Sprintの計画に使います。</p>
    {data.error && <p role="alert">{errorMessage(data.error)} <Button onClick={() => void data.refetch()}>再読み込み</Button></p>}
    {data.data ? <DirectionForm key={workspaceKey} workspaceKey={workspaceKey} saved={data.data} /> : !data.error && <p role="status">読み込み中…</p>}
  </section>;
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
