import { useState } from "react";
import { useAddProjectUpdate } from "../../api/hooks/projects";
import type { ProjectHealth, ProjectUpdate } from "../../api/types";
import { hasText } from "../../lib/issue-edit";
import { formatDateTime, formatRelative } from "../../lib/format";
import { useAsyncAction } from "../issue-detail/useAsyncAction";
import { AgentAvatar, Button, Icon } from "../ui";
import { HealthPill, HealthSelect } from "./HealthPill";
import s from "./project-updates.module.css";

// Project の進捗報告。本文はプレーンテキストとして表示し、保存に失敗したら下書き（本文と健全性）を残す。
// 健全性は任意で、添えた値が Project の現在の健全性になる
export function ProjectUpdatesSection({ projectId, updates }: { projectId: number; updates: ProjectUpdate[] }) {
  const add = useAddProjectUpdate(projectId);
  const [body, setBody] = useState("");
  const [health, setHealth] = useState<ProjectHealth | null>(null);
  const action = useAsyncAction();

  async function submit() {
    if (await action.run(() => add.mutateAsync({ body, health }), "保存できませんでした")) {
      setBody("");
      setHealth(null);
    }
  }

  return (
    <section className={s.section} aria-label="進捗報告">
      <div className={s.titleRow}>
        <h2 className={s.heading}>進捗報告</h2>
        <span className={s.count}>{updates.length}</span>
      </div>
      <div className={s.composer}>
        <textarea
          disabled={action.busy}
          className={`${s.input} ${action.error ? s.inputError : ""}`}
          aria-label="進捗報告の本文"
          aria-invalid={action.error ? true : undefined}
          placeholder="進捗を書く…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {action.error && (
          <p className={s.error} role="alert">
            <Icon name="circle-alert" size={13} />
            {action.error}
          </p>
        )}
        <div className={s.actions}>
          <HealthSelect value={health} onChange={setHealth} disabled={action.busy} />
          {action.busy ? (
            <Button className={s.saving} icon="loader-circle" disabled>
              保存中…
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void submit()} disabled={!hasText(body)}>
              報告する
            </Button>
          )}
        </div>
      </div>
      {updates.length === 0 ? (
        <p className={s.empty}>進捗報告はありません</p>
      ) : (
        <ol className={s.list}>
          {updates.map((u) => (
            <li key={u.id}>
              <article className={s.card} aria-label="進捗報告の記録">
                <div className={s.head}>
                  <AgentAvatar actor={u.author} />
                  <strong>{u.author}</strong>
                  <time dateTime={u.createdAt} title={formatRelative(u.createdAt)}>
                    {formatDateTime(u.createdAt)}
                  </time>
                  <HealthPill health={u.health} />
                </div>
                <p>{u.body}</p>
              </article>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
