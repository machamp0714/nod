import { useState } from "react";
import { AwaitingInputBanner } from "../components/issue-detail/AwaitingInputBanner";
import { CompletionCandidateBanner } from "../components/issue-detail/CompletionCandidateBanner";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { errorMessage, isNotFoundError } from "../api/errors";
import {
  useApproveReview,
  useAttachDocument,
  useRemoveDocument,
  useAddAttachmentLink,
  useRemoveAttachment,
  useAnswerQuestion,
  useArchiveIssue,
  useCommentIssue,
  useCopyIssue,
  useResolveThread,
  useAskQuestion,
  useProjectChoices,
  useUnarchiveIssue,
  useRemind,
  useUpdateIssue,
  useWorkspaceName,
} from "../api/hooks/issue-detail";
import { useIssueDetail } from "../api/hooks/shared";
import type { Issue, IssueDetail } from "../api/types";
import { DocumentsSection } from "../components/issue-detail/DocumentsSection";
import { AttachmentsSection } from "../components/issue-detail/AttachmentsSection";
import { IssueHeaderActions } from "../components/issue-detail/IssueHeaderActions";
import { SubscribeToggle } from "../components/issue-detail/SubscribeToggle";
import { ActivitySection } from "../components/issue-detail/ActivitySection";
import { PrDiffSection } from "../components/issue-detail/PrDiffSection";
import { DescriptionSection } from "../components/issue-detail/DescriptionSection";
import s from "../components/issue-detail/issue-detail.module.css";
import { PlanSection } from "../components/issue-detail/PlanSection";
import { PropertiesPanel, RelationsPanel } from "../components/issue-detail/PropertiesPanel";
import { QuestionsPanel } from "../components/issue-detail/QuestionsPanel";
import { TitleSection } from "../components/issue-detail/TitleSection";
import { AgentStatePill, ErrorMessage, Icon, LoadingMessage, Pill, StatusIcon, WorkspaceBadge } from "../components/ui";
import { formatDateTime } from "../lib/format";
import { STATUS_META } from "../lib/meta";
import { useStatusNames } from "../api/hooks/workspace-labels";
import { statusName } from "../lib/workspace-labels";
import { NotFoundMessage } from "./NotFoundPage";

const route = getRouteApi("/issues/$issueId");

// spec の Issue 詳細：03 タスク詳細を土台にし、12 Issue 詳細の要素を足した1つの画面。
export function IssueDetailPage() {
  const { issueId } = route.useParams();
  const query = useIssueDetail(issueId);
  if (query.isError && isNotFoundError(query.error)) return <NotFoundMessage title="Issue が見つかりません" />;
  if (query.data === undefined) {
    return query.isError ? <ErrorMessage error={query.error} /> : <LoadingMessage />;
  }
  // 背景の取得失敗では同じ編集部品を保持し、別の Issue に移ったときだけ作り直す。
  return (
    <>
      {query.isError && <p className={s.backgroundError} role="alert">最新の Issue を取得できませんでした：{errorMessage(query.error)}</p>}
      <IssueDetailView key={issueId} issue={query.data} />
    </>
  );
}

