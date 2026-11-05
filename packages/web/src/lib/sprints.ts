import type { Issue, Sprint, SprintDetail, SprintPhase, SprintReference } from "../api/types";
import type { IssueListRow } from "../components/issue-list/types";

export const SPRINT_PHASE_LABEL: Record<SprintPhase, string> = {
  imported: "移行履歴・読取専用", draft: "下書き", ready: "準備完了", active: "進行中", ended: "終了", canceled: "中止",
};

// Issue の Sprint 参照の由来。移行した履歴、Sprint への追加、合意済み計画の採択を区別する
const SPRINT_ASSOCIATION_LABEL: Record<SprintReference["association"], string> = { imported: "移行履歴", added: "追加", adopted: "採択" };
export function sprintAssociationLabel(association: SprintReference["association"]): string {
  return SPRINT_ASSOCIATION_LABEL[association];
}

// 開いている Sprint（所属を指定・変更・解除できる phase）。並びの順もこの順にする
const OPEN_SPRINT_ORDER: Partial<Record<SprintPhase, number>> = { active: 0, ready: 1, draft: 2 };
const isOpen = (phase: SprintPhase) => OPEN_SPRINT_ORDER[phase] !== undefined;

// 開いている所属が2件以上のときのピルの値。どの項目とも一致しないため、どれを選んでも設定の操作を呼ぶ
export const MULTIPLE_SPRINTS = "*multiple*";

export interface SprintChoice extends Pick<Sprint, "id" | "number" | "name" | "phase" | "startDate" | "endDate"> {
  overdue: boolean; // 期限を過ぎた進行中
  disabled: boolean; // 選ぶと計画で採択された所属が外れる
}

export interface SprintPicker {
  value: string; // "" はなし。開いている所属が1件ならその Sprint の ID、2件以上なら MULTIPLE_SPRINTS
  label: string; // ピルの文字
  choices: SprintChoice[]; // 「なし」を除く項目
  noneDisabled: boolean;
  locked: boolean; // 採択が2件以上で、どれを選んでも採択が外れる
  blockedBy: string[]; // 外せない（計画で採択された）開いている所属の Sprint 名
}

// Issue 詳細の Sprint のピル（NOD-56）。項目は Issue と同じ Workspace（ID で照合し、Sprint の Workspace の写しは使わない）の開いている Sprint で、
// Scrum 運用の有効・無効では絞らない。外せるかはサーバーの拒否条件と同じく、開いている所属の inAdoptedPlan だけで決める
export function sprintPicker(memberships: readonly SprintReference[], sprints: readonly Sprint[], workspaceId: number | null, now: number): SprintPicker {
  const open = memberships.filter((m) => isOpen(m.phase));
  const adopted = open.filter((m) => m.inAdoptedPlan);
  const keep = adopted.length === 1 ? adopted[0]!.id : null;
  const choices = sprints
    .filter((sprint) => workspaceId !== null && sprint.workspaceId === workspaceId && isOpen(sprint.phase))
    .sort((a, b) => OPEN_SPRINT_ORDER[a.phase]! - OPEN_SPRINT_ORDER[b.phase]! || a.startDate.localeCompare(b.startDate) || a.number - b.number)
    .map(({ id, number, name, phase, startDate, endDate, endsAt }) => ({
      id, number, name, phase, startDate, endDate,
      overdue: phase === "active" && endsAt !== null && now >= Date.parse(endsAt),
      disabled: adopted.length > 0 && id !== keep,
    }));
  const value = open.length === 0 ? "" : open.length === 1 ? open[0]!.id : MULTIPLE_SPRINTS;
  const label = open.length === 0 ? "なし" : open.length === 1 ? open[0]!.name : `${open.length} 件の Sprint`;
  return { value, label, choices, noneDisabled: adopted.length > 0, locked: adopted.length > 1, blockedBy: adopted.map((m) => m.name) };
}

// 移行時の元Issueを共通一覧の表示型へ写す。現在のIssueから過去の状態を補わない。
export function sprintSnapshotRows(sprint: SprintDetail): IssueListRow[] {
  const sourceKeys = new Map([...sprint.evidence, ...sprint.items].map(item => [item.snapshot.issue.id, item.sourceIssueKey]));
  return sprint.items.filter((item) => item.origin === "imported").map((item) => {
    const { snapshot } = item;
    const raw = snapshot.issue;
    const text = (key: string) => typeof raw[key] === "string" ? raw[key] as string : null;
    const issue: Issue = {
      id: item.sourceIssueKey, workspace: snapshot.workspace.key, number: Number(item.sourceIssueKey.split("-").at(-1)),
      title: raw.title, description: raw.description, status: raw.status as Issue["status"],
      priority: typeof raw.priority === "number" ? raw.priority : 0,
      estimate: typeof raw.estimate === "number" ? raw.estimate : null,
      dueDate: text("due_date"), assignee: text("assignee"), agentState: null,
      parentId: typeof raw.parent_id === "number" ? sourceKeys.get(raw.parent_id) ?? null : null,
      project: snapshot.project && typeof snapshot.project.id === "number" && typeof snapshot.project.name === "string" ? { id: snapshot.project.id, name: snapshot.project.name } : null,
      milestone: null, sprints: [{ id: sprint.id, number: sprint.number, name: sprint.name, workspaceId: sprint.workspaceId, phase: "imported", association: "imported", inAdoptedPlan: false }],
      cycle: null, labels: snapshot.labels, blockedBy: [], questionCount: { answered: 0, total: 0 }, completionCandidate: false,
      snoozedUntil: null, prUrl: text("pr_url"), branch: text("branch"), worktree: text("worktree"), closeReason: text("close_reason"),
      createdBy: text("created_by") ?? "不明", createdAt: text("created_at") ?? snapshot.capturedAt,
      updatedAt: text("updated_at") ?? snapshot.capturedAt, startedAt: text("started_at"), closedAt: text("closed_at"), archivedAt: text("archived_at"),
    };
    return { issue, ready: false, questions: { decided: 0, total: 0 }, workspaceName: snapshot.workspace.name, hasParent: typeof raw.parent_id === "number" };
  });
}
