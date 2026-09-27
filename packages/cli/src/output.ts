import {
  type ActivityItem,
  type Issue,
  type IssueDetail,
  NodError,
  type Plan,
  type Status,
  type StepStatus,
  toNodError,
} from "@nod/core";

export const STATUS_LABEL: Record<Status, string> = {
  triage: "Triage",
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  canceled: "Canceled",
};

export const PRIORITY_LABEL = ["なし", "Urgent", "High", "Medium", "Low"];

const STEP_MARK: Record<StepStatus, string> = { pending: "[ ]", doing: "[~]", done: "[x]", skipped: "[-]" };

export function print(out: { json: boolean }, data: unknown, text: () => string): void {
  console.log(out.json ? JSON.stringify(data, null, 2) : text());
}

export function printError(err: unknown, json: boolean): void {
  const e = toNodError(err);
  const body =
    e instanceof NodError
      ? { code: e.code, message: e.message }
      : { code: "UNEXPECTED", message: e instanceof Error ? e.message : String(e) };
  if (json) console.log(JSON.stringify({ error: body }, null, 2));
  else console.error(`エラー（${body.code}）: ${body.message}`);
}

export function formatIssueLine(i: Issue): string {
  const agent = i.agentState ? ` [${i.agentState}]` : "";
  return `${i.id}  ${STATUS_LABEL[i.status].padEnd(11)}${agent}  ${i.title}`;
}

export function formatPlan(plan: Plan): string[] {
  const lines: string[] = [];
  plan.tasks.forEach((t, i) => {
    lines.push(`  ${i + 1}. ${STEP_MARK[t.status]} ${t.title}`);
    t.steps.forEach((s, j) => lines.push(`     ${i + 1}.${j + 1} ${STEP_MARK[s.status]} ${s.title}`));
  });
  return lines;
}

function formatActivity(a: ActivityItem): string {
  const at = a.at.slice(0, 16).replace("T", " ");
  if (a.kind === "comment") return `  ${at}  ${a.actor}: ${a.body}`;
  if (a.kind === "question") {
    const answer = a.answer !== null ? `\n    → ${a.answeredBy}: ${a.answer}` : "";
    return `  ${at}  ${a.actor} が確認を依頼: ${a.question}${answer}`;
  }
  return `  ${at}  ${a.actor} ${a.type} ${JSON.stringify(a.data)}`;
}

export function formatIssueDetail(d: IssueDetail): string {
  const lines = [
    `${d.id}  ${d.title}`,
    `ステータス: ${STATUS_LABEL[d.status]}${d.agentState ? `（作業状況: ${d.agentState}）` : ""}`,
    `優先度: ${PRIORITY_LABEL[d.priority] ?? d.priority}${d.assignee ? `  担当: ${d.assignee}` : ""}${d.parentId ? `  親: ${d.parentId}` : ""}`,
  ];
  if (d.project) lines.push(`Project: ${d.project.name}`);
  if (d.labels.length) lines.push(`ラベル: ${d.labels.join(", ")}`);
  if (d.prUrl) lines.push(`PR: ${d.prUrl}`);
  if (d.worktree) lines.push(`実行場所: ${d.branch ?? "(detached)"}  ${d.worktree}`);
  if (d.description) lines.push("", d.description);
  if (d.plan.tasks.length) lines.push("", `計画${d.plan.source ? `（${d.plan.source}）` : ""}:`, ...formatPlan(d.plan));
  if (d.documents.length) {
    lines.push("", "Documents:", ...d.documents.map((doc) => `  - ${doc.title}（${doc.kind}）${doc.path}`));
  }
  if (d.openQuestions.length) {
    lines.push("", "未回答の確認依頼:", ...d.openQuestions.map((q) => `  - ${q.question}（${q.askedBy}）`));
  }
  if (d.children.length) lines.push("", "Sub-issue:", ...d.children.map((c) => `  ${formatIssueLine(c)}`));
  const relations: [string, string[]][] = [
    ["ブロックしている", d.relations.blocks],
    ["ブロックされている", d.relations.blockedBy],
    ["関連", d.relations.related],
    ["重複元", d.relations.duplicateOf],
    ["重複", d.relations.duplicates],
  ];
  const relationLines = relations.filter(([, ids]) => ids.length).map(([label, ids]) => `  ${label}: ${ids.join(", ")}`);
  if (relationLines.length) lines.push("", "関係:", ...relationLines);
  if (d.activity.length) lines.push("", "Activity:", ...d.activity.map(formatActivity));
  return lines.join("\n");
}
