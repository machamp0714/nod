import { getRouteApi } from "@tanstack/react-router";
import type { Issue } from "../api/types";
import { QueueEmpty, QueueItem } from "../components/split/QueueItem";
import { SplitLayout } from "../components/split/SplitLayout";
import { AgentAvatar, Button, StatusLabel, WorkspaceBadge } from "../components/ui";
import { TRIAGE_ISSUES } from "../fixtures/inbox";
import { workspaceName } from "../fixtures/workspaces";
import { formatRelative } from "../lib/format";
import d from "./decision.module.css";

const route = getRouteApi("/triage");

export function TriagePage() {
  const { selected } = route.useSearch();
  const items = TRIAGE_ISSUES;
  const current = items.find((i) => i.id === selected) ?? items[0];
  return (
    <SplitLayout
      title="Triage"
      count={items.length}
      listLabel="Triage の一覧"
      list={
        items.length === 0 ? (
          <QueueEmpty>Triage の Issue はありません</QueueEmpty>
        ) : (
          items.map((issue) => (
            <QueueItem
              key={issue.id}
              to="/triage"
              issueId={issue.id}
              title={issue.title}
              actor={issue.createdBy}
              at={issue.createdAt}
              body={issue.description ?? undefined}
              workspaceKey={issue.workspace}
              workspaceName={workspaceName(issue.workspace)}
              selected={issue === current}
            />
          ))
        )
      }
      detail={current ? <TriageDetail issue={current} /> : <p className={d.empty}>Triage の Issue はありません</p>}
    />
  );
}

function TriageDetail({ issue }: { issue: Issue }) {
  return (
    <div className={d.detail}>
      <div className={d.crumb}>
        <WorkspaceBadge workspaceKey={issue.workspace} name={workspaceName(issue.workspace)} />
        <span className={d.id}>{issue.id}</span>
        <StatusLabel status={issue.status} />
      </div>
      <h2 className={d.title}>{issue.title}</h2>
      <div className={d.reporter}>
        <AgentAvatar actor={issue.createdBy} />
        <span>
          {issue.createdBy} が起票 · {formatRelative(issue.createdAt)}
        </span>
      </div>
      <p className={d.body}>{issue.description ?? "説明はありません"}</p>
      <div className={d.actions}>
        <Button variant="primary" icon="check" disabled title="準備中">
          受け入れる
        </Button>
        <Button icon="copy" disabled title="準備中">
          重複にする
        </Button>
        <Button icon="alarm-clock" disabled title="準備中">
          後回し
        </Button>
        <span className={d.spacer} />
        <Button variant="danger" icon="x" disabled title="準備中">
          却下
        </Button>
      </div>
    </div>
  );
}
