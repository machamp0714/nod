import type { WorkLogKind } from "./work-log";

export interface Workspace {
  id: number;
  key: string;
  name: string;
  path: string;
  color: string;
  createdAt: string;
}

export const STATUSES = [
  "triage",
  "backlog",
  "needs_clarification",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
] as const;
export type Status = (typeof STATUSES)[number];

export const AGENT_STATES = ["working", "awaiting_input", "error", "done"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export const STEP_STATUSES = ["pending", "doing", "done", "skipped"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const DOC_KINDS = ["spec", "plan", "doc"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export type RelationType = "blocks" | "related" | "duplicate";

export interface Issue {
  id: string;
  workspace: string;
  number: number;
  title: string;
  description: string | null;
  status: Status;
  priority: number;
  estimate: number | null; // 見積もり（ポイント 1〜100）。未設定は null
  dueDate: string | null; // 期限（時刻なしの暦日 YYYY-MM-DD）。未設定は null
  assignee: string | null;
  agentState: AgentState | null;
  parentId: string | null;
  project: { id: number; name: string } | null;
  labels: string[];
  blockedBy: string[]; // 未完了の直接ブロック元の Issue ID
  questionCount: { answered: number; total: number }; // 未決事項（確認依頼）の決定数と総数
  completionCandidate: boolean; // 親の完了候補（直接の子がすべて完了）。確定は人が行う
  snoozedUntil: string | null;
  prUrl: string | null;
  branch: string | null;
  worktree: string | null;
  closeReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  closedAt: string | null;
  archivedAt: string | null; // アーカイブした日時。NULL ならアーカイブされていない
}

export interface PlanStep {
  title: string;
  status: StepStatus;
}

export interface PlanTask {
  title: string;
  status: StepStatus;
  steps: PlanStep[];
}

export interface Plan {
  source: string | null;
  tasks: PlanTask[];
}

export const PROJECT_STATUSES = ["planned", "started", "completed", "canceled"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface UpdateProjectInput {
  status: ProjectStatus;
}

export interface Project {
  id: number;
  name: string;
  description: string | null;
  status: ProjectStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary extends Project {
  total: number;
  done: number;
  agents: { working: number; awaitingInput: number; awaitingReview: number; error: number };
}

export interface ProjectDetail extends ProjectSummary {
  issues: Issue[];
  documents: DocumentRef[];
}

export interface DocumentRef {
  id: number;
  path: string;
  title: string;
  kind: DocKind;
}

export interface DocumentContent extends DocumentRef {
  content: string | null; // ファイルが見つからない、または読めないときは null
}

export interface DocumentIssueLink {
  id: string;
  title: string;
  status: Status;
  archived: boolean; // アーカイブ済みの Issue とのリンクは解除できない
}

export interface DocumentProjectLink {
  id: number;
  name: string;
}

// Document 側から見たリンク先。DocumentContent に加算する
export interface DocumentDetail extends DocumentContent {
  createdAt: string;
  issues: DocumentIssueLink[];
  projects: DocumentProjectLink[];
}

export interface DocumentSummary extends DocumentRef {
  createdAt: string;
  issues: string[]; // リンク先の Issue ID
  projects: DocumentProjectLink[];
}

export interface Question {
  id: number;
  issueId: string;
  question: string;
  askedBy: string;
  askedAt: string;
  answer: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
}

export interface Comment {
  id: number;
  issueId: string;
  author: string;
  body: string;
  createdAt: string;
  // スレッドの親なら null。返信は1階層で、親は常にスレッドの親
  parentId: number | null;
  // スレッドの親が解決済みなら日時と解決した人。未解決と返信は null
  resolvedAt: string | null;
  resolvedBy: string | null;
  // 作業ログの種類（nod issue log）。通常のコメント・返信・種類なしの既存ログは null
  logKind: WorkLogKind | null;
}

export interface CommentReply {
  id: number;
  at: string;
  actor: string;
  body: string;
}

export type ActivityItem =
  | { kind: "event"; at: string; actor: string; type: string; data: Record<string, unknown> }
  | {
      kind: "comment";
      id: number;
      at: string;
      actor: string;
      body: string;
      replies: CommentReply[];
      resolvedAt: string | null;
      resolvedBy: string | null;
      logKind: WorkLogKind | null;
    }
  | {
      kind: "question";
      at: string;
      actor: string;
      question: string;
      answer: string | null;
      answeredBy: string | null;
      answeredAt: string | null;
    };

export interface Relations {
  blocks: string[];
  blockedBy: string[];
  related: string[];
  duplicateOf: string[];
  duplicates: string[];
}

export interface InboxQuestion extends Question {
  issueTitle: string;
  workspace: string;
  branch: string | null;
  worktree: string | null;
}

export interface ReviewReport { actor: string; at: string; body: string }
export interface ReviewIssue extends Issue {
  reviewSummary: string | null;
  reviewReport: ReviewReport | null;
  reviewSubmittedAt: string | null;
}
export interface AcceptTriageInput {
  projectRef?: string | null;
  priority?: number;
  addLabels?: string[];
  removeLabels?: string[];
  assignee?: string | null;
}
export interface IssueDocumentRef extends DocumentRef {
  attachedBy: string | null;
  attachedAt: string | null;
}

export interface Inbox {
  questions: InboxQuestion[];
  reviews: ReviewIssue[];
}

export type AttachmentKind = "link" | "file";

// Issue の添付。リンクは url、ファイルは fileName・size・mime を持つ（もう片方は null）
export interface IssueAttachment {
  id: number;
  kind: AttachmentKind;
  title: string | null; // 省くと null。表示はリンクならホスト名、ファイルならファイル名
  url: string | null;
  fileName: string | null;
  size: number | null; // バイト数
  mime: string | null;
  createdBy: string;
  createdAt: string;
}

export interface IssueDetail extends Issue {
  plan: Plan;
  documents: IssueDocumentRef[];
  attachments: IssueAttachment[];
  children: Issue[];
  relations: Relations;
  questions: Question[]; // 回答済みも含めたすべての確認依頼（未決事項）。id の順
  openQuestions: Question[];
  activity: ActivityItem[];
  subscribed: boolean; // me がこの Issue を購読しているか
  reminder: IssueReminder | null; // me が設定した、まだ届いていないリマインダー（#47）
}

export interface IssueReminder {
  remindAt: string; // UTC の ISO 8601
  note: string | null;
}

// まだ届いていないリマインダー（#47）
export interface Reminder extends IssueReminder {
  issueId: string;
  issueTitle: string;
  workspace: string;
  createdAt: string;
}

// Inbox の通知。kind は issue_change（購読中の Issue の変化）か agent（LLM に任せた Issue の完了・入力待ち・エラー。購読なしで me に届く）か
// reminder（me が設定したリマインダーの期限。data.note にメモ）
export interface Notification {
  id: number;
  kind: string;
  issueId: string;
  issueTitle: string;
  workspace: string;
  eventType: string;
  actor: string;
  data: Record<string, unknown>;
  body: string | null; // comment_added のときのコメント本文
  createdAt: string;
  readAt: string | null;
  snoozedUntil: string | null; // スヌーズ中なら期限（#43）
}

export interface SubscriptionState {
  issueId: string;
  subscribed: boolean;
}

export interface Template {
  id: number;
  name: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRules {
  workspaceKey: string;
  body: string;
  updatedAt: string;
  updatedBy: string;
}

// Triage の提案（#41）。決定的な規則で計算し、採用は人が既存の操作で行う
export type SuggestionReason =
  | { kind: "similar"; issues: string[] } // 類似 Issue の付与・担当の実績
  | { kind: "text"; field: "title" | "description" } // タイトル・本文にラベル名を含む
  | { kind: "source"; issue: string }; // 起票元 Issue の担当

export interface DuplicateSuggestion {
  id: string;
  workspace: string;
  title: string;
  status: Status;
  score: number; // 0〜1 の一致率
  sharedTerms: string[]; // 一致の根拠になった共通語（最大5件）
  via: string | null; // 重複になっている類似 Issue から元の Issue に寄せたとき、その類似 Issue の ID
}

export interface LabelSuggestion {
  label: string;
  reasons: SuggestionReason[];
}

export interface AssigneeSuggestion {
  assignee: string;
  reasons: SuggestionReason[];
}

export interface TriageSuggestions {
  issueId: string;
  duplicates: DuplicateSuggestion[];
  labels: LabelSuggestion[];
  assignees: AssigneeSuggestion[];
}

// LLM の Triage 提案（#62）。記録だけで Triage の状態は変えず、確定は人が行う
export const TRIAGE_DECISIONS = ["accept", "decline", "duplicate"] as const;
export type TriageDecision = (typeof TRIAGE_DECISIONS)[number];

export interface TriageProposalInput {
  decision: TriageDecision;
  duplicateOf?: string; // decision が duplicate のときだけ
  // 以下は decision が accept のときだけ
  labels?: string[]; // 付与を推奨するラベル
  assignee?: string;
  priority?: number;
  projectRef?: string;
  reason?: string;
}

export interface TriageProposal {
  issueId: string;
  actor: string;
  decision: TriageDecision;
  duplicateOf: string | null;
  labels: string[];
  assignee: string | null;
  priority: number | null;
  project: { id: number; name: string } | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

// PR 状態（#67）。gh pr view の結果を人・LLM の明示操作で取得して保存したもの
export const PR_STATES = ["OPEN", "CLOSED", "MERGED"] as const;
export type PrState = (typeof PR_STATES)[number];
export type PrReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";
export type PrCheckState = "success" | "failure" | "pending" | "skipped";

export interface PrCheck {
  name: string;
  state: PrCheckState;
  url: string | null;
}

export interface PrStatus {
  prUrl: string; // 取得した PR の URL
  number: number;
  title: string;
  state: PrState;
  isDraft: boolean;
  reviewDecision: PrReviewDecision | null; // null はレビュー必須でない（gh が空文字を返す）
  mergedAt: string | null;
  headSha: string | null; // 取得時点の HEAD のコミット（#55 の差分が古いかの判定に使う）。#55 より前に保存した結果は null
  checks: PrCheck[];
  checkSummary: Record<PrCheckState, number>;
  fetchedAt: string;
  fetchedBy: string;
}

export const PR_STATUS_ERROR_CODES = [
  "INVALID_URL",
  "GH_NOT_INSTALLED",
  "GH_AUTH",
  "PR_NOT_FOUND",
  "NETWORK",
  "TIMEOUT",
  "UNKNOWN",
] as const;
export type PrStatusErrorCode = (typeof PR_STATUS_ERROR_CODES)[number];

export interface PrStatusError {
  code: PrStatusErrorCode;
  message: string;
  at: string;
}

// Issue の現在の PR URL に対する最後の成功結果と最後の失敗。PR URL が変わった古い結果は含めない
export interface PrStatusView {
  issueId: string;
  prUrl: string | null;
  status: PrStatus | null;
  fetchError: PrStatusError | null; // CLI の --json の失敗（{"error": ...}）と取り違えないよう error とは呼ばない
}

// PR の差分（#55）。ファイルの状態は unified diff のヘッダーから決める
export type PrDiffFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface PrDiffFile {
  path: string; // 変更後のパス（削除は変更前のパス）
  oldPath: string | null; // 名前変更のときだけ変更前のパス
  status: PrDiffFileStatus;
  binary: boolean;
  additions: number;
  deletions: number;
  patch: string | null; // 最初の @@ からの unified diff。バイナリ・大きいファイルは null
  omitted: "binary" | "too_large" | null; // patch を持たない理由
}

export interface PrDiff {
  prUrl: string;
  headSha: string;
  baseSha: string;
  files: PrDiffFile[];
  additions: number;
  deletions: number;
  fetchedAt: string;
  fetchedBy: string;
}

export const PR_DIFF_ERROR_CODES = [...PR_STATUS_ERROR_CODES, "DIFF_TOO_LARGE"] as const;
export type PrDiffErrorCode = (typeof PR_DIFF_ERROR_CODES)[number];

export interface PrDiffError {
  code: PrDiffErrorCode;
  message: string;
  at: string;
}

// Issue の現在の PR URL に対する最後の差分と最後の失敗。
// PR 状態の取得で差分より新しい HEAD を知ったら、古い差分は返さず stale に両方の HEAD を入れる
export interface PrDiffView {
  issueId: string;
  prUrl: string | null;
  diff: PrDiff | null;
  stale: { diffHeadSha: string; currentHeadSha: string } | null;
  fetchError: PrDiffError | null;
}

export interface WorkspaceLabel {
  workspaceKey: string;
  name: string;
  color: string;
  description: string;
  issueCount: number;
  createdAt: string;
  updatedAt: string;
}

// Workspace ごとの自動化ルール（#71 自動クローズ・#72 自動アーカイブ）。日数が null ならそのルールは無効
export interface AutomationSettings {
  workspaceKey: string;
  closeAfterDays: number | null;
  archiveAfterDays: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export type AutomationKind = "auto_close" | "auto_archive";

export interface AutomationCandidate {
  id: string;
  title: string;
  status: Status;
  since: string; // 自動クローズは最後の活動、自動アーカイブは完了した日時
  elapsedDays: number;
}

export interface AutomationRuleResult {
  kind: AutomationKind;
  days: number | null;
  enabled: boolean;
  total: number; // 条件に合う件数（上限を超えた分も含む）
  candidates: AutomationCandidate[]; // 今回扱う分（上限まで、古い順）
  processed: string[]; // 実行で変更した Issue。dry-run では空
  skipped: string[]; // 実行時の再確認で条件から外れていて変えなかった Issue（targets にあって、いまは対象外のものを含む）
  failed: { id: string; message: string }[];
  remaining: number; // 条件に合うが今回扱わなかった件数（上限超過、または targets に含まれない分）
}

// 実行する Issue を確認時点の一覧に絞る（Web の確認ダイアログから）
export type AutomationTargets = Partial<Record<AutomationKind, string[]>>;

export interface AutomationRun {
  evaluatedAt: string;
  workspaceKey: string;
  dryRun: boolean;
  rules: AutomationRuleResult[];
}
