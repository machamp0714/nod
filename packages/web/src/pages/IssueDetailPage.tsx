import { getRouteApi, Link } from "@tanstack/react-router";
import type { DocumentRef, Issue } from "../api/types";
import { ActivitySection } from "../components/issue-detail/ActivitySection";
import s from "../components/issue-detail/issue-detail.module.css";
import { PlanSection } from "../components/issue-detail/PlanSection";
import { PropertiesPanel, RelationsPanel } from "../components/issue-detail/PropertiesPanel";
import { QuestionsPanel } from "../components/issue-detail/QuestionsPanel";
import { AgentStatePill, Button, Icon, Pill, StatusIcon, WorkspaceBadge } from "../components/ui";
import { issueDetail } from "../fixtures/issue-details";
import { workspaceName } from "../fixtures/workspaces";
import { STATUS_META } from "../lib/meta";
import { NotFoundMessage } from "./NotFoundPage";

const route = getRouteApi("/issues/$issueId");

// spec の Issue 詳細：03 タスク詳細を土台にし、12 Issue 詳細の要素を足した1つの画面。
export function IssueDetailPage() {
  const { issueId } = route.useParams();
  const issue = issueDetail(issueId);
  if (!issue) return <NotFoundMessage title="Issue が見つかりません" />;
  const status = STATUS_META[issue.status];
  const wsName = workspaceName(issue.workspace);
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
          <div className={s.chips}>
            <Pill tone={status.tone} icon={status.icon}>
              {status.label}
            </Pill>
            {issue.agentState && <AgentStatePill state={issue.agentState} />}
          </div>
          <h1 className={s.title}>{issue.title}</h1>

          <section className={s.section} aria-label="説明">
            <header className={s.sectionHead}>
              <h2 className={s.sectionTitle}>説明</h2>
              <span className={s.spacer} />
              <Button icon="square-pen" disabled title="準備中">
                編集
              </Button>
            </header>
            {issue.description ? <div className={s.description}>{issue.description}</div> : <p className={s.muted}>説明はありません</p>}
          </section>

          <PlanSection key={issue.id} plan={issue.plan} />
          <DocumentsSection documents={issue.documents} />
          <SubIssuesSection issues={issue.children} />
          <ActivitySection activity={issue.activity} />
        </article>

        <aside className={s.rail}>
          <QuestionsPanel questions={issue.questions} />
          <PropertiesPanel issue={issue} workspaceName={wsName} />
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
      <h2 className={s.sectionTitle}>Sub-issue</h2>
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
