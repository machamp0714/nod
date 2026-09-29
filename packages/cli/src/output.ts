import {
  type ActivityItem,
  DEFAULT_STATUS_LABELS,
  type StatusNames,
  type AgentState,
  type Issue,
  type IssueDetail,
  isOverdue,
  localToday,
  NodError,
  type Plan,
  type Status,
  type StepStatus,
  toNodError,
  type Notification,
  type SuggestionReason,
  type TriageSuggestions,
} from "@nod/core";

export const STATUS_LABEL: Record<Status, string> = DEFAULT_STATUS_LABELS;

// Workspace のキーごとの表示名。openCli が DB から読み込む
let statusNamesByWorkspace: Record<string, StatusNames> = {};

export function useStatusNames(names: Record<string, StatusNames>): void {
  statusNamesByWorkspace = names;
}

// 表示名を変えたステータスは「表示名 (内部値)」で出し、LLM が --status に内部値を使えるようにする
export function statusText(status: Status, issueId: string): string {
  const custom = statusNamesByWorkspace[issueId.slice(0, issueId.lastIndexOf("-"))]?.[status];
  return custom === undefined ? STATUS_LABEL[status] : `${custom} (${status})`;
}

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

// 全角文字は端末で2桁を取るので、列をそろえるときは文字数でなく表示幅で数える
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;

function displayWidth(text: string): number {
  let width = 0;
  for (const c of text) width += WIDE.test(c) ? 2 : 1;
  return width;
}

// ステータス列の幅。表示名は Workspace ごとに長さが違うので、一覧では全行の最大に合わせる
export function statusColumnWidth(issues: Issue[]): number {
  return Math.max(11, ...issues.map((i) => displayWidth(statusText(i.status, i.id))));
}

export function formatIssueLine(i: Issue, statusWidth = statusColumnWidth([i])): string {
  const agent = i.agentState ? ` [${i.agentState}]` : "";
  const candidate = i.completionCandidate ? " [完了候補]" : "";
  const archived = i.archivedAt ? " [archived]" : "";
  const status = statusText(i.status, i.id);
  return `${i.id}  ${status}${" ".repeat(statusWidth - displayWidth(status))}${agent}${archived}  ${i.title}${candidate}`;
}

export function formatIssueLines(issues: Issue[]): string[] {
  const width = statusColumnWidth(issues);
  return issues.map((i) => formatIssueLine(i, width));
}

// 委任中の一覧は担当の LLM 順に並べる。同じ担当の中では元の順（Workspace、番号）を保つ
export function sortByAssignee(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => (a.assignee ?? "").localeCompare(b.assignee ?? ""));
}

const AGENT_STATE_LABEL: [AgentState | null, string][] = [
  ["working", "作業中"],
  ["awaiting_input", "入力待ち"],
  ["error", "エラー"],
  ["done", "完了"],
  [null, "未着手"],
];

// LLM ごとの見出しに件数と作業状況の内訳を付け、その下に Issue を並べる
export function formatDelegations(issues: Issue[]): string {
  if (!issues.length) return "LLM に委任中の Issue はありません";
  const groups = new Map<string, Issue[]>();
  for (const i of issues) groups.set(i.assignee ?? "", [...(groups.get(i.assignee ?? "") ?? []), i]);
  return [...groups]
    .map(([agent, rows]) => {
      const breakdown = AGENT_STATE_LABEL.map(([state, label]) => [label, rows.filter((r) => r.agentState === state).length] as const)
        .filter(([, n]) => n > 0)
        .map(([label, n]) => `${label} ${n}`)
        .join("・");
      return [`${agent}（${rows.length}件: ${breakdown}）`, ...formatIssueLines(rows).map((line) => `  ${line}`)].join("\n");
    })
    .join("\n\n");
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
  if (a.kind === "comment") {
    const replies = a.replies.map((r) => `\n    ↳ #${r.id} ${r.actor}: ${r.body}`).join("");
    const resolved = a.resolvedAt !== null ? `（解決済み: ${a.resolvedBy}）` : "";
    return `  ${at}  #${a.id} ${a.actor}: ${a.body}${resolved}${replies}`;
  }
  if (a.kind === "question") {
    const answer = a.answer !== null ? `\n    → ${a.answeredBy}: ${a.answer}` : "";
    return `  ${at}  ${a.actor} が確認を依頼: ${a.question}${answer}`;
  }
  return `  ${at}  ${a.actor} ${a.type} ${JSON.stringify(a.data)}`;
}

