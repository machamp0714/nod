import {
  type ActivityItem,
  DEFAULT_STATUS_LABELS,
  HUMAN_ACTOR,
  type StatusNames,
  type AgentState,
  type Issue,
  type IssueAttachment,
  type IssueDetail,
  attachmentName,
  isOverdue,
  localToday,
  NodError,
  type OpenQuestions,
  type Plan,
  type Status,
  type StepStatus,
  toNodError,
  type Notification,
  type SuggestionReason,
  type TriageDecision,
  type TriageProposal,
  type TriageSuggestions,
  WORK_LOG_KIND_LABEL,
  INSTRUCTION_KIND_LABEL,
  type AgentInstruction,
  type PrReviewDecision,
  type PrState,
  type PrStatus,
  type PrStatusView,
  type PrDiffFile,
  type PrDiffFileSummary,
  type PrDiffView,
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
      ? { code: e.code, message: e.message, ...(e.details === undefined ? {} : { details: e.details }) }
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
export function statusColumnWidth(issues: Pick<Issue, "status" | "id">[]): number {
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

// 未決事項の決定数 / 総数のタグ。未決事項のない Issue には付けない
function questionCountTag(count: Issue["questionCount"]): string {
  return count.total > 0 ? `  [未決 ${count.answered}/${count.total}]` : "";
}

// 未回答の未決事項の一覧（#173）。Issue ごとにまとめ、質問は nod answer --question に渡す #番号つきで出す
// llm は実行者が LLM のとき。me が付けた未決事項は LLM が回答できないので、回答のしかたの代わりにそのことを案内する
export function formatOpenQuestions(r: OpenQuestions, llm = false): string {
  if (r.total === 0) return "未回答の未決事項はありません";
  const groups = new Map<string, OpenQuestions["questions"]>();
  for (const q of r.questions) groups.set(q.issueId, [...(groups.get(q.issueId) ?? []), q]);
  const width = statusColumnWidth(r.questions.map((q) => ({ status: q.status, id: q.issueId })));
  const lines = [`未回答の未決事項 ${r.total} 件（${r.issueCount} Issue）`];
  for (const [issueId, questions] of groups) {
    const head = questions[0]!;
    const status = statusText(head.status, issueId);
    lines.push(`${issueId}  ${status}${" ".repeat(width - displayWidth(status))}  ${head.issueTitle}${questionCountTag(head.questionCount)}`);
    for (const q of questions) lines.push(`  #${q.id} ${q.question.replaceAll("\n", "\n     ")}（${q.askedBy}・${localDate(q.askedAt)}）`);
  }
  if (r.more > 0) lines.push(`ほか ${r.more} Issue`);
  const forMe = llm && r.questions.some((q) => q.askedBy === HUMAN_ACTOR);
  lines.push("", forMe ? "me が付けた未決事項は me が決めます（LLM は回答できません）" : "回答: nod answer <Issue の ID> <回答> --question <#番号>");
  return lines.join("\n");
}

// 記録時刻をこのマシンのローカルの暦日（YYYY-MM-DD）にする
function localDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const PRIORITY_NAMES = ["-", "Urgent", "High", "Medium", "Low"];
const PRIORITY_WIDTH = 6;
const PROJECT_MAX_WIDTH = 20;

function padEnd(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - displayWidth(text)))}`;
}

// 表示幅が max を超える文字列を、末尾を … にして max に収める
function truncate(text: string, max: number): string {
  if (displayWidth(text) <= max) return text;
  let out = "";
  for (const c of text) {
    if (displayWidth(out + c) > max - 1) break;
    out += c;
  }
  return `${out}…`;
}

// nod issue list の行（#174）。1行表示のステータスとタイトルの間に、優先度と Project の列を足す。
// 優先度なしと Project なしは - にし、Project は一覧の中の最大幅（20 桁まで。超える名前は … で切る）にそろえる。
// [working] や [archived] のタグは状態のすぐ後ろに置いたまま、状態とタグをひとまとまりとして全行の最大幅にそろえる。
// 行末には未決事項の決定数 / 総数を付ける（#173）
export function formatIssueListLines(issues: Issue[]): string[] {
  const statusWidth = statusColumnWidth(issues);
  const states = issues.map((i) => `${padEnd(statusText(i.status, i.id), statusWidth)}${i.agentState ? ` [${i.agentState}]` : ""}${i.archivedAt ? " [archived]" : ""}`);
  const stateWidth = Math.max(0, ...states.map(displayWidth));
  const projects = issues.map((i) => (i.project ? truncate(i.project.name, PROJECT_MAX_WIDTH) : "-"));
  const projectWidth = Math.max(1, ...projects.map(displayWidth));
  return issues.map((i, n) => {
    const candidate = i.completionCandidate ? " [完了候補]" : "";
    const priority = padEnd(PRIORITY_NAMES[i.priority] ?? "-", PRIORITY_WIDTH);
    return `${i.id}  ${padEnd(states[n] ?? "", stateWidth)}  ${priority}  ${padEnd(projects[n] ?? "-", projectWidth)}  ${i.title}${candidate}${questionCountTag(i.questionCount)}`;
  });
}

// 委任中の一覧は担当の LLM 順に並べる。同じ担当の中では元の順（--sort の順。既定は Workspace、番号）を保つ
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
      return [`${agent}（${rows.length}件: ${breakdown}）`, ...formatIssueListLines(rows).map((line) => `  ${line}`)].join("\n");
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
    const kind = a.logKind
      ? ` [${WORK_LOG_KIND_LABEL[a.logKind]}]`
      : a.instruction
        ? ` [${INSTRUCTION_KIND_LABEL[a.instruction.kind]}${a.instruction.acknowledgedAt ? "" : "・未確認"}]`
        : "";
    return `  ${at}  #${a.id} ${a.actor}${kind}: ${a.body}${resolved}${replies}`;
  }
  if (a.kind === "question") {
    const answer = a.answer !== null ? `\n    → ${a.answeredBy}: ${a.answer}` : "";
    return `  ${at}  ${a.actor} が確認を依頼: ${a.question}${answer}`;
  }
  return `  ${at}  ${a.actor} ${a.type} ${JSON.stringify(a.data)}`;
}

