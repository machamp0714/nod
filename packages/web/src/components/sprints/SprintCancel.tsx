import { useRef, useState } from "react";
import type { Sprint } from "@nod/core";
import { useSprintCommand } from "../../api/hooks/sprint-planning";
import { errorMessage } from "../../api/errors";
import { FormDialog } from "../planning/FormDialog";
import { Button } from "../ui";
import s from "../planning/planning.module.css";
export function SprintCancel({ sprint }: { sprint: Sprint }) {
  const [open, setOpen] = useState(false), [reason, setReason] = useState("");
  const button = useRef<HTMLButtonElement>(null);
  const save = useSprintCommand();
  const close = () => { setOpen(false); requestAnimationFrame(() => { const target = button.current ?? document.querySelector<HTMLElement>("main h1"); if (target) { if (target.tagName === "H1") target.tabIndex = -1; target.focus(); } }); };
  if (!["draft", "ready", "active"].includes(sprint.phase) || sprint.workspaceId === null) return null;
  return <><Button style={{ minHeight: 32 }} ref={button} onClick={() => setOpen(true)}>Sprintを中止</Button>{open && <FormDialog title="Sprintを中止" submitLabel={save.isPending ? "保存中…" : "中止する"} busy={save.isPending} error={save.error ? errorMessage(save.error) : null} onClose={close} onSubmit={() => {
    void save.run(`/sprints/${sprint.id}/cancel`, { expectedVersion: sprint.version, reason }).then(close, () => {});
  }}><p>新しい着手を止めます。既存のPM・workerの停止は別途確認が必要です。</p><label className={s.field}>中止理由<textarea required className={s.input} value={reason} onChange={e => setReason(e.target.value)} disabled={save.isPending} /></label></FormDialog>}</>;
}
