import { useState } from "react";
import { useAddProjectUpdate } from "../../api/hooks/projects";
import type { ProjectUpdate } from "../../api/types";
import { hasText } from "../../lib/issue-edit";
import { formatDateTime, formatRelative } from "../../lib/format";
import { useAsyncAction } from "../issue-detail/useAsyncAction";
import { AgentAvatar, Button } from "../ui";
import s from "./project-updates.module.css";

// Project の進捗報告。本文はプレーンテキストとして表示し、保存に失敗したら下書きを残す
export function ProjectUpdatesSection({ projectId, updates }: { projectId: number; updates: ProjectUpdate[] }) {
  const add = useAddProjectUpdate(projectId);
  const [body, setBody] = useState("");
  const action = useAsyncAction();

  async function submit() {
    if (await action.run(() => add.mutateAsync({ body }), "進捗報告を保存できませんでした")) setBody("");
  }

  return (
    <section className={s.section} aria-label="進捗報告">
      <h2 className={s.heading}>進捗報告</h2>
      <div className={s.box}>
        <textarea
          disabled={action.busy}
          className={s.input}
          aria-label="進捗報告の本文"
          placeholder="進捗を書く…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {action.error && (
          <p className={s.error} role="alert">
            {action.error}
          </p>
        )}
        <div className={s.actions}>
          {action.busy && <span className={s.muted} role="status">保存中…</span>}
          <Button variant="primary" onClick={() => void submit()} disabled={action.busy || !hasText(body)}>
            報告する
          </Button>
        </div>
      </div>
      {updates.length === 0 ? (
        <p className={s.muted}>進捗報告はありません</p>
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
