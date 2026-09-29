import { getRouteApi, Link } from "@tanstack/react-router";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { useDecision, useInbox, useWorkspaceName } from "../api/hooks/decision";
import { useNotificationAction, useNotifications, useReminderExpiry, useSnoozeExpiry } from "../api/hooks/notifications";
import { useIssueDetail } from "../api/hooks/shared";
import type { InboxQuestion } from "../api/types";
import { ActionError } from "../components/split/ActionError";
import { QueueEmpty, QueueItem } from "../components/split/QueueItem";
import { SplitLayout } from "../components/split/SplitLayout";
import { ActivityLines, AgentAvatar, Button, Icon, Segmented, StatusLabel, WorkspaceBadge } from "../components/ui";
import { doingTaskTitle, groupInbox, type InboxEntry } from "../lib/decision";
import { formatRelative } from "../lib/format";
import { planProgress } from "../lib/plan";
import { executionLocation } from "../lib/execution-location";
import d from "./decision.module.css";
import { DeleteToast, NotificationDetail, NotificationList, type NotificationView, SnoozeFilter, useNotificationGroups } from "./InboxNotifications";
import type { InboxTab } from "../routes/inbox-search";

const route = getRouteApi("/inbox");

export function InboxPage() {
  const { selected, tab = "questions", view } = route.useSearch();
  const navigate = route.useNavigate();
  const pending = useInbox();
  const unread = useNotifications();
  useSnoozeExpiry();
  useReminderExpiry();
  const tabs = (
    <div className={d.tabs}><Segmented<InboxTab> label="Inboxの表示" value={tab}
      items={[
        { value: "questions", label: `確認依頼 ${pending.data?.questions.length ?? 0}` },
        { value: "notifications", label: "通知", badge: unread.data?.length ?? 0 },
        { value: "all", label: "すべて" },
      ]}
      // 通知タブとの行き来では選択を持ち越さない。開いただけで既読になるため
      onChange={next => void navigate({ search: { selected: next === "notifications" || tab === "notifications" ? undefined : selected, tab: next } })} /></div>
  );
  return tab === "notifications" ? <NotificationsTab selected={selected} view={view === "snoozed" ? "snoozed" : "inbox"} tabs={tabs} /> : <QuestionsTab selected={selected} tab={tab} tabs={tabs} />;
}

function NotificationsTab({ selected, view, tabs }: { selected?: string; view: NotificationView; tabs: ReactNode }) {
  const navigate = route.useNavigate();
  const { query, groups, snoozedCount } = useNotificationGroups(view);
  const workspaceName = useWorkspaceName();
  const restore = useNotificationAction();
  const [deleted, setDeleted] = useState<number[] | null>(null);
  const closeToast = useCallback(() => setDeleted(null), []);
  const current = groups.find((g) => g.issueId === selected) ?? groups[0];
  // 一覧から消えた Issue の選択は外す。残すと、後から届いた通知を開かないうちに既読にしてしまう
  const removed = (deletedIds?: number[]) => {
    void navigate({ search: { tab: "notifications", ...(view === "snoozed" ? { view } : {}) }, replace: true });
    // トーストを出している間に続けて削除したら、トーストは直近の削除の取り消しに切り替える
    if (deletedIds) { restore.reset(); setDeleted(deletedIds); }
  };
  const undo = (ids: number[]) => {
    restore.mutateAsync({ op: "restore", ids }).then(() => setDeleted((cur) => (cur === ids ? null : cur)), () => {});
  };
  return (
    <>
      <SplitLayout
        title="Inbox"
        count={view === "snoozed" ? groups.length : groups.reduce((sum, g) => sum + g.unread, 0)}
        headerExtra={<>{tabs}<SnoozeFilter view={view} snoozedCount={snoozedCount}
          onChange={(next) => void navigate({ search: { tab: "notifications", ...(next === "snoozed" ? { view: next } : {}) } })} /></>}
        listLabel="通知の一覧"
        list={query.isPending ? <QueueEmpty>読み込み中…</QueueEmpty> : query.isError ? <ActionError error={query.error} />
          : <NotificationList groups={groups} current={current} workspaceName={workspaceName} view={view} />}
        detail={current
          ? <NotificationDetail key={`${view}:${current.issueId}`} group={current} workspaceName={workspaceName(current.workspace)}
              opened={current.issueId === selected} view={view} onRemoved={removed} />
          : <p className={d.empty}>{query.isPending ? "読み込み中…" : view === "snoozed" ? "スヌーズ中の通知はありません" : "通知はありません"}</p>}
      />
      {deleted && <DeleteToast key={deleted.join(",")} onClose={closeToast} pending={restore.isPending} error={restore.error}
        onUndo={() => undo(deleted)} />}
    </>
  );
}

