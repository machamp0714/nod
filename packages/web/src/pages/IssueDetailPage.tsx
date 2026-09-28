import { getRouteApi, Link } from "@tanstack/react-router";
import { errorMessage, isNotFoundError } from "../api/errors";
import {
  useAnswerQuestion,
  useCommentIssue,
  useAskQuestion,
  useProjectChoices,
  useUpdateIssue,
  useWorkspaceName,
} from "../api/hooks/issue-detail";
import { useIssueDetail } from "../api/hooks/shared";
import type { DocumentRef, Issue, IssueDetail } from "../api/types";
import { ActivitySection } from "../components/issue-detail/ActivitySection";
import { DescriptionSection } from "../components/issue-detail/DescriptionSection";
import s from "../components/issue-detail/issue-detail.module.css";
import { PlanSection } from "../components/issue-detail/PlanSection";
import { PropertiesPanel, RelationsPanel } from "../components/issue-detail/PropertiesPanel";
import { QuestionsPanel } from "../components/issue-detail/QuestionsPanel";
import { TitleSection } from "../components/issue-detail/TitleSection";
import { AgentStatePill, ErrorMessage, Icon, LoadingMessage, Pill, StatusIcon, WorkspaceBadge } from "../components/ui";
import { STATUS_META } from "../lib/meta";
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
  const wsName = useWorkspaceName(issue.workspace);
  const update = useUpdateIssue(issue.id);
  const ask = useAskQuestion(issue.id);
  const answer = useAnswerQuestion(issue.id);
  const projects = useProjectChoices();
  const comment = useCommentIssue(issue.id);
  const status = STATUS_META[issue.status];
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
      </header>

      <div className={s.body}>
        <article className={s.main}>
          <div className={s.chips} role="group" aria-label="状態">
            <Pill tone={status.tone} icon={status.icon}>
              {status.label}
            </Pill>
            {issue.agentState && <AgentStatePill state={issue.agentState} />}
          </div>
          <TitleSection title={issue.title} onSave={(title) => update.mutateAsync({ title })} />

          <DescriptionSection description={issue.description} onSave={(description) => update.mutateAsync({ description })} />
          <PlanSection key={issue.id} plan={issue.plan} />
          <DocumentsSection documents={issue.documents} />
          <SubIssuesSection issues={issue.children} />
          <ActivitySection activity={issue.activity} onComment={(body) => comment.mutateAsync({ body })} />
        </article>

        <aside className={s.rail}>
          <QuestionsPanel
            questions={issue.questions}
            onAnswer={(questionId, text) => answer.mutateAsync({ answer: text, questionId })}
            onAsk={(question) => ask.mutateAsync({ question })}
          />
          <PropertiesPanel issue={issue} workspaceName={wsName} projects={projects} onUpdate={(input) => update.mutateAsync(input)} />
          <RelationsPanel relations={issue.relations} />
        </aside>
      </div>
    </div>
  );
}

function DocumentsSection({ documents }: { documents: DocumentRef[] }) {
  return (
    <section className={s.section} aria-label="Documents">
      <h2 className={s.sectionTitle}>Documents</h2>
      {documents.length === 0 ? (
        <p className={s.muted}>Document はありません</p>
      ) : (
        <ul className={s.list}>
          {documents.map((doc) => (
            <li key={doc.id} className={s.listItem}>
              <Icon name="file-text" />
              <Link to="/documents/$documentId" params={{ documentId: String(doc.id) }} className={s.link}>
                {doc.title}
              </Link>
              <span className={s.meta}>{doc.kind}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SubIssuesSection({ issues }: { issues: Issue[] }) {
  return (
    <section className={s.section} aria-label="Sub-issue">
      <h2 className={s.sectionTitle}>Sub-issue {issues.filter((issue) => issue.status === "done").length}/{issues.length}</h2>
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