const SEND_STATE_LABEL: Record<AgentInstruction["sendState"], string> = {
  unsent: "未送信",
  sending: "送信中",
  sent: "送信済み",
  unconfirmed: "送信結果不明",
  failed: "送信失敗",
};

// 追加指示・対応依頼（#51・#58）の一覧。本文は複数行でもそのまま字下げして出す
export function formatInstructions(list: AgentInstruction[]): string[] {
  return list.map((i) => {
    const at = i.createdAt.slice(0, 16).replace("T", " ");
    const state = i.sendState === "sent" && i.sentAgent ? `送信済み → ${i.sentAgent}` : SEND_STATE_LABEL[i.sendState];
    const ack = i.acknowledgedAt ? `・${i.acknowledgedBy} が確認済み` : "";
    return `  #${i.id} ${at} ${i.createdBy} [${INSTRUCTION_KIND_LABEL[i.kind]}・${state}${ack}]\n    ${i.body.replaceAll("\n", "\n    ")}`;
  });
}

// 親の完了候補の案内。確定は人が既存の経路で行う（LLM はどちらも拒否される）
function formatCompletionCandidate(d: IssueDetail): string {
  const count = (status: string) => d.children.filter((c) => c.status === status).length;
  const how = d.status === "in_review" ? `nod review approve ${d.id}` : `nod issue update ${d.id} --status done`;
  return `完了候補: Sub-issue がすべて完了しています（完了 ${count("done")}・キャンセル ${count("canceled")}）。人が ${how} で完了にできます`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// 添付1件の行。<id>  <表示名>  <URL か サイズ>  <添付者>
export function formatAttachment(a: IssueAttachment): string {
  const where = a.kind === "link" ? a.url : formatBytes(a.size ?? 0);
  return `${a.id}  ${attachmentName(a)}  ${where}  ${a.createdBy}`;
}

export function formatIssueDetail(d: IssueDetail, prStatusLine: string | null = null): string {
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
  if (d.milestone) lines.push(`Milestone: ${d.milestone.name}`);
  if (d.cycle) lines.push(`Cycle: ${d.cycle.name}`);
  if (d.labels.length) lines.push(`ラベル: ${d.labels.join(", ")}`);
  if (d.prUrl) lines.push(`PR: ${d.prUrl}`);
  if (d.prUrl && prStatusLine) lines.push(prStatusLine);
  if (d.worktree) lines.push(`実行場所: ${d.branch ?? "(detached)"}  ${d.worktree}`);
  if (d.subscribed) lines.push("購読: 購読中");
  if (d.reminder) lines.push(`リマインダー: ${d.reminder.remindAt}${d.reminder.note ? `  ${d.reminder.note}` : ""}`);
  if (d.description) lines.push("", d.description);
  if (d.plan.tasks.length) lines.push("", `計画${d.plan.source ? `（${d.plan.source}）` : ""}:`, ...formatPlan(d.plan));
  if (d.documents.length) {
    lines.push("", "Documents:", ...d.documents.map((doc) => `  - ${doc.title}（${doc.kind}）${doc.path}`));
  }
  if (d.attachments.length) lines.push("", "添付:", ...d.attachments.map((a) => `  - ${formatAttachment(a)}`));
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
  if (d.pendingInstructions.length) lines.push("", "未確認の追加指示:", ...formatInstructions(d.pendingInstructions));
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
    case "triage_proposed": {
      const p = n.data as { decision?: unknown; duplicateOf?: unknown };
      const what = p.decision === "accept" ? "受け入れ" : p.decision === "decline" ? "却下" : p.decision === "duplicate" ? `重複（元: ${String(p.duplicateOf)}）` : String(p.decision);
      return `${n.actor} が Triage を提案: ${what}（確定は人が行います）`;
    }
    case "reminder": {
      const note = (n.data as { note?: unknown }).note;
      return typeof note === "string" && note ? `リマインダー: ${note}` : "リマインダーの時刻です";
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

const DECISION_LABEL: Record<TriageDecision, string> = { accept: "受け入れ", decline: "却下", duplicate: "重複" };

export function formatTriageProposal(p: TriageProposal): string {
  const attrs = [
    p.duplicateOf && `元: ${p.duplicateOf}`,
    p.project && `Project: ${p.project.name}`,
    p.priority !== null && `Priority: ${p.priority}`,
    p.labels.length > 0 && `Labels: ${p.labels.join(", ")}`,
    p.assignee && `Assignee: ${p.assignee}`,
  ].filter(Boolean);
  return [`${p.issueId}  ${p.actor}  ${DECISION_LABEL[p.decision]}${attrs.length ? `  ${attrs.join("  ")}` : ""}  ${p.updatedAt}`, ...(p.reason ? [`  理由: ${p.reason}`] : [])].join("\n");
}

export function formatTriageProposals(ref: string, list: TriageProposal[]): string {
  if (list.length === 0) return `${ref} の提案はありません`;
  return [`${ref} の提案（確定は人が行います: nod triage accept / decline / duplicate）`, ...list.map(formatTriageProposal)].join("\n");
}

const PR_STATE_LABEL: Record<PrState, string> = { OPEN: "Open", CLOSED: "Closed", MERGED: "Merged" };
const REVIEW_LABEL: Record<PrReviewDecision, string> = {
  APPROVED: "承認済み",
  CHANGES_REQUESTED: "変更要求",
  REVIEW_REQUIRED: "レビュー待ち",
};

const prState = (s: PrStatus) => `${PR_STATE_LABEL[s.state]}${s.isDraft && s.state === "OPEN" ? "（Draft）" : ""}`;
const prReview = (s: PrStatus) => (s.reviewDecision ? REVIEW_LABEL[s.reviewDecision] : "—");
function prChecks(s: PrStatus): string {
  const c = s.checkSummary;
  return s.checks.length ? `成功 ${c.success} / 失敗 ${c.failure} / 実行中 ${c.pending} / スキップ ${c.skipped}` : "なし";
}

function prSummary(s: PrStatus): string {
  return `${prState(s)} · レビュー: ${prReview(s)} · CI: ${prChecks(s)}`;
}

// nod issue show に添える1行。未取得・PR なしは何も出さない（取得方法は pr-status が案内する）
export function formatPrStatusLine(v: PrStatusView): string | null {
  if (!v.prUrl) return null;
  if (v.status) return `PR 状態: ${prSummary(v.status)}（取得: ${v.status.fetchedAt}）`;
  if (v.fetchError) return `PR 状態: 取得に失敗（${v.fetchError.code}）`;
  return null;
}

// nod review approve に添える GitHub 側の状態（#56/#57）。保存済みの結果だけを読み、gh は実行しない。
// 未マージ・変更要求は注意として出すが、承認は止めない。保存済みの結果は古いことがあるので「取得時点で」と添える
export const APPROVAL_NOTE = "nod の承認は GitHub の承認・マージではありません。GitHub には何も書き込みません";

export function approvalWarnings(s: PrStatus): string[] {
  const warnings: string[] = [];
  if (s.state === "CLOSED") warnings.push(`取得時点で GitHub の PR はマージされずに閉じられています（${prState(s)}）`);
  else if (s.state !== "MERGED") warnings.push(`取得時点で GitHub の PR はまだマージされていません（${prState(s)}）`);
  if (s.reviewDecision === "CHANGES_REQUESTED") warnings.push("取得時点で GitHub に変更要求が出ています");
  return warnings;
}

export function formatApprovalGithub(v: PrStatusView): string[] {
  const lines: string[] = [];
  if (v.prUrl) {
    if (v.status) {
      lines.push(`GitHub: #${v.status.number} ${prSummary(v.status)}（取得: ${v.status.fetchedAt}）`);
      lines.push(...approvalWarnings(v.status).map((w) => `注意: ${w}`));
    } else {
      lines.push(`GitHub の状態は未取得（nod issue pr-status ${v.issueId} --refresh で取得）`);
    }
  }
  lines.push(APPROVAL_NOTE);
  return lines;
}

export function formatPrStatus(v: PrStatusView): string {
  if (!v.prUrl) return `${v.issueId} に PR がありません`;
  const lines = [`${v.issueId}  PR: ${v.prUrl}`];
  if (v.fetchError) {
    lines.push(`取得に失敗（${v.fetchError.code}）: ${v.fetchError.message}（${v.fetchError.at}）`);
  }
  if (v.status) {
    const s = v.status;
    const label = v.fetchError ? "前回取得" : "取得";
    lines.push(
      `#${s.number} ${s.title}`,
      `状態: ${prState(s)}${s.mergedAt ? `（マージ: ${s.mergedAt}）` : ""}`,
      `レビュー: ${prReview(s)}`,
      `CI: ${prChecks(s)}`,
    );
    const failed = s.checks.filter((c) => c.state === "failure").map((c) => c.name);
    if (failed.length) lines.push(`  失敗: ${failed.join(", ")}`);
    lines.push(`${label}: ${s.fetchedAt}（${s.fetchedBy}）`);
  } else if (!v.fetchError) {
    lines.push(`未取得。nod issue pr-status ${v.issueId} --refresh で gh から取得する`);
  }
  if (v.autoTransition) {
    const t = v.autoTransition;
    lines.push(
      `PR 連動: ${t.from} → ${t.to} にしました${t.mergeCandidate ? "（マージ済み: 完了候補。done にするかは人が判断）" : ""}。誤りなら nod automation undo ${t.issueId}`,
    );
  }
  if (v.autoTransitionSkipped) lines.push(`PR 連動: ${v.autoTransitionSkipped}`);
  return lines.join("\n");
}

// PR の差分（#55）。パス・差分は GitHub から来た信頼できない文字列なので、端末の制御文字は置き換えて出す。
// 双方向の制御文字（Trojan Source）は見た目の並びを変えるので、⟪U+202E⟫ のように符号を見せる
const BIDI_RE = /[\u202a-\u202e\u2066-\u2069]/;
// eslint-disable-next-line no-control-regex
const safe = (text: string, keep = "") =>
  text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => (keep.includes(c) ? c : "\ufffd"))
    .replace(new RegExp(BIDI_RE.source, "g"), (c) => `⟪U+${c.codePointAt(0)!.toString(16).toUpperCase()}⟫`);
const BIDI_WARNING = "注意: 双方向の制御文字を含みます（⟪U+…⟫ の箇所）。見た目と実際のコードの並びが異なる恐れがあります";
const shortSha = (sha: string) => sha.slice(0, 7);
const FILE_MARK: Record<PrDiffFile["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };

function diffFileLine(f: PrDiffFileSummary): string {
  const path = f.oldPath ? `${safe(f.oldPath)} → ${safe(f.path)}` : safe(f.path);
  const note = f.omitted === "binary" ? "  バイナリ" : f.omitted === "too_large" ? "  大きいため省略" : "";
  return `  ${FILE_MARK[f.status]} ${path}  +${f.additions} −${f.deletions}${note}`;
}

export function formatPrDiff(v: PrDiffView): string {
  if (!v.prUrl) return `${v.issueId} に PR がありません`;
  const lines = [`${v.issueId}  PR: ${safe(v.prUrl)}`];
  if (v.fetchError) lines.push(`取得に失敗（${v.fetchError.code}）: ${safe(v.fetchError.message)}（${v.fetchError.at}）`);
  if (v.stale) {
    lines.push(
      `PR が更新されています（HEAD ${shortSha(v.stale.diffHeadSha)} → ${shortSha(v.stale.currentHeadSha)}）。nod issue pr-diff ${v.issueId} --refresh で取り直す`,
    );
  }
  if (v.diff) {
    const d = v.diff;
    lines.push(`HEAD ${shortSha(d.headSha)} · 変更ファイル ${d.files.length} · +${d.additions} −${d.deletions}`);
    lines.push(...d.files.map(diffFileLine));
    if (d.files.some((f) => BIDI_RE.test(f.path) || BIDI_RE.test(f.oldPath ?? ""))) lines.push(BIDI_WARNING);
    lines.push(`${v.fetchError ? "前回取得" : "取得"}: ${d.fetchedAt}（${d.fetchedBy}）`);
    if (d.files.length) lines.push(`ファイルの差分: nod issue pr-diff ${v.issueId} --file <パス>`);
  } else if (!v.fetchError && !v.stale) {
    lines.push(`未取得。nod issue pr-diff ${v.issueId} --refresh で gh から取得する`);
  }
  return lines.join("\n");
}

export function formatPrDiffFile(f: PrDiffFile): string {
  const head = diffFileLine(f).trimStart();
  if (f.omitted === "binary") return `${head}\nバイナリのため差分を表示しません`;
  if (f.omitted === "too_large") return `${head}\n大きいため差分を保存していません。GitHub で確認してください`;
  const bidi = [f.path, f.oldPath ?? "", f.patch ?? ""].some((t) => BIDI_RE.test(t));
  return `${head}\n${bidi ? `${BIDI_WARNING}\n` : ""}${f.patch ? safe(f.patch, "\n\t") : "（内容の変更はありません）"}`;
}
