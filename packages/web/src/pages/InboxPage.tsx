import { getRouteApi, Link } from "@tanstack/react-router";
import type { InboxQuestion } from "../api/types";
import { QueueEmpty, QueueItem } from "../components/split/QueueItem";
import { SplitLayout } from "../components/split/SplitLayout";
import { ActivityLines, AgentAvatar, Button, Icon, StatusLabel, WorkspaceBadge } from "../components/ui";
import { activityOf } from "../fixtures/activity";
import { INBOX } from "../fixtures/inbox";
import { findIssue } from "../fixtures/issues";
import { workspaceName } from "../fixtures/workspaces";
import { formatRelative } from "../lib/format";
import d from "./decision.module.css";

const route = getRouteApi("/inbox");

export function InboxPage() {
  const { selected } = route.useSearch();
  const items = INBOX.questions;
  const current = items.find((q) => q.issueId === selected) ?? items[0];
  return (
    <SplitLayout
      title="Inbox"
      count={items.length}
      listLabel="確認依頼の一覧"
      list={
        items.length === 0 ? (
          <QueueEmpty>確認依頼はありません</QueueEmpty>
        ) : (
          items.map((q) => (
            <QueueItem
              key={q.id}
              to="/inbox"
              issueId={q.issueId}
              title={q.issueTitle}
              actor={q.askedBy}
              at={q.askedAt}
              body={q.question}
              workspaceKey={q.workspace}
              workspaceName={workspaceName(q.workspace)}
              selected={q === current}
            />
          ))
        )
      }
      detail={current ? <InboxDetail question={current} /> : <p className={d.empty}>確認依頼はありません</p>}
    />
  );
}

function InboxDetail({ question }: { question: InboxQuestion }) {
  const issue = findIssue(question.issueId);
  const recent = activityOf(question.issueId).slice(-3).reverse();
  return (
    <div className={d.detail}>
      <div className={d.crumb}>
        <WorkspaceBadge workspaceKey={question.workspace} name={workspaceName(question.workspace)} />
        <span className={d.id}>{question.issueId}</span>
        {issue && <StatusLabel status={issue.status} />}
      </div>
      <h2 className={d.title}>{question.issueTitle}</h2>

      <section className={d.askCard} aria-label="確認依頼">
        <div className={d.cardHead}>
          <AgentAvatar actor={question.askedBy} />
          <span className={`${d.cardHeadText} ${d.askText}`}>{question.askedBy} が確認を求めています</span>
          <span className={d.askText}>{formatRelative(question.askedAt)}</span>
        </div>
        <p className={d.questionText}>{question.question}</p>
        {question.branch && (
          <div className={d.context}>
            <Icon name="terminal" size={13} />
            <span title={question.worktree ?? undefined}>
              実行場所：{workspaceName(question.workspace)} / {question.branch}
            </span>
          </div>
        )}
      </section>

      <div className={d.answer}>
        <textarea className={d.textarea} aria-label="回答" placeholder="回答を入力…" />
        <div className={d.answerFooter}>
          <Button variant="primary" disabled title="準備中">
            回答する
          </Button>
        </div>
      </div>
      <p className={d.note}>
        <Icon name="info" />
        回答は Issue に記録されます。LLM は次に nod を実行したときに回答を読みます。
      </p>

      <section className={d.section} aria-label="直近の経過">
        <h3 className={d.sectionTitle}>直近の経過</h3>
        <ActivityLines items={recent} />
      </section>

      <Link to="/issues/$issueId" params={{ issueId: question.issueId }} className={d.link}>
        Issue を開く
        <Icon name="arrow-right" />
      </Link>
    </div>
  );
}