// 親の完了候補の案内。確定は人が既存の経路で行う（LLM はどちらも拒否される）
function formatCompletionCandidate(d: IssueDetail): string {
  const count = (status: string) => d.children.filter((c) => c.status === status).length;
  const how = d.status === "in_review" ? `nod review approve ${d.id}` : `nod issue update ${d.id} --status done`;
  return `完了候補: Sub-issue がすべて完了しています（完了 ${count("done")}・キャンセル ${count("canceled")}）。人が ${how} で完了にできます`;
}

export function formatIssueDetail(d: IssueDetail): string {
  const lines = [
    `${d.id}  ${d.title}`,
    `ステータス: ${statusText(d.status, d.id)}${d.agentState ? `（作業状況: ${d.agentState}）` : ""}`,
    `優先度: ${PRIORITY_LABEL[d.priority] ?? d.priority}${d.assignee ? `  担当: ${d.assignee}` : ""}${d.parentId ? `  親: ${d.parentId}` : ""}`,
  ];
  if (d.completionCandidate) lines.push(formatCompletionCandidate(d));
  if (d.estimate !== null) lines.push(`見積もり: ${d.estimate} pt`);
  if (d.dueDate !== null) lines.push(`期限: ${d.dueDate}${isOverdue(d, localToday()) ? "（期限超過）" : ""}`);
  if (d.archivedAt) lines.push(`アーカイブ済み: ${d.archivedAt.slice(0, 16).replace("T", " ")}（nod issue unarchive ${d.id} で復元）`);
  if (d.project) lines.push(`Project: ${d.project.name}`);
  if (d.labels.length) lines.push(`ラベル: ${d.labels.join(", ")}`);
  if (d.prUrl) lines.push(`PR: ${d.prUrl}`);
  if (d.worktree) lines.push(`実行場所: ${d.branch ?? "(detached)"}  ${d.worktree}`);
  if (d.subscribed) lines.push("購読: 購読中");
  if (d.description) lines.push("", d.description);
  if (d.plan.tasks.length) lines.push("", `計画${d.plan.source ? `（${d.plan.source}）` : ""}:`, ...formatPlan(d.plan));
  if (d.documents.length) {
    lines.push("", "Documents:", ...d.documents.map((doc) => `  - ${doc.title}（${doc.kind}）${doc.path}`));
  }
  if (d.questions.length) {
    const decided = d.questions.filter((q) => q.answer !== null).length;
    lines.push(
      "",
      `未決事項（${decided} / ${d.questions.length}）:`,
      ...d.questions.map((q) =>
        q.answer === null
          ? `  #${q.id} [ ] ${q.question}（${q.askedBy}）`
          : `  #${q.id} [x] ${q.question}（${q.askedBy}）\n      → ${q.answeredBy}: ${q.answer}`,
      ),
    );
  }
  if (d.children.length) lines.push("", "Sub-issue:", ...formatIssueLines(d.children).map((line) => `  ${line}`));
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

function shown(v: unknown, label?: (v: never) => string): string {
  if (v === null || v === undefined || v === "") return "なし";
  return label ? label(v as never) : String(v);
}

// 通知の1行の要約。「誰が・何を・どう変えたか」
export function describeNotification(n: Notification): string {
  const d = n.data as { from?: unknown; to?: unknown; agent?: unknown; added?: string[]; removed?: string[]; reason?: string };
  const change = (what: string, label?: (v: never) => string) =>
    `${n.actor} が${what}を変更: ${shown(d.from, label)} → ${shown(d.to, label)}`;
  switch (n.eventType) {
    case "status_changed":
      return change("ステータス", (v: Status) => (STATUS_LABEL[v] ? statusText(v, n.issueId) : v));
    case "priority_changed":
      return change("優先度", (v: number) => PRIORITY_LABEL[v] ?? String(v));
    case "assignee_changed":
      return change("担当");
    case "title_changed":
      return change("タイトル");
    case "project_changed":
      return change("Project");
    case "labels_changed": {
      const parts = [...(d.added ?? []).map((l) => `+${l}`), ...(d.removed ?? []).map((l) => `-${l}`)];
      return `${n.actor} がラベルを変更: ${parts.join(" ")}`;
    }
    case "comment_added":
      return `${n.actor} がコメント: ${n.body ?? ""}`;
    case "review_approved":
      return `${n.actor} がレビューを承認`;
    case "review_rejected":
      return `${n.actor} が差し戻し${d.reason ? `: ${d.reason}` : ""}`;
    case "triage_accepted":
      return `${n.actor} が Triage を受け入れ`;
    case "triage_declined":
      return `${n.actor} が Triage を却下${d.reason ? `: ${d.reason}` : ""}`;
    case "agent_state_changed": {
      // 主語は操作した人ではなく、作業を任された担当（data.agent）
      const agent = typeof d.agent === "string" ? d.agent : n.actor;
      if (d.to === "done") return `${agent} が作業を完了（レビュー待ち）`;
      if (d.to === "awaiting_input") return `${agent} が確認を求めた（入力待ち）${d.reason ? `: ${d.reason}` : ""}`;
      if (d.to === "error") return `${agent} がエラーで停止${d.reason ? `: ${d.reason}` : ""}`;
      return `${agent} ${n.eventType}`;
    }
    default:
      return `${n.actor} ${n.eventType}`;
  }
}

export function formatNotification(n: Notification): string {
  const snoozed = n.snoozedUntil ? `  スヌーズ中（${n.snoozedUntil} まで）` : "";
  return `  #${n.id}${n.readAt ? "" : " *"}  ${n.issueId}  ${n.issueTitle}${snoozed}\n    ${describeNotification(n)}`;
}

function describeReason(r: SuggestionReason, what: "付与" | "担当"): string {
  switch (r.kind) {
    case "similar":
      return `類似 Issue ${r.issues.length} 件に${what}（${r.issues.join(", ")}）`;
    case "text":
      return r.field === "title" ? "タイトルにラベル名を含む" : "本文にラベル名を含む";
    case "source":
      return `起票元 ${r.issue} の担当`;
  }
}

export function formatTriageSuggestions(s: TriageSuggestions): string {
  const none = "  なし";
  return [
    `${s.issueId} の提案（採用は人が行います: nod triage duplicate / nod triage accept）`,
    "重複候補",
    ...(s.duplicates.length
      ? s.duplicates.map(
          (d) =>
            `  ${d.id}  ${d.title}  [${statusText(d.status, d.id)}] 一致 ${Math.round(d.score * 100)}%` +
            `${d.sharedTerms.length ? `  共通語: ${d.sharedTerms.join(", ")}` : ""}${d.via ? `  （${d.via} の重複元）` : ""}`,
        )
      : [none]),
    "ラベル候補",
    ...(s.labels.length ? s.labels.map((l) => `  ${l.label}  ${l.reasons.map((r) => describeReason(r, "付与")).join(" / ")}`) : [none]),
    "担当候補",
    ...(s.assignees.length ? s.assignees.map((a) => `  ${a.assignee}  ${a.reasons.map((r) => describeReason(r, "担当")).join(" / ")}`) : [none]),
  ].join("\n");
}
