import { getRouteApi } from "@tanstack/react-router";
import { useState } from "react";
import { useDecision, useInbox, useWorkspaceName } from "../api/hooks/decision";
import { useIssueDetail } from "../api/hooks/shared";
import type { ReviewIssue } from "../api/types";
import { ApprovalNotice, GithubStatusRow } from "../components/issue-detail/GithubApproval";
import { ReviewMediaSection } from "../components/issue-detail/AttachmentMedia";
import { PrDiffSection } from "../components/issue-detail/PrDiffSection";
import { usePrStatus } from "../api/hooks/pr-status";
import { ActionError } from "../components/split/ActionError";
import { QueueEmpty, QueueItem } from "../components/split/QueueItem";
import { SplitLayout } from "../components/split/SplitLayout";
import { AgentAvatar, Button, Icon, StatusLabel, WorkspaceBadge } from "../components/ui";
import { formatReviewElapsed } from "../lib/review-elapsed";
import { formatRelative, prLabel } from "../lib/format";
import { planProgress } from "../lib/plan";
import d from "./decision.module.css";

const route = getRouteApi("/reviews");

export function ReviewsPage() {
  const { selected } = route.useSearch();
  const inbox = useInbox();
  const workspaceName = useWorkspaceName();
  const items = inbox.data?.reviews ?? [];
  const current = items.find((i) => i.id === selected) ?? items[0];
  return (
    <SplitLayout
      title="Reviews"
      description="LLM が作業を終え、確認を待っている Issue"
      count={items.length}
      listLabel="レビュー待ちの一覧"
      list={
        inbox.isPending ? (
          <QueueEmpty>読み込み中…</QueueEmpty>
        ) : inbox.isError ? (
          <ActionError error={inbox.error} />
        ) : items.length === 0 ? (
          <QueueEmpty>レビュー待ちの Issue はありません</QueueEmpty>
        ) : (
          items.map((issue) => (
            <QueueItem
              key={issue.id}
              to="/reviews"
              issueId={issue.id}
              title={issue.title}
              actor={issue.reviewReport?.actor ?? issue.assignee ?? issue.createdBy}
              at={issue.reviewSubmittedAt ?? issue.updatedAt}
              body={issue.reviewSummary ?? "報告はありません"}
              workspaceKey={issue.workspace}
              workspaceName={workspaceName(issue.workspace)}
              selected={issue === current}
            />
          ))
        )
      }
      detail={
        current ? (
          <ReviewDetail key={current.id} issue={current} workspaceName={workspaceName(current.workspace)} />
        ) : (
          <p className={d.empty}>{inbox.isPending ? "読み込み中…" : "レビュー待ちの Issue はありません"}</p>
        )
      }
    />
  );
}

function ReviewDetail({ issue, workspaceName }: { issue: ReviewIssue; workspaceName: string }) {
  const detail = useIssueDetail(issue.id);
  const report = issue.reviewReport;
  const plan = detail.data && detail.data.plan.tasks.length > 0 ? planProgress(detail.data.plan) : null;
  const [reason, setReason] = useState("");
  const approve = useDecision();
  const reject = useDecision();
  const busy = approve.isPending || reject.isPending;
  // 承認ボタン付近の注意は保存済みの PR 状態から出す（承認で gh は実行しない）
  const prStatus = usePrStatus(issue.id, issue.prUrl !== null);
  return (
    <div className={d.detail}>
      <div className={d.crumb}>
        <WorkspaceBadge workspaceKey={issue.workspace} name={workspaceName} />
        <span className={d.id}>{issue.id}</span>
        <StatusLabel status={issue.status} workspace={issue.workspace} />
      </div>
      <h2 className={d.title}>{issue.title}</h2>

      <section className={d.card} aria-label="完了報告">
        <div className={d.cardHead}>
          {report && <AgentAvatar actor={report.actor} />}
          <span className={d.cardHeadText}>{report ? `${report.actor} の完了報告` : "完了報告"}</span>
          {report && <span className={d.time}>{formatRelative(report.at)}</span>}
        </div>
        {detail.isError ? (
          <ActionError error={detail.error} />
        ) : (
          <p className={d.body}>{detail.isPending ? "読み込み中…" : (report?.body ?? "報告はありません")}</p>
        )}
      </section>

      {issue.prUrl ? (
        <div className={d.prGroup}>
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
          <GithubStatusRow issueId={issue.id} />
          <ReviewMediaSection attachments={detail.data?.attachments ?? []} />
          <PrDiffSection issueId={issue.id} prUrl={issue.prUrl} collapsible />
        </div>
      ) : (
        <>
          <p className={d.muted}>PR はありません</p>
          <ReviewMediaSection attachments={detail.data?.attachments ?? []} />
        </>
      )}

      <div className={d.summary}>
        {plan && (
          <span className={d.summaryItem}>
            <Icon name="list-checks" color="var(--ready)" />
            計画 {plan.done}/{plan.total} 完了
          </span>
        )}
        <span className={d.summaryItem}>
          <Icon name="message-circle" />
          確認依頼 {issue.questionCount.total} 件（回答済み {issue.questionCount.answered} 件）
        </span>
        <span className={d.summaryItem}>作業時間（待機・中断・差し戻しを含む） {formatReviewElapsed(issue.startedAt, issue.reviewSubmittedAt)}</span>
      </div>

      <textarea
        className={d.feedback}
        aria-label="差し戻しの理由"
        placeholder="差し戻す場合は理由を書く…"
        value={reason}
        disabled={busy}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className={d.approvalArea}>
        <ApprovalNotice status={issue.prUrl ? (prStatus.data?.status ?? null) : null} />
        <div className={d.actions}>
          <Button variant="primary" icon="check" disabled={busy} onClick={() => approve.mutate({ op: "approve", issueId: issue.id })}>
            承認して閉じる
          </Button>
          <Button
            icon="undo-2"
            disabled={busy || reason.trim() === ""}
            title={reason.trim() === "" ? "差し戻しの理由を書いてください" : undefined}
            onClick={() => reject.mutate({ op: "reject", issueId: issue.id, reason })}
          >
            差し戻す
          </Button>
        </div>
      </div>
      <ActionError error={approve.error ?? reject.error} />
    </div>
  );
}
