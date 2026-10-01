import type { IssueColumn, IssueGroupKey, IssueSort } from "../routes/search";

// 表示設定（Display Popover）と View の保存内容の表示に使う、グループ化・並び順・列の名前
export const GROUP_NAMES: Record<IssueGroupKey, string> = {
  workspace: "Workspace",
  status: "Status",
  priority: "Priority",
  project: "Project",
  cycle: "Cycle",
  assignee: "担当",
  label: "ラベル",
};
// short はコンボボックス（幅 100）に出す短い名前
export const SORT_OPTIONS: { value: IssueSort; label: string; short?: string }[] = [
  { value: "default", label: "既定（Status・優先度・ID）", short: "既定" },
  { value: "priority", label: "優先度" },
  { value: "createdAt", label: "作成日時" },
  { value: "updatedAt", label: "更新日時" },
  { value: "title", label: "タイトル" },
  { value: "estimate", label: "見積もり" },
  { value: "dueDate", label: "期限" },
];

export const COLUMN_NAMES: Record<IssueColumn, string> = { priority: "優先度", status: "Status", questions: "未決事項", workspace: "Workspace", project: "Project", assignee: "担当", pr: "PR", estimate: "見積もり", dueDate: "期限" };
