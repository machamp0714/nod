import { getRouteApi } from "@tanstack/react-router";
import type { Issue } from "../api/types";
import { QueueEmpty, QueueItem } from "../components/split/QueueItem";
import { SplitLayout } from "../components/split/SplitLayout";
import { AgentAvatar, Button, Icon, StatusLabel, WorkspaceBadge } from "../components/ui";
import { INBOX } from "../fixtures/inbox";
import { questionsOf } from "../fixtures/issues";
import { REVIEW_REPORTS } from "../fixtures/reviews";
import { workspaceName } from "../fixtures/workspaces";
import { countQuestions, formatRelative, prLabel } from "../lib/format";
import d from "./decision.module.css";

const route = getRouteApi("/reviews");

export function ReviewsPage() {
  const { selected } = route.useSearch();
  const items = INBOX.reviews;
  const current = items.find((i) => i.id === selected) ?? items[0];
  return (
    <SplitLayout
      title="Reviews"
      count={items.length}
      listLabel="レビュー待ちの一覧"
      list={
        items.length === 0 ? (
          <QueueEmpty>レビュー待ちの Issue はありません</QueueEmpty>
        ) : (
          items.map((issue) => (
            <QueueItem
              key={issue.id}
              to="/reviews"
              issueId={issue.id}
              title={issue.title}
              actor={issue.assignee ?? issue.createdBy}
              at={issue.updatedAt}
              body={REVIEW_REPORTS[issue.id]?.body}
              workspaceKey={issue.workspace}
              workspaceName={workspaceName(issue.workspace)}
              selected={issue === current}
            />
          ))
        )
      }
      detail={current ? <ReviewDetail issue={current} /> : <p className={d.empty}>レビュー待ちの Issue はありません</p>}
    />
  );
}

function ReviewDetail({ issue }: { issue: Issue }) {
  const report = REVIEW_REPORTS[issue.id];
  const questions = countQuestions(questionsOf(issue.id));
  return (
    <div className={d.detail}>
      <div className={d.crumb}>
        <WorkspaceBadge workspaceKey={issue.workspace} name={workspaceName(issue.workspace)} />
        <span className={d.id}>{issue.id}</span>
        <StatusLabel status={issue.status} />
      </div>
      <h2 className={d.title}>{issue.title}</h2>

      <section className={d.card} aria-label="完了報告">
        <div className={d.cardHead}>
          {report && <AgentAvatar actor={report.actor} />}
          <span className={d.cardHeadText}>{report ? `${report.actor} の完了報告` : "完了報告"}</span>
          {report && <span className={d.time}>{formatRelative(report.at)}</span>}
        </div>
        <p className={d.body}>{report?.body ?? "報告はありません"}</p>
      </section>

      {issue.prUrl ? (
        <div className={d.pr}>
          <Icon name="git-pull-request" size={18} color="var(--ready)" />
          <div className={d.prText}>
            <span className={d.prTitle}>
              {prLabel(issue.prUrl)} {issue.title}
            </span>
            {issue.branch && <span className={d.branch}>{issue.branch}</span>}
          </div>
          <a href={issue.prUrl} target="_blank" rel="noreferrer" className={d.link}>
            GitHub で開く
            <Icon name="external-link" />
          </a>
        </div>
      ) : (
        <p className={d.muted}>PR はありません</p>
      )}

      <div className={d.summary}>
        {report && (
          <span className={d.summaryItem}>
            <Icon name="list-checks" color="var(--ready)" />
            計画 {report.plan.done}/{report.plan.total} 完了
          </span>
        )}
        <span className={d.summaryItem}>
          <Icon name="message-circle" />
          確認依頼 {questions.total} 件（回答済み {questions.decided} 件）
        </span>
      </div>

      <textarea className={d.feedback} aria-label="差し戻しの理由" placeholder="差し戻す場合は理由を書く…" />
      <div className={d.actions}>
        <Button variant="primary" icon="check" disabled title="準備中">
          承認して閉じる
        </Button>
        <Button icon="undo-2" disabled title="準備中">
          差し戻す
        </Button>
      </div>
    </div>
  );
}
