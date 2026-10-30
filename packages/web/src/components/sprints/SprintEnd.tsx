import { useRef, useState } from "react";
import type { Sprint } from "@nod/core";
import { useSprintCommand } from "../../api/hooks/sprint-planning";
import { errorMessage } from "../../api/errors";
import { FormDialog } from "../planning/FormDialog";
import { Button } from "../ui";
import s from "../planning/planning.module.css";

export function SprintEnd({ sprint, deadlineReached }: { sprint: Sprint; deadlineReached: boolean }) {
  const [open, setOpen] = useState(false), [reason, setReason] = useState("予定期間の終了");
  const button = useRef<HTMLButtonElement>(null);
  const save = useSprintCommand();
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => {
      const target = button.current ?? document.querySelector<HTMLElement>("main h1");
      if (target) { if (target.tagName === "H1") target.tabIndex = -1; target.focus(); }
    });
  };
  if (sprint.phase !== "active" || !deadlineReached || sprint.workspaceId === null) return null;
  return <><Button style={{ minHeight: 32 }} ref={button} onClick={() => setOpen(true)}>Sprintを終了</Button>{open && <FormDialog title="Sprintを終了" submitLabel={save.isPending ? "保存中…" : "終了を記録する"} busy={save.isPending} error={save.error ? errorMessage(save.error) : null} onClose={close} onSubmit={() => {
    void save.run(`/sprints/${sprint.id}/end`, { expectedVersion: sprint.version, reason }).then(close, () => {});
  }}><p>現在の未完了Issueと未回答質問を記録します。既存のPM・workerの停止は別途確認してください。</p><label className={s.field}>終了理由<textarea required className={s.input} value={reason} onChange={e => setReason(e.target.value)} disabled={save.isPending} /></label></FormDialog>}</>;
}
