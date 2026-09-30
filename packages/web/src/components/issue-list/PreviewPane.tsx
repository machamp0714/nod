import { Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { useIssueDetail } from "../../api/hooks/shared";
import { errorMessage, isNotFoundError } from "../../api/errors";
import { priorityMeta, TONE_COLORS } from "../../lib/meta";
import { Markdown } from "../markdown/Markdown";
import { AgentAvatar, Icon, IconButton, LabelChip, ProgressBar, StatusLabel, WorkspaceBadge } from "../ui";
import s from "./issue-list.module.css";

// design/nod.pen「Issues｜プレビュー」の分割ペイン。一覧から離れずに Issue の中身を読むだけで、編集はしない
export function PreviewPane({
  issueId,
  titles,
  workspaceName,
  onClose,
}: {
  issueId: string;
  titles: ReadonlyMap<string, string>; // ブロック元のタイトル（一覧にあるものだけ）
  workspaceName: (key: string) => string;
  onClose: () => void;
}) {
  const detail = useIssueDetail(issueId);

  // 入力欄とダイアログの Escape は、それぞれの操作に任せる
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, dialog, [role=dialog]")) return;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const issue = detail.data;
  const decided = issue ? issue.questionCount.answered : 0;
  const total = issue ? issue.questionCount.total : 0;
  const priority = issue ? priorityMeta(issue.priority) : null;

  return (
    <aside className={s.preview} aria-label={`${issueId} のプレビュー`}>
      <div className={s.previewHead}>
        <Icon name="eye" size={13} color="var(--ink3)" />
        <span className={s.previewHeadText}>プレビュー · 読み取り専用</span>
        <IconButton icon="x" label="プレビューを閉じる" onClick={onClose} />
      </div>
      {detail.isPending ? (
        <p role="status" className={s.message}>読み込み中…</p>
      ) : detail.isError ? (
        <p role="alert" className={`${s.message} ${s.messageError}`}>
          {isNotFoundError(detail.error) ? `Issue ${issueId} が見つかりません` : errorMessage(detail.error)}
        </p>
      ) : issue && priority ? (
        <>
          <div className={s.previewCrumb}>
            <WorkspaceBadge workspaceKey={issue.workspace} name={workspaceName(issue.workspace)} />
            <span className={s.previewId}>{issue.id}</span>
            <span className={s.previewDot}>·</span>
            <StatusLabel status={issue.status} workspace={issue.workspace} />
          </div>
          <h2 className={s.previewTitle}>{issue.title}</h2>
          <dl className={s.previewProps}>
            <div>
              <dt>優先度</dt>
              <dd><Icon name={priority.icon} size={14} color={TONE_COLORS[priority.tone].fg} />{priority.label}</dd>
            </div>
            <div>
              <dt>担当</dt>
              <dd>{issue.assignee ? <><AgentAvatar actor={issue.assignee} />{issue.assignee}</> : <span className={s.muted}>未割り当て</span>}</dd>
            </div>
            <div>
              <dt>Project</dt>
              <dd>{issue.project ? <><Icon name="box" size={14} color="var(--ink2)" />{issue.project.name}</> : <span className={s.muted}>なし</span>}</dd>
            </div>
            <div>
              <dt>ラベル</dt>
              <dd>
                {issue.labels.length ? issue.labels.map((label) => <LabelChip key={label} workspace={issue.workspace} name={label} />) : <span className={s.muted}>なし</span>}
              </dd>
            </div>
          </dl>
          <section className={s.previewSection} aria-label="説明">
            <h3 className={s.previewSectionTitle}>説明</h3>
            {issue.description ? <Markdown>{issue.description}</Markdown> : <p className={s.muted}>説明はありません</p>}
          </section>
          <dl className={s.previewProps}>
            <div>
              <dt>未決事項</dt>
              <dd>
                {total === 0 ? <span className={s.muted}>なし</span> : <>{decided} / {total} 決定<ProgressBar value={decided} max={total} width={80} /></>}
              </dd>
            </div>
            <div>
              <dt>ブロック元</dt>
              <dd className={s.previewBlockers}>
                {issue.blockedBy.length === 0 ? <span className={s.muted}>なし</span> : issue.blockedBy.map((id) => (
                  <span key={id} className={s.previewBlocker}>
                    <Icon name="octagon-alert" size={14} color="var(--fail)" />
                    <Link to="/issues/$issueId" params={{ issueId: id }} className={s.previewId}>{id}</Link>
                    {titles.get(id) && <span>{titles.get(id)}</span>}
                  </span>
                ))}
              </dd>
            </div>
          </dl>
          <Link to="/issues/$issueId" params={{ issueId: issue.id }} className={s.previewOpen}>
            Issue を開く
            <Icon name="arrow-right" size={14} />
          </Link>
        </>
      ) : null}
    </aside>
  );
}
