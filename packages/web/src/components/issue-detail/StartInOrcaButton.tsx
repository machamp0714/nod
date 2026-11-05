import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../api/errors";
import { useWorktreeName } from "../../api/hooks/github";
import { useCreateOrcaWorktree } from "../../api/hooks/orca";
import type { OrcaWorktreeResult } from "../../api/types";
import { defaultFeature, sanitizeFeature } from "../../lib/orca-feature";
import { Button, Icon } from "../ui";
import s from "./issue-detail.module.css";

// プロパティの実行場所の行の「Omp で作業を始める」（#210、NOD-61、nod.pen「Orcaで作業を始める｜入力・作成中・失敗」Y7Eyr）。
// 実行場所が未記録のときだけ値の位置に出す。押すと直下のポップオーバーで feature 名を決め、Orca に worktree を作って Omp を起動する。
// エージェントは選ばせず、Workspace の設定にも依存しない（起動先は常に Omp。NOD-61 でエージェントの選択欄を撤去した）。
// 成功すると Issue に実行場所が記録され、行は「Orca で開く」付きの表示に変わる（onCreated でフォーカスの移し先を親に任せる）。
// 失敗したら理由を上に出し、入力は残す
export function StartInOrcaButton({ issueId, title, disabled, onCreated }: {
  issueId: string;
  title: string;
  disabled: boolean;
  onCreated: (result: OrcaWorktreeResult) => void;
}) {
  const create = useCreateOrcaWorktree(issueId);
  const [open, setOpen] = useState(false);
  const [feature, setFeature] = useState("");
  const preview = useWorktreeName(issueId, feature);
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
    if (!open) { setFeature(defaultFeature(title)); setError(""); }
    setOpen(!open);
  }
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  async function submit() {
    if (busy) return;
    setError("");
    try {
      const result = await create.mutateAsync({ feature });
      if (result.created) { setOpen(false); onCreated(result); }
      else setError(result.failure?.message ?? "理由は分かりません");
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <span className={s.propMenuRoot} ref={root}>
      <Button ref={trigger} size="sm" icon="play" className={s.orcaStartButton} disabled={disabled} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popoverId : undefined} onClick={toggle}>
        Omp で作業を始める
      </Button>
      {open && (
        <form id={popoverId} className={s.orcaStartPopover} role="dialog" aria-label="Omp で作業を始める"
          onSubmit={(e) => { e.preventDefault(); void submit(); }}
          onKeyDown={(e) => { if (e.key === "Escape" && !e.nativeEvent.isComposing && !busy) { e.preventDefault(); close(); } }}>
          {error && <p role="alert" className={s.orcaStartError}><Icon name="circle-alert" size={14} />作成できませんでした：{error}</p>}
          <div className={s.orcaStartField}>
            <label className={s.orcaStartLabel} htmlFor={`orca-feature-${issueId}`}>feature 名（任意）</label>
            <input ref={input} id={`orca-feature-${issueId}`} className={s.orcaStartInput} autoComplete="off" spellCheck={false}
              aria-describedby={preview.data ? previewId : undefined}
              value={feature} disabled={busy} onChange={(e) => setFeature(sanitizeFeature(e.target.value))} />
            {preview.data && <div id={previewId} className={s.orcaStartField}>
              <span className={s.orcaStartPreview}>Orca の表示名<span className={s.orcaStartDisplayName}>{preview.data.displayName}</span></span>
              <span className={s.orcaStartPreview}>ディレクトリ・ブランチの作成名<span className={s.orcaStartName}>{preview.data.name}</span></span>
            </div>}
          </div>
          <p className={s.orcaStartNote}>worktree を作り、Orca で Omp のセッションを起動します。IDを入力欄に入れ、送信はしません。</p>
          <div className={s.orcaStartActions}>
            <Button size="sm" disabled={busy} onClick={close}>キャンセル</Button>
            <Button type="submit" variant="primary" disabled={busy}>{busy ? "作成中…" : "作成して起動"}</Button>
          </div>
        </form>
      )}
    </span>
  );
}
