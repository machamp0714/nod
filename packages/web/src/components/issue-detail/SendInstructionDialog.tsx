import { useEffect, useId, useRef, useState } from "react";
import { errorMessage } from "../../api/errors";
import { useAgentTargets, useRecordInstruction, useSendInstruction } from "../../api/hooks/orca";
import type { AgentInstruction, OrcaTerminal } from "../../api/types";
import { Button, Icon } from "../ui";
import s from "./issue-detail.module.css";

// 追加指示（#51）の宛先の表示。agent は担当の LLM、location は記録済みの実行場所（無ければ null）
export interface InstructionTarget {
  issueId: string;
  agent: string;
  location: string | null;
}

// 何を送るか。new はまだ記録していない本文（記録してから送る）、existing は記録済みの指示（再送・差し戻しの対応依頼）
export type SendTarget = { kind: "new"; body: string } | { kind: "existing"; instruction: AgentInstruction };

// 追加指示の送信確認（#51・#58、Pencil『送信確認』yHueZ）。開くたびに orca で宛先を調べ直し、
// 宛先が1件なら内容の確認、複数なら選択、0件なら記録のみを示す。送信はこの画面の「送信」からだけ行う
export function SendInstructionDialog({
  issueId,
  agent,
  target,
  title,
  onClose,
  onDone,
}: {
  issueId: string;
  agent: string; // 宛先の名前（担当の LLM。未設定なら端末の agentIdentity）
  target: SendTarget;
  title?: string; // 送信するかを尋ねる見出しを差し替える（差し戻しの対応依頼など）
  onClose: () => void;
  onDone: (result: { recorded: AgentInstruction; sent: boolean; sendFailed: boolean }) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const targets = useAgentTargets(issueId, true);
  const record = useRecordInstruction(issueId);
  const send = useSendInstruction(issueId);
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false); // 同じティックの2回目のクリックは state の反映前に届くため、ref で止める
  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal();
  }, []);

  const terminals = targets.data?.terminals ?? [];
  const selected = terminals.find((t) => t.handle === chosen) ?? terminals[0];
  const existing = target.kind === "existing" ? target.instruction : null;
  const body = existing ? existing.body : target.kind === "new" ? target.body : "";
  const unconfirmed = existing?.sendState === "unconfirmed";

  async function run(withSend: boolean) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    let recorded = existing;
    try {
      recorded ??= await record.mutateAsync(body);
      if (!withSend || !selected) {
        onDone({ recorded, sent: false, sendFailed: false });
        return;
      }
      const result = await send.mutateAsync({ instructionId: recorded.id, terminal: selected.handle, confirmResend: unconfirmed });
      onDone({ recorded: result, sent: result.sendState === "sent", sendFailed: result.sendState !== "sent" });
    } catch (e) {
      // 記録はできて送信で失敗したときは、記録済みの指示を送り直せるよう、閉じて Activity に状態を出す
      if (recorded && !existing) onDone({ recorded, sent: false, sendFailed: true });
      else setError(`${recorded ? "送信" : "記録"}できませんでした：${errorMessage(e)}`);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  const loading = targets.isPending;
  const none = !loading && terminals.length === 0;
  const reason = targets.data?.failure && targets.data.failure.code !== "NO_TERMINAL" ? `（${targets.data.failure.message}）` : "";
  const heading = loading
    ? "送信先を確認しています…"
    : none
      ? existing ? "送信先の端末がありません" : "追加指示を記録しますか？"
      : terminals.length > 1
        ? "送信先を選んでください"
        : (title ?? `${agent} に追加指示を送信しますか？`);

  return (
    <dialog
      ref={ref}
      className={s.sendDialog}
      aria-labelledby={titleId}
      aria-busy={loading || busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className={s.sendDialogBody}>
        <div className={s.sendDialogText}>
          <h2 id={titleId} className={s.sendDialogTitle}>{heading}</h2>
          {none && (
            <p className={s.sendDialogMessage}>
              {existing
                ? `送信先の端末がありません${reason}。LLM は次の start/show で読みます`
                : `送信先の端末がありません${reason}。記録のみ行い、LLM は次の start/show で読みます`}
            </p>
          )}
          {!loading && terminals.length === 1 && selected && <Destination agent={agent} terminal={selected} worktree={targets.data?.worktree ?? null} />}
          {terminals.length > 1 && (
            <div role="radiogroup" aria-label="送信先" className={s.sendDestinations}>
              {terminals.map((t) => (
                <label key={t.handle} className={`${s.sendRadio} ${selected?.handle === t.handle ? s.sendRadioChecked : ""}`}>
                  <input type="radio" name={`${titleId}-target`} checked={selected?.handle === t.handle} onChange={() => setChosen(t.handle)} />
                  <span className={s.sendRadioText}>
                    <span className={s.sendRadioTarget}>{t.agentIdentity} · {t.title || t.handle}</span>
                    <span className={s.sendRadioDetail}>{t.handle} · {t.worktreePath ?? targets.data?.worktree}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          {unconfirmed && !none && (
            <p className={s.sendDialogWarning}>
              <Icon name="circle-alert" size={13} />
              前回の送信は届いたか分かりません。Orca の端末で届いていないことを確かめてから送信してください
            </p>
          )}
          <div className={s.sendPreview}>
            <span className={s.sendPreviewLabel}>本文プレビュー</span>
            <p>{body}</p>
          </div>
          {targets.isError && <p className={s.error} role="alert">送信先を確認できませんでした：{errorMessage(targets.error)}</p>}
          {error && <p className={s.error} role="alert">{error}</p>}
        </div>
        <div className={s.sendDialogButtons}>
          {loading ? (
            // 宛先を調べている間は、押す位置で意味が変わらないよう、キャンセルと無効な送信だけを出す
            <>
              <Button onClick={onClose}>キャンセル</Button>
              <Button variant="primary" disabled>送信</Button>
            </>
          ) : none ? (
            <>
              <Button onClick={onClose} disabled={busy}>{existing ? "閉じる" : "キャンセル"}</Button>
              {!existing && <Button variant="primary" disabled={busy} onClick={() => void run(false)}>記録のみ</Button>}
            </>
          ) : (
            <>
              {existing ? (
                <Button onClick={onClose} disabled={busy}>キャンセル</Button>
              ) : (
                <Button disabled={busy} onClick={() => void run(false)}>記録のみ</Button>
              )}
              <Button variant="primary" disabled={busy || !selected} onClick={() => void run(true)}>送信</Button>
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}

function Destination({ agent, terminal, worktree }: { agent: string; terminal: OrcaTerminal; worktree: string | null }) {
  const rows: [string, string][] = [
    ["宛先", agent],
    ["端末", `${terminal.agentIdentity} · ${terminal.title || terminal.handle}`],
    ["handle", terminal.handle],
    ["worktree", terminal.worktreePath ?? worktree ?? ""],
  ];
  return (
    <dl className={s.sendKv}>
      {rows.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd className={key === "handle" || key === "worktree" ? s.sendKvMono : undefined}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
