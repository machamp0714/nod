import { useState } from "react";
import { errorMessage } from "../../api/errors";
import { useAddProjectUpdate } from "../../api/hooks/projects";
import type { ProjectUpdate } from "../../api/types";
import { hasText } from "../../lib/issue-edit";
import { formatDateTime, formatRelative } from "../../lib/format";
import { AgentAvatar, Button, Icon } from "../ui";
import { type HealthChoice, HealthClearedPill, HealthPill, HealthSelect } from "./HealthPill";
import s from "./project-updates.module.css";

// Project の進捗報告。本文はプレーンテキストとして表示し、保存に失敗したら下書き（本文と健全性）を残す。
// 健全性は任意で、添えた値が Project の現在の健全性になる（「未設定に戻す」は未設定に戻す）。
// 健全性のない報告には Pill を出さない（未設定に戻したように読めないように。#154）
// 下書き（本文と健全性）
export interface ProjectUpdateDraft {
  body: string;
  health: HealthChoice;
}

// 書く欄の状態（下書き・保存中・失敗）。Project 詳細の一覧とフローを切り替えると欄が作り直されるため、
// 親が持てば、保存中に切り替えても保存中のまま（入力と二重送信を止める）になり、保存の終わりが新しい欄に届く
export interface ProjectUpdateComposer {
  draft: ProjectUpdateDraft;
  saving: boolean;
  error: string | null;
}

export const EMPTY_PROJECT_UPDATE_DRAFT: ProjectUpdateDraft = { body: "", health: null };
export const EMPTY_PROJECT_UPDATE_COMPOSER: ProjectUpdateComposer = { draft: EMPTY_PROJECT_UPDATE_DRAFT, saving: false, error: null };

type ComposerUpdate = (update: (prev: ProjectUpdateComposer) => ProjectUpdateComposer) => void;

export function ProjectUpdatesSection({
  projectId,
  updates,
  composer: controlled,
  onComposerChange,
}: {
  projectId: number;
  updates: ProjectUpdate[];
  composer?: ProjectUpdateComposer; // 渡したときは親の状態を使う（onComposerChange と組で渡す）
  onComposerChange?: ComposerUpdate;
}) {
  const add = useAddProjectUpdate(projectId);
  const [local, setLocal] = useState<ProjectUpdateComposer>(EMPTY_PROJECT_UPDATE_COMPOSER);
  const composer = controlled ?? local;
  // 保存の終わりは欄が作り直された後にも届くため、いつも最新の状態から作る
  const update: ComposerUpdate = onComposerChange ?? setLocal;
  const { draft, saving, error } = composer;
  const { body, health } = draft;
  const setBody = (next: string) => update((c) => ({ ...c, draft: { ...c.draft, body: next } }));
  const setHealth = (next: HealthChoice) => update((c) => ({ ...c, draft: { ...c.draft, health: next } }));

  async function submit() {
    if (saving) return;
    const submitted = draft;
    update((c) => ({ ...c, saving: true, error: null }));
    try {
      await add.mutateAsync(submitted);
      // 保存中は書き換えられないが、送った下書きのままのときだけ空に戻し、新しい下書きは消さない
      update((c) => ({ draft: c.draft === submitted ? EMPTY_PROJECT_UPDATE_DRAFT : c.draft, saving: false, error: null }));
    } catch (err) {
      update((c) => ({ ...c, saving: false, error: `保存できませんでした：${errorMessage(err)}` }));
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
          disabled={saving}
          className={`${s.input} ${error ? s.inputError : ""}`}
          aria-label="進捗報告の本文"
          aria-invalid={error ? true : undefined}
          placeholder="進捗を書く…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {error && (
          <p className={s.error} role="alert">
            <Icon name="circle-alert" size={13} />
            {error}
          </p>
        )}
        <div className={s.actions}>
          <HealthSelect value={health} onChange={setHealth} disabled={saving} />
          {saving ? (
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
                  {u.health ? <HealthPill health={u.health} /> : u.healthCleared && <HealthClearedPill />}
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
