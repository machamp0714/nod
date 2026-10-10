import type { WorkLogKind } from "./work-log";

// 「Orca で作業を始める」（#210）で起動できるエージェント。値は orca worktree create の --agent にそのまま渡す
export const ORCA_AGENTS = ["claude", "codex"] as const;
export type OrcaAgent = (typeof ORCA_AGENTS)[number];
export const ORCA_AGENT_LABELS: Record<OrcaAgent, string> = { claude: "Claude Code", codex: "Codex" };

export interface Workspace {
  id: number;
  key: string;
  name: string;
  path: string;
  color: string;
  specAssessmentEnabled?: boolean;
  defaultAgent: OrcaAgent; // 「Orca で作業を始める」の既定のエージェント
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

export interface SpecAssessment {
  status: "pending" | "completed" | "failed";
  generation: number;
  bodyHash: string;
  model: string;
  criteriaVersion: string;
  threshold: number;
  requestedAt: string;
  finishedAt: string | null;
  probability: number | null;
  inputTokens: number | null;
  elapsedMs: number | null;
  failureKind: import("./ops/jev-client").JevFailureKind | null;
}

export interface Issue {
  specAssessment?: SpecAssessment | null;
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
  milestone: { id: number; name: string } | null; // 同じ Project の中間目標。Project を変えると外れる
  cycle: { id: number; name: string } | null; // 所属する Cycle。未設定は null
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

// Project の健全性。進捗報告に添えて人・LLM が設定する
export const PROJECT_HEALTHS = ["on_track", "at_risk", "off_track"] as const;
export type ProjectHealth = (typeof PROJECT_HEALTHS)[number];
// 進捗報告で健全性を未設定に戻すときの値（#154）
export const PROJECT_HEALTH_CLEAR = "none";

export interface ProjectSummary extends Project {
  health: ProjectHealth | null; // 健全性つきの最新の進捗報告の値。なければ null
  total: number;
  done: number;
  agents: { working: number; awaitingInput: number; awaitingReview: number; error: number };
}

// Project の進捗報告。追記のみで、Issue・Project の状態には連動しない
export interface ProjectUpdate {
  id: number;
  projectId: number;
  author: string;
  body: string;
  health: ProjectHealth | null;
  healthCleared: boolean; // true ならこの報告で健全性を未設定に戻した（health は null）
  createdAt: string;
}

// Project の中間目標。total・done は Project の進捗と同じ定義（canceled とアーカイブ済みを除く総数、done の数）
export interface Milestone {
  id: number;
  projectId: number;
  name: string;
  targetDate: string | null; // 時刻なしの暦日 YYYY-MM-DD
  description: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  total: number;
  done: number;
}

export interface ProjectDetail extends ProjectSummary {
  milestones: Milestone[]; // 目標日の早い順（未設定は最後、同じなら id 順）
  issues: Issue[];
  documents: DocumentRef[];
  updates: ProjectUpdate[]; // 新しい順（同じ時刻は id の大きい順）
  initiatives: { id: number; name: string }[]; // 所属する Initiative（名前順）
}

// 上位目標（#81）。状態は Project と同じ4値で、Project・Issue の状態には連動しない
export const INITIATIVE_STATUSES = PROJECT_STATUSES;
export type InitiativeStatus = ProjectStatus;

export interface Initiative {
  id: number;
  name: string;
  description: string | null;
  targetDate: string | null; // 目標日（時刻なしの暦日 YYYY-MM-DD）。未設定は null
  status: InitiativeStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// 進捗は配下 Project の Issue を Project と同じ定義（total は canceled・アーカイブ以外、done は done）で合算する
export interface InitiativeSummary extends Initiative {
  projectCount: number;
  total: number;
  done: number;
}

export interface InitiativeDetail extends InitiativeSummary {
  projects: ProjectSummary[]; // 名前順
}

// 期間（#82・NOD-2）。全体で1系列で、期間は時刻なしの暦日（両端を含む）。状態は保存せず、今日の暦日から求める
export const CYCLE_STATES = ["upcoming", "current", "completed"] as const;
export type CycleState = (typeof CYCLE_STATES)[number];

export interface Cycle {
  id: number;
  name: string;
  startDate: string;
  endDate: string;
  state: CycleState;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// 進捗は Project と同じ定義（total は canceled・アーカイブ以外、done は done）。open は未完了（total - done）
export interface CycleSummary extends Cycle {
  total: number;
  done: number;
  open: number;
}

export interface CycleDetail extends CycleSummary {
  issues: Issue[]; // アーカイブ以外
  memberCount: number; // 所属する Issue の件数（アーカイブ・canceled も含む）。削除で Cycle なしに戻る件数
}

// 内訳の1行。担当なしは key "" ・label "担当なし"、Project なしは key "" ・label "Project なし"
export interface CycleBreakdownRow {
  key: string;
  label: string;
  total: number;
  done: number;
}

// Cycle の分析（Linear の Cycle の右パネル）。started は done を含まない（Web が Completed の上に積む）
export interface CycleAnalytics {
  cycleId: number;
  scope: number;
  started: number;
  completed: number;
  startedRate: number | null;
  completedRate: number | null;
  scopeAdded: number;
  burnup: { date: string; scope: number; started: number; completed: number }[];
  breakdown: { assignees: CycleBreakdownRow[]; labels: CycleBreakdownRow[]; projects: CycleBreakdownRow[]; workspaces: CycleBreakdownRow[] };
  statuses: { status: Status; count: number }[];
}

export interface UpdateInitiativeInput {
  name?: string;
  description?: string | null; // null で解除
  targetDate?: string | null; // null で解除
  status?: InitiativeStatus;
}

export interface DocumentRef {
  id: number;
  path: string;
  title: string;
  kind: DocKind;
}

export interface DocumentContent extends DocumentRef {
  content: string | null; // ファイルが見つからない、または読めないときは null
  mtime: number | null; // ファイルの更新時刻（statSync().mtimeMs）。保存時の競合の検知に使う。ファイルがなければ null
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
      instruction?: AgentInstruction; // LLM への追加指示・対応依頼のコメント（#51・#58）。それ以外のコメントには無い
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

// 関係の相手の状態。数えないブロック元（完了・キャンセル・アーカイブ済み）を表示で見分けるために返す（#176）
export interface RelationState {
  status: Status;
  archived: boolean;
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
  cycleRef?: string | null; // Cycle の ID・名前・current。null で外す
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

// まだ再提出していない、直近の差し戻し（#177）。delegate は対応依頼つきの差し戻しの種類
export interface ReviewRejection {
  reason: string;
  actor: string;
  at: string;
  delegate: "review_fix" | "rebase" | null;
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
  relationStates: Record<string, RelationState>; // relations に出る Issue の ID ごとの状態
  questions: Question[]; // 回答済みも含めたすべての確認依頼（未決事項）。id の順
  openQuestions: Question[];
  activity: ActivityItem[];
  subscribed: boolean; // me がこの Issue を購読しているか
  reminder: IssueReminder | null; // me が設定した、まだ届いていないリマインダー（#47）
  pendingInstructions: AgentInstruction[]; // LLM がまだ受け取っていない追加指示・対応依頼（#51・#58）。id の順
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
// reminder（me が設定したリマインダーの期限。data.note にメモ）か triage_proposal（LLM の Triage 提案。data.decision・data.duplicateOf、#125）
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
  autoTransition?: AutoTransition | null; // 更新（refresh）でステータスを進めたとき、その記録。表示だけのときは付けない
  autoTransitionSkipped?: string; // PR 連動の条件を満たしたが、遷移ルール（#73）で進めなかったときの理由
}

// GitHub の番号の参照（#12 など）を nod の Issue に解決できなかった理由
export type GitSyncRefMissReason = "no_origin" | "unparsable" | "other_host" | "repo_not_set" | "repo_mismatch" | "not_linked";

// nod git sync（#68）の候補。同じ Issue を書いたコミットが複数あれば最新のもの
export interface GitSyncCandidate {
  id: string;
  title: string;
  status: Status;
  sha: string;
  subject: string;
  keyword: string; // メッセージに書かれたキーワード（Closes・fixes など）
  ref?: string; // GitHub の番号の参照で解決したとき、その原文（#12 など）
  committedAt: string;
  ruleSkipReason?: string; // 遷移ルール（#73）で実行時にスキップする見込みのとき、その理由
}

export interface GitSyncResult {
  workspaceKey: string;
  ref: string;
  sinceDays: number;
  dryRun: boolean;
  enabled: boolean; // Workspace でコミット連動が有効か（無効でも dry-run はできる）
  scanned: number; // 読んだコミット数
  truncated: boolean; // 読む上限に達した（それより古いコミットは読んでいない）
  total: number;
  candidates: GitSyncCandidate[];
  processed: string[];
  skipped: string[];
  skippedReasons: { id: string; message: string }[]; // skipped のうち理由のあるもの（遷移ルール #73 で止めたもの）
  failed: { id: string; message: string }[];
  remaining: number;
  unresolvedRefs: { sha: string; ref: string; reason: GitSyncRefMissReason }[]; // 解決しなかった GitHub の番号の参照
}

// PR・コミットによる自動のステータス遷移（#66・#68）の記録。同じ Issue・同じ PR/コミットでは一度だけ遷移させる
export type AutoTransitionSource = "pr" | "commit";

export interface AutoTransition {
  id: number;
  issueId: string;
  source: AutoTransitionSource;
  sourceKey: string; // PR URL またはコミット SHA
  from: Status;
  to: Status;
  mergeCandidate: boolean; // PR がマージ済み（done にはせず、完了候補として人の承認を待つ）
  actor: string;
  createdAt: string;
  revertedAt: string | null;
  revertedBy: string | null;
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

// 一覧に出すファイルの要約。patch は GET /api/issues/:id/pr-diff/files・nod issue pr-diff --file でファイルごとに読む
export type PrDiffFileSummary = Omit<PrDiffFile, "patch">;

export interface PrDiff {
  prUrl: string;
  headSha: string;
  baseSha: string;
  files: PrDiffFileSummary[];
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

// HEAD が変わった古い差分の要約。ファイルと本文は返さない
export interface PrDiffStale {
  diffHeadSha: string;
  currentHeadSha: string;
  files: number;
  additions: number;
  deletions: number;
  fetchedAt: string;
}

// Issue の現在の PR URL に対する最後の差分と最後の失敗。
// PR 状態の取得で差分より新しい HEAD を知ったら、古い差分は返さず stale に両方の HEAD と要約を入れる
export interface PrDiffView {
  issueId: string;
  prUrl: string | null;
  diff: PrDiff | null;
  stale: PrDiffStale | null;
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
  prReview: boolean; // PR が open（draft 以外）かマージ済みになったら in_progress を in_review にする（#66）
  commitReview: boolean; // nod git sync でコミットメッセージの Closes/Fixes <ID> を読み、Issue を in_review にする（#68）
  updatedAt: string | null;
  updatedBy: string | null;
}

export type AutomationKind = "auto_close" | "auto_archive" | "pr_review";

export interface AutomationCandidate {
  id: string;
  title: string;
  status: Status;
  since: string; // 自動クローズは最後の活動、自動アーカイブは完了した日時、PR 連動は PR 状態を取得した日時
  elapsedDays: number;
  prUrl?: string; // PR 連動のときだけ
  prState?: PrState;
  ruleSkipReason?: string; // 遷移ルール（#73）で実行時にスキップする見込みのとき、その理由
}

export interface AutomationRuleResult {
  kind: AutomationKind;
  days: number | null;
  enabled: boolean;
  total: number; // 条件に合う件数（上限を超えた分も含む）
  candidates: AutomationCandidate[]; // 今回扱う分（上限まで、古い順）
  processed: string[]; // 実行で変更した Issue。dry-run では空
  skipped: string[]; // 実行時の再確認で条件から外れていて変えなかった Issue（targets にあって、いまは対象外のものを含む）
  skippedReasons: { id: string; message: string }[]; // skipped のうち理由のあるもの（遷移ルール #73 で止めたもの）
  failed: { id: string; message: string }[];
  remaining: number; // 条件に合うが今回扱わなかった件数（上限超過、または targets に含まれない分）
}

// 実行する Issue を確認時点の一覧に絞る（Web の確認ダイアログから）。recurring は定期Issue（#32）の id と確認時点の発生日
export type AutomationTargets = Partial<Record<AutomationKind, string[]>> & { recurring?: AutomationRecurringTarget[] };

export interface AutomationRecurringTarget {
  recurringId: number;
  occurrence: string; // 確認時点の発生日（YYYY-MM-DD）。実行時の発生日と違えば起票しない
}

// 自動化の実行に含めた定期Issueの起票（#32）
export interface AutomationRecurringResult {
  enabled: number; // 有効な定期Issueの数
  items: RecurringRunItem[]; // 起票する（した）もの。dry-run では issueId が null
  // targets にあって、実行時には起票しなかった定期Issue（確認後に発生日が変わった・起票済み・停止中・削除済み）と理由
  notRun: { recurringId: number; reason: string }[];
  failed: RecurringRun["failed"];
}

export interface AutomationRun {
  evaluatedAt: string;
  workspaceKey: string;
  dryRun: boolean;
  rules: AutomationRuleResult[];
  recurring: AutomationRecurringResult;
}

// 定期Issue（#32）の周期。weekly は weekday（0 = 日曜 〜 6 = 土曜）、monthly は monthDay（1〜31。その日が無い月は月末）を使う
export const RECURRENCE_CADENCES = ["daily", "weekly", "monthly"] as const;
export type RecurrenceCadence = (typeof RECURRENCE_CADENCES)[number];

export interface RecurringIssue {
  id: number;
  workspaceKey: string;
  title: string;
  description: string | null;
  template: string | null; // テンプレートの名前。本文は起票するときに解決する
  project: string | null;
  labels: string[];
  priority: number;
  assignee: string | null;
  cadence: RecurrenceCadence;
  weekday: number | null;
  monthDay: number | null;
  startDate: string; // YYYY-MM-DD（timeZone の暦日）
  timeZone: string; // IANA の名前
  enabled: boolean;
  lastOccurrence: string | null; // 最後に起票した発生日
  lastIssueId: string | null;
  nextOccurrence: string | null; // 次の実行で起票する発生日。未起票の過去の発生日があればその最新日、無ければ今日以降の次の発生日。停止中は null
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface RecurringRunItem {
  recurringId: number;
  title: string;
  occurrence: string; // 起票する（した）発生日
  skipped: number; // 前回から間が空いて、起票せずに飛ばした発生日の数
  issueId: string | null; // dry-run では null
}

export interface RecurringRun {
  workspaceKey: string;
  dryRun: boolean;
  evaluatedAt: string;
  items: RecurringRunItem[];
  failed: { recurringId: number; title: string; occurrence: string; message: string }[];
}

// Orca との連携（#52 Orca で開く、#51 追加指示の送信）が失敗した理由
export type OrcaFailureCode =
  | "DISABLED" // NOD_ORCA=0
  | "NO_WORKTREE" // Issue に実行場所の worktree が記録されていない
  | "WORKTREE_ALREADY_RECORDED" // Issue に実行場所の worktree かブランチが記録済み（#210 二重作成の防止）
  | "WORKTREE_CREATING" // 同じ Issue の worktree を別の要求が作成中（#210 二重作成の防止）
  | "WORKTREE_NOT_RECORDED" // worktree は作られたが、orca を待つ間に Issue がアーカイブされて記録できなかった（#210）
  | "ORCA_NOT_INSTALLED"
  | "WORKTREE_NOT_IN_ORCA" // orca が selector_not_found を返した
  | "NO_TERMINAL" // worktree に端末がない
  | "TERMINAL_NOT_FOUND" // 選んだ端末が消えた・別の worktree の端末
  | "TIMEOUT"
  | "ORCA_ERROR";

export interface OrcaFailure {
  code: OrcaFailureCode;
  message: string;
}

// orca terminal list の1件
export interface OrcaTerminal {
  handle: string;
  title: string;
  agentIdentity: string | null; // claude・codex など。LLM が動いていない端末は null
  worktreePath: string | null;
  live: boolean; // 接続中・書き込み可・orphaned でない
}

// 「Orca で開く」の結果。開けなかったときは、手で開くためのパスと cd コマンドを返す
export interface OrcaOpenResult {
  issueId: string;
  opened: boolean;
  worktree: string | null;
  copyCommand: string | null;
  terminal: OrcaTerminal | null;
  failure: OrcaFailure | null;
}

// 「Orca で作業を始める」（#210）の結果。作れなかったときは created が false で、worktree・branch は Issue に記録済みの値のまま
export interface OrcaWorktreeResult {
  issueId: string;
  created: boolean;
  worktree: string | null;
  branch: string | null;
  failure: OrcaFailure | null;
}

// LLM への追加指示（#51）と差し戻しの対応依頼（#58）の種類
export const AGENT_INSTRUCTION_KINDS = ["instruction", "review_fix", "rebase"] as const;
export type AgentInstructionKind = (typeof AGENT_INSTRUCTION_KINDS)[number];
// 送信状態。unconfirmed は orca が時間切れなどで、端末に届いたか分からない状態
export type AgentInstructionSendState = "unsent" | "sending" | "sent" | "unconfirmed" | "failed";

export interface AgentInstruction {
  id: number;
  issueId: string;
  commentId: number; // 本文は Activity のコメントとしても残る
  kind: AgentInstructionKind;
  body: string;
  createdBy: string;
  createdAt: string;
  sendState: AgentInstructionSendState;
  sentAt: string | null;
  sentBy: string | null;
  sentTerminal: string | null; // 送った（送ろうとした）Orca の端末の handle
  sentAgent: string | null; // 送った端末の agentIdentity（claude など）
  sendError: OrcaFailure | null; // failed・unconfirmed の理由
  acknowledgedAt: string | null; // LLM が nod issue start で受け取った日時
  acknowledgedBy: string | null;
}

// 追加指示の送信先の候補（#51）。terminals はその worktree で稼働中の LLM の端末だけ。
// failure があれば一覧できなかった理由で、そのときは記録だけ行い、LLM は nod issue start / show で読む
export interface AgentTargets {
  issueId: string;
  worktree: string | null;
  terminals: OrcaTerminal[];
  failure: OrcaFailure | null;
}

// Cycle の周期。全体で1つ。nextNumber は次に自動で付ける `Cycle {N}` の N
export interface CycleCadence {
  weeks: number;
  autoCarryOver: boolean;
  anchorDate: string; // Cycle が1つもないときの最初の開始日
  nextNumber: number;
  updatedBy: string;
  updatedAt: string;
}
