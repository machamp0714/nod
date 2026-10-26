import { Link } from "@tanstack/react-router";
import { useSprints } from "../api/hooks/sprints";
import { errorMessage } from "../api/errors";
import { useWorkspaces } from "../api/hooks/shared";
import { Button, Icon, PageError, PageHeader, PageLoading, PageTitle } from "../components/ui";
import { SPRINT_PHASE_LABEL } from "../lib/sprints";
import s from "./projects.module.css";

export function SprintsPage() {
  const sprints = useSprints();
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
  </div>;
}
