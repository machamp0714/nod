import type { Sprint, SprintDetail, SprintItem, SprintLink, SprintRolloverStatus } from "@nod/core";

// 期限到来時の自動引継ぎ（NOD-59）の表示。
// core の SPRINT_ROLLOVER_ACTOR と同じ値。core の定数は DB を扱う module にあり画面から読み込めないため写す（テストで一致を確かめる）
export const SPRINT_AUTOMATION_ACTOR = "nod-automation";

export function sprintLinkLabel(sprint: Pick<SprintLink, "number" | "name">): string {
  return `Sprint ${sprint.number}「${sprint.name}」`;
}

// 後継の予定。sprint があれば画面はその Sprint へのリンクを文の後ろに出す
export function rolloverSuccessorPlan(successor: SprintRolloverStatus["successor"]): { text: string; sprint: SprintLink | null } {
  if (!successor) return { text: "予定なし", sprint: null };
  switch (successor.kind) {
    case "existing":
      return { text: "既存のSprintを後継にする", sprint: successor.sprint };
    case "start":
      return { text: "後継の開始を待っている", sprint: successor.sprint };
    case "create":
      return { text: `新しいSprintを作成する（${successor.startDate}〜${successor.endDate}、${successor.timezone}）`, sprint: null };
  }
}

// 自動処理が開始したSprint。人の開始と、記録の無い既存のSprintは含めない
export function isAutoStarted(sprint: Pick<Sprint, "activatedBy">): boolean {
  return sprint.activatedBy === SPRINT_AUTOMATION_ACTOR;
}

// 自動開始した計画の無いSprintは、合意が不明なのではなく合意を経ていない
export function sprintAgreementText(sprint: Pick<Sprint, "adoptedPlanId" | "activatedBy">): string {
  if (sprint.adoptedPlanId) return "採用計画あり";
  return isAutoStarted(sprint) ? "なし（自動開始。計画は後から提案・合意できます）" : "不明";
}

// 前Sprintから自動引継ぎで入ったitem
export function carriedItems(sprint: Pick<SprintDetail, "items">): SprintItem[] {
  return sprint.items.filter((item) => item.rolloverFromItemId !== null);
}