function IssueDetailView({ issue }: { issue: IssueDetail }) {
  const [answerRequest, setAnswerRequest] = useState<{ questionId: number; requestId: number }>();
  const [questionsBusy, setQuestionsBusy] = useState(false);
  const wsName = useWorkspaceName(issue.workspace);
  const update = useUpdateIssue(issue.id);
  const remind = useRemind(issue.id);
  const approve = useApproveReview(issue.id);
  const ask = useAskQuestion(issue.id);
  const answer = useAnswerQuestion(issue.id);
  const projects = useProjectChoices();
  const comment = useCommentIssue(issue.id);
  const resolveThread = useResolveThread(issue.id);
  const attach = useAttachDocument(issue.id);
  const copyIssue = useCopyIssue(issue.id);
  const archive = useArchiveIssue(issue.id);
  const unarchive = useUnarchiveIssue(issue.id);
  const readOnly = issue.archivedAt !== null;
  const navigate = useNavigate();
  const removeDocument = useRemoveDocument(issue.id);
  const addAttachmentLink = useAddAttachmentLink(issue.id);
  const removeAttachment = useRemoveAttachment(issue.id);
  const status = STATUS_META[issue.status];
  const statusNames = useStatusNames();
  return (
    <div className={s.page}>
      <header className={s.topBar}>
        <nav aria-label="パンくず" className={s.crumbs}>
          <WorkspaceBadge workspaceKey={issue.workspace} name={wsName} />
          {issue.project && (
            <>
              <Icon name="chevron-right" size={12} />
              <Link to="/projects/$projectId" params={{ projectId: String(issue.project.id) }} className={s.crumbLink}>
                <Icon name="box" size={12} />
                {issue.project.name}
              </Link>
            </>
          )}
          {issue.parentId && (
            <>
              <Icon name="chevron-right" size={12} />
              <Link to="/issues/$issueId" params={{ issueId: issue.parentId }} className={s.crumbLink}>
                {issue.parentId}
              </Link>
            </>
          )}
          <Icon name="chevron-right" size={12} />
          <span className={s.crumbId}>{issue.id}</span>
        </nav>
        <SubscribeToggle issueId={issue.id} subscribed={issue.subscribed} />
        <IssueHeaderActions
          issueId={issue.id}
          archived={readOnly}
          onArchive={() => (readOnly ? unarchive.mutateAsync({}) : archive.mutateAsync({}))}
          onDuplicate={async () => {
            const copied = await copyIssue.mutateAsync({});
            await navigate({ to: "/issues/$issueId", params: { issueId: copied.id } });
          }}
        />
      </header>

      <div className={s.body}>
        <article className={s.main}>
          {issue.archivedAt !== null && <ArchivedBanner archivedAt={issue.archivedAt} onRestore={() => unarchive.mutateAsync({})} />}
          <div className={s.chips} role="group" aria-label="状態">
            <Pill tone={status.tone} icon={status.icon}>
              {statusName(issue.status, statusNames.data, issue.workspace)}
            </Pill>
            {issue.agentState && <AgentStatePill state={issue.agentState} />}
          </div>
          <TitleSection readOnly={readOnly} title={issue.title} onSave={(title) => update.mutateAsync({ title })} />

          <DescriptionSection readOnly={readOnly} description={issue.description} onSave={(description) => update.mutateAsync({ description })} />
          <AwaitingInputBanner readOnly={readOnly} issue={issue} busy={questionsBusy} onAnswer={(questionId) => setAnswerRequest((previous) => ({ questionId, requestId: (previous?.requestId ?? 0) + 1 }))} />
          <PlanSection key={issue.id} plan={issue.plan} />
          <DocumentsSection readOnly={readOnly} issueId={issue.id} documents={issue.documents} onAttach={input => attach.mutateAsync(input)}
            onRemove={documentId => removeDocument.mutateAsync({ documentId })} />
          <AttachmentsSection readOnly={readOnly} attachments={issue.attachments} onAddLink={input => addAttachmentLink.mutateAsync(input)}
            onRemove={attachmentId => removeAttachment.mutateAsync(attachmentId)} />
          <CompletionCandidateBanner
            key={`completion-${issue.id}`}
            issue={issue}
            onComplete={() => update.mutateAsync({ status: "done" })}
            onApprove={() => approve.mutateAsync({})}
          />
          <SubIssuesSection issues={issue.children} />
          {issue.prUrl && <PrDiffSection key={`diff-${issue.id}`} issueId={issue.id} prUrl={issue.prUrl} />}
          <ActivitySection
            readOnly={readOnly}
            workspace={issue.workspace}
            activity={issue.activity}
            onComment={(body) => comment.mutateAsync({ body })}
            onReply={(parentId, body) => comment.mutateAsync({ body, parentId })}
            onResolve={(commentId, resolved) => resolveThread.mutateAsync({ commentId, resolved })}
          />
        </article>

        <aside className={s.rail}>
          <QuestionsPanel
            questions={issue.questions}
            readOnly={readOnly}
            answerRequest={answerRequest}
            onBusyChange={setQuestionsBusy}
            onAnswer={(questionId, text) => answer.mutateAsync({ answer: text, questionId })}
            onAsk={(question) => ask.mutateAsync({ question })}
          />
          <PropertiesPanel readOnly={readOnly} issue={issue} workspaceName={wsName} projects={projects} onUpdate={(input) => update.mutateAsync(input)}
            reminder={issue.reminder ?? null} onRemind={remind} />
          <RelationsPanel relations={issue.relations} />
        </aside>
      </div>
    </div>
  );
}

// Pencil「Issue詳細｜アーカイブ済み」のバナー。復元に失敗したら理由をバナーの中に出す
function ArchivedBanner({ archivedAt, onRestore }: { archivedAt: string; onRestore: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function restore() {
    setBusy(true); setError("");
    try { await onRestore(); } catch (e) { setError(`復元できませんでした：${errorMessage(e)}`); } finally { setBusy(false); }
  }
  return (
    <section className={s.archivedBanner} aria-label="アーカイブ済み">
      <Icon name="archive" size={16} />
      <p className={s.archivedText}>このIssueはアーカイブ済みです（{formatDateTime(archivedAt)}）</p>
      <button type="button" className={s.archivedRestore} disabled={busy} onClick={() => void restore()}>
        <Icon name="archive-restore" size={14} />復元
      </button>
      {error && <p role="alert" className={s.archivedError}>{error}</p>}
    </section>
  );
}

function SubIssuesSection({ issues }: { issues: Issue[] }) {
  const done = issues.filter((issue) => issue.status === "done").length;
  const canceled = issues.filter((issue) => issue.status === "canceled").length;
  return (
    <section className={s.section} aria-label="Sub-issue">
      <h2 className={`${s.sectionTitle} ${s.subIssuesHeading}`}>
        Sub-issues <span className={s.subIssuesCount}>{done}/{issues.length - canceled}{canceled > 0 && ` · キャンセル ${canceled}`}</span>
      </h2>
      {issues.length === 0 ? (
        <p className={s.muted}>Sub-issue はありません</p>
      ) : (
        <ul className={s.list}>
          {issues.map((child) => (
            <li key={child.id} className={s.listItem}>
              <StatusIcon status={child.status} />
              <span className={s.crumbId}>{child.id}</span>
              <Link to="/issues/$issueId" params={{ issueId: child.id }} className={s.link}>
                {child.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
