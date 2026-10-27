import { Link } from "@tanstack/react-router";
import { useSprints, useUnresolvedSprintHistory } from "../api/hooks/sprints";
import { errorMessage } from "../api/errors";
import { useWorkspaces } from "../api/hooks/shared";
import { Button, Icon, PageError, PageHeader, PageLoading, PageTitle } from "../components/ui";
import { SPRINT_PHASE_LABEL } from "../lib/sprints";
import s from "./projects.module.css";
import historyStyle from "./cycle-detail.module.css";

export function SprintsPage() {
  const sprints = useSprints();
  const unresolved = useUnresolvedSprintHistory();
  const workspaces = useWorkspaces();
  return <div className={s.page}>
    <PageHeader><PageTitle>Sprints</PageTitle></PageHeader>
    {sprints.error ? <><PageError message={errorMessage(sprints.error)} /><Button onClick={() => void sprints.refetch()}>再試行</Button></> : !sprints.data ? <PageLoading /> :
      sprints.data.length === 0 ? <p className={s.muted} style={{ padding: 24 }}>Sprint はまだありません</p> :
      <div style={{ overflowX: "auto" }}><table className={s.table}>
        <thead><tr><th>名前</th><th>期間</th><th>状態・由来</th><th>Workspace</th><th>元ID</th></tr></thead>
        <tbody>{sprints.data.map((sprint) => <tr key={sprint.id}>
          <td><div className={s.name}><Icon name="calendar-range" /><Link to="/sprints/$sprintId" params={{ sprintId: sprint.id }} className={s.nameLink}>{sprint.name}</Link></div></td>
          <td>{sprint.startDate} – {sprint.endDate}</td><td>{SPRINT_PHASE_LABEL[sprint.phase]}</td>
          <td>{sprint.workspaceId === null ? "共通の移行履歴" : workspaces.data?.find((item) => item.id === sprint.workspaceId)?.name ?? "不明"}</td>
          <td>{sprint.legacyCycleId ?? "—"}</td>
        </tr>)}</tbody>
      </table></div>}
    {unresolved.error ? <section className={historyStyle.evidence} aria-label="関連未確定の旧履歴">
      <PageError message={errorMessage(unresolved.error)} /><Button onClick={() => void unresolved.refetch()}>旧履歴を再試行</Button>
    </section> : unresolved.data && unresolved.data.issues.length > 0 &&
      <section className={historyStyle.evidence} aria-label="関連未確定の旧履歴">
        <h2>関連未確定の旧履歴</h2>
        <p>元期間との所属・採択は未確定です。旧名から期間や現在の所属を推定しません。</p>
        <p>移行時の写し（{unresolved.data.capturedAt ?? "取得時点不明"}）。現在のIssueや期間終了時点の状態とは区別して表示します。</p>
        {unresolved.data.issues.map(item => <details key={item.sourceIssueId}>
          <summary>{item.sourceIssueKey} / {item.snapshot.workspace.name}（{item.snapshot.workspace.key}）</summary>
          <p>元Issue ID {item.sourceIssueId} / 移行時の写し / {item.snapshot.capturedAt}</p>
          <pre>{JSON.stringify(item.snapshot, null, 2)}</pre>
          {item.events.map(event => <div key={event.id}>
            <p>元イベント #{event.id} / 元Issue ID {event.issue_id} / {event.actor} / {event.created_at} / 関連未確定</p>
            <pre>{event.type}: {event.data}</pre>
          </div>)}
        </details>)}
      </section>}
  </div>;
}