function QuestionsTab({ selected, tab, tabs }: { selected?: string; tab: "questions" | "all"; tabs: ReactNode }) {
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const setDraft = (id: number, text: string) => setDrafts(previous => ({ ...previous, [id]: text }));
  const inbox = useInbox({ includeAnswered: tab === "all" });
  const workspaceName = useWorkspaceName();
  const entries = groupInbox(inbox.data?.questions ?? []);
  const current = entries.find((e) => e.issueId === selected) ?? entries[0];
  return (
    <SplitLayout
      title="Inbox"
      count={inbox.data?.questions.length ?? 0}
      headerExtra={tabs}
      listLabel="確認依頼の一覧"
      list={
        inbox.isPending ? (
          <QueueEmpty>読み込み中…</QueueEmpty>
        ) : inbox.isError ? (
          <ActionError error={inbox.error} />
        ) : entries.length === 0 ? (
          <QueueEmpty>確認依頼はありません</QueueEmpty>
        ) : (
          entries.map((entry) => {
            const latest = entry.questions.at(-1);
            return (
              <QueueItem
                tab={tab}
                key={entry.issueId}
                to="/inbox"
                issueId={entry.issueId}
                title={entry.issueTitle}
                actor={latest?.askedBy ?? ""}
                at={entry.latestAt}
                body={latest?.question}
                workspaceKey={entry.workspace}
                workspaceName={workspaceName(entry.workspace)}
                selected={entry === current}
              />
            );
          })
        )
      }
      detail={
        current ? (
          <InboxDetail key={current.issueId} entry={current} workspaceName={workspaceName(current.workspace)} drafts={drafts} setDraft={setDraft} />
        ) : (
          <p className={d.empty}>{inbox.isPending ? "読み込み中…" : "確認依頼はありません"}</p>
        )
      }
    />
  );
}

function InboxDetail({ entry, workspaceName, drafts, setDraft }: { entry: InboxEntry; workspaceName: string; drafts: Record<number, string>; setDraft: (id: number, text: string) => void }) {
  const location = executionLocation(entry.branch, entry.worktree);
  const detail = useIssueDetail(entry.issueId);
  const issue = detail.data;
  const recent = issue ? issue.activity.slice(-3).reverse() : [];
  const progress = issue && issue.plan.tasks.length > 0 ? planProgress(issue.plan) : null;
  const doing = issue ? doingTaskTitle(issue.plan) : null;
  return (
    <div className={d.detail}>
      <div className={d.crumb}>
        <WorkspaceBadge workspaceKey={entry.workspace} name={workspaceName} />
        <span className={d.id}>{entry.issueId}</span>
        {issue && <StatusLabel status={issue.status} workspace={issue.workspace} />}
      </div>
      <h2 className={d.title}>{entry.issueTitle}</h2>
      {location && (
        <div className={d.context}>
          <Icon name="terminal" size={13} />
          <span title={entry.worktree ?? undefined}>
            実行場所：{workspaceName} / {location.branchLabel}
          </span>
          {location.worktree && <span className={d.worktree}>{location.worktree}</span>}
        </div>
      )}
      {progress && (
        <p className={d.note}>
          <Icon name="list-checks" />
          計画 {progress.done}/{progress.total}
          {doing && `（作業中の Task：${doing}）`}
        </p>
      )}

      {entry.questions.map((question) => (
        <QuestionCard key={question.id} question={question} answer={drafts[question.id] ?? ""} setAnswer={text => setDraft(question.id, text)} />
      ))}
      <p className={d.note}>
        <Icon name="info" />
        回答は Issue に記録されます。LLM は次に nod を実行したときに回答を読みます。
      </p>

      <section className={d.section} aria-label="直近の経過">
        <h3 className={d.sectionTitle}>直近の経過</h3>
        {detail.isError ? <ActionError error={detail.error} /> : <ActivityLines items={recent} workspace={issue?.workspace} />}
      </section>

      <Link to="/issues/$issueId" params={{ issueId: entry.issueId }} className={d.link}>
        Issue を開く
        <Icon name="arrow-right" />
      </Link>
    </div>
  );
}

// 質問ごとの回答欄。回答は questionId を付けて送り、この質問だけを回答済みにする
function QuestionCard({ question, answer, setAnswer }: { question: InboxQuestion; answer: string; setAnswer: (text: string) => void }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const decision = useDecision();
  const text = answer.trim();
  return (
    <section className={d.askCard} aria-label="確認依頼">
      <div className={d.cardHead}>
        <AgentAvatar actor={question.askedBy} />
        <span className={`${d.cardHeadText} ${d.askText}`}>{question.askedBy}{question.answer === null ? " が確認を求めています" : " からの確認依頼（回答済み）"}</span>
        <span className={d.askText}>{formatRelative(question.askedAt)}</span>
      </div>
      <p className={d.questionText}>{question.question}</p>
      {question.answer !== null ? <div className={d.answer}>
        <p className={d.body}>{question.answer}</p>
        <p className={d.muted}>{question.answeredBy ?? "記録なし"} が回答 · {question.answeredAt ? formatRelative(question.answeredAt) : "記録なし"}</p>
      </div> : <div className={d.answer}>
        <textarea
          ref={input}
          className={d.textarea}
          aria-label="回答"
          placeholder="回答を入力…"
          value={answer}
          disabled={decision.isPending}
          onChange={(e) => setAnswer(e.target.value)}
        />
        <div className={d.quickReplies}>
          {["はい、進めて", "いいえ、既存を残す"].map(reply => <Button key={reply} disabled={decision.isPending} onClick={() => { setAnswer(reply); input.current?.focus(); }}>{reply}</Button>)}
        </div>
        <div className={d.answerFooter}>
          <Button
            variant="primary"
            disabled={text === "" || decision.isPending}
            onClick={() => decision.mutate({ op: "answer", issueId: question.issueId, questionId: question.id, answer: text }, { onSuccess: () => setAnswer("") })}
          >
            回答する
          </Button>
        </div>
      </div>}
      <ActionError error={decision.error} />
    </section>
  );
}
