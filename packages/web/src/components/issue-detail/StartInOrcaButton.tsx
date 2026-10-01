import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../api/errors";
import { useCreateOrcaWorktree } from "../../api/hooks/orca";
import { useWorkspaces } from "../../api/hooks/shared";
import type { OrcaAgent } from "../../api/types";
import { defaultFeature, ORCA_AGENT_OPTIONS, orcaAgentLabel, sanitizeFeature, worktreeName } from "../../lib/orca-feature";
import { Button, Icon, RadioPills } from "../ui";
import s from "./issue-detail.module.css";

// プロパティの実行場所の行の「Orca で作業を始める」（#210、nod.pen「Orcaで作業を始める｜入力・作成中・失敗」Y7Eyr）。
// 実行場所が未記録のときだけ値の位置に出す。押すと直下のポップオーバーで feature 名とエージェントを決め、Orca に worktree を作ってエージェントを起動する。
// エージェントの初期値は Workspace の既定で、ここで選び直しても既定は変わらない（選択欄は nod.pen に見本がなく、既存の部品にならった）。
// 成功すると Issue に実行場所が記録され、行は「Orca で開く」付きの表示に変わる（onCreated でフォーカスの移し先を親に任せる）。
// 失敗したら理由を上に出し、入力は残す
export function StartInOrcaButton({ issueId, workspaceKey, title, disabled, onCreated }: {
  issueId: string;
  workspaceKey: string;
  title: string;
  disabled: boolean;
  onCreated: () => void;
}) {
  const workspaces = useWorkspaces();
  const defaultAgent = workspaces.data?.find((w) => w.key === workspaceKey)?.defaultAgent ?? "claude";
  const [agent, setAgent] = useState<OrcaAgent>("claude");
  const create = useCreateOrcaWorktree(issueId);
  const [open, setOpen] = useState(false);
  const [feature, setFeature] = useState("");
  const [error, setError] = useState("");
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const busy = create.isPending;
  const popoverId = `orca-start-${issueId}`;
  const previewId = `orca-start-preview-${issueId}`;
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    // 作成中は閉じない（結果を出す場所を残す）
    const outside = (event: PointerEvent) => { if (!busy && !root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, busy]);

  function toggle() {
    // 作成中は閉じない（結果と入力を失わない）
    if (busy) return;
    if (!open) { setFeature(defaultFeature(title)); setAgent(defaultAgent); setError(""); }
    setOpen(!open);
  }
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  async function submit() {
    if (busy || feature === "") return;
    setError("");
    try {
      const result = await create.mutateAsync({ feature, agent });
      if (result.created) { setOpen(false); onCreated(); }
      else setError(result.failure?.message ?? "理由は分かりません");
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <span className={s.propMenuRoot} ref={root}>
      <Button ref={trigger} size="sm" icon="play" className={s.orcaStartButton} disabled={disabled} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popoverId : undefined} onClick={toggle}>
        Orca で作業を始める
      </Button>
      {open && (
        <form id={popoverId} className={s.orcaStartPopover} role="dialog" aria-label="Orca で作業を始める"
          onSubmit={(e) => { e.preventDefault(); void submit(); }}
          onKeyDown={(e) => { if (e.key === "Escape" && !e.nativeEvent.isComposing && !busy) { e.preventDefault(); close(); } }}>
          {error && <p role="alert" className={s.orcaStartError}><Icon name="circle-alert" size={14} />作成できませんでした：{error}</p>}
          <div className={s.orcaStartField}>
            <label className={s.orcaStartLabel} htmlFor={`orca-feature-${issueId}`}>feature 名</label>
            <input ref={input} id={`orca-feature-${issueId}`} className={s.orcaStartInput} autoComplete="off" spellCheck={false}
              aria-describedby={feature ? previewId : undefined}
              value={feature} disabled={busy} onChange={(e) => setFeature(sanitizeFeature(e.target.value))} />
            {feature && <span id={previewId} className={s.orcaStartPreview}>作成される名前<span className={s.orcaStartName}>{worktreeName(issueId, feature)}</span></span>}
          </div>
          <div className={s.orcaStartField}>
            <span className={s.orcaStartLabel}>エージェント</span>
            <RadioPills label="エージェント" name={`orca-agent-${issueId}`} items={ORCA_AGENT_OPTIONS} value={agent} disabled={busy} onChange={setAgent} />
          </div>
          <p className={s.orcaStartNote}>worktree を作り、{orcaAgentLabel(agent)} のセッションを起動します。</p>
          <div className={s.orcaStartActions}>
            <Button size="sm" disabled={busy} onClick={close}>キャンセル</Button>
            <Button type="submit" variant="primary" disabled={busy || feature === ""}>{busy ? "作成中…" : "作成して起動"}</Button>
          </div>
        </form>
      )}
    </span>
  );
}
