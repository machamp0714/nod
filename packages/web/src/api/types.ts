// web は core の型を import type だけで使う（spec の決定）。
// A の時点の写しを、C を取り込んで core が揃った H で再エクスポートに置き換えた。
// web のほかのファイルは、これまでどおりこのファイルから型を import する。足りない型は、この一覧に名前を足す。
export type {
  AcceptTriageInput,
  OrcaFailure,
  OrcaFailureCode,
  OrcaOpenResult,
  OrcaTerminal,
  AgentInstruction,
  AgentInstructionKind,
  AgentTargets,
  TriageSuggestions,
  TriageProposal,
  TriageDecision,
  DuplicateSuggestion,
  LabelSuggestion,
  AssigneeSuggestion,
  SuggestionReason,
  ReviewReport,
  ReviewIssue,
  IssueDocumentRef,
  ActivityItem,
  CompletionStats,
  Summary,
  SummaryItem,
  SummaryKind,
  SummarySection,
  CompletionBucket,
  LlmStats,
  LlmWorkload,
  LlmBucket,
  WorkTime,
  AgentState,
  AskResult,
  Comment,
  WorkLogKind,
  DocKind,
  DocumentContent,
  DocumentDetail,
  DocumentIssueLink,
  DocumentProjectLink,
  DocumentRef,
  DocumentSummary,
  Inbox,
  InboxQuestion,
  Issue,
  IssueCounts,
  IssueAttachment,
  IssueDeletion,
  IssueDetail,
  IssueList,
  IssueQuery,
  Notification,
  Reminder,
  IssueReminder,
  SubscriptionState,
  Plan,
  PlanStep,
  PrCheck,
  PrCheckState,
  PrReviewDecision,
  PrState,
  PrStatus,
  PrStatusError,
  PrStatusView,
  PrDiff,
  PrDiffError,
  PrDiffFileSummary,
  PrDiffErrorCode,
  PrDiffFile,
  PrDiffFileStatus,
  PrDiffView,
  PrDiffStale,
  PlanTask,
  Milestone,
  Project,
  ProjectDetail,
  ProjectHealth,
  ProjectStatus,
  ProjectSummary,
  ProjectUpdate,
  UpdateProjectInput,
  Initiative,
  InitiativeDetail,
  InitiativeStatus,
  InitiativeSummary,
  UpdateInitiativeInput,
  Cycle,
  CycleDetail,
  CycleState,
  CycleSummary,
  MoveOpenIssuesResult,
  Question,
  RelationType,
  Relations,
  Status,
  StepStatus,
  UpdateIssueInput,
  View,
  ViewInput,
  Workspace,
  WorkspaceLabel,
  AutomationSettings,
  AutomationKind,
  AutomationRecurringResult,
  AutoTransition,
  AutomationRuleResult,
  AutomationRun,
  AutomationTargets,
  RecurrenceCadence,
  RecurringIssue,
  RecurringRun,
  RecurringRunItem,
  Template,
  TransitionPreset,
  WorkspaceTransitionRules,
} from "@nod/core";

// Workspace の作業規約。未登録なら API は null を返す
export interface WorkspaceRules {
  workspaceKey: string;
  body: string;
  updatedAt: string;
  updatedBy: string;
}

// 定期Issueの登録・変更で API に送る本文（project は Project の名前）
export interface RecurringIssueInput {
  title: string;
  description: string | null;
  template: string | null;
  project: string | null;
  labels: string[];
  priority: number;
  assignee: string | null;
  cadence: import("@nod/core").RecurrenceCadence;
  weekday: number | null;
  monthDay: number | null;
  startDate: string;
  timeZone: string;
}
