// e2e のテストから呼べる core の関数。e2e の server（Bun）とテスト（Node）の両方が import するため、ほかのモジュールを import しない。
// 足りない関数があれば、core の関数の名前をここに足す。

// 第1引数に OpCtx（{ db, actor }）を取る操作。書き手はテストが選ぶ
export const CTX_OPS = [
  "createIssue",
  "updateIssue",
  "commentIssue",
  "relateIssue",
  "startIssue",
  "askQuestion",
  "failIssue",
  "completeIssue",
  "answerQuestion",
  "acceptTriage",
  "declineTriage",
  "duplicateTriage",
  "snoozeTriage",
  "approveReview",
  "rejectReview",
  "createProject",
  "updateProject",
  "attachDocument",
  "detachDocument",
  "createDocument",
  "linkDocumentById",
  "unlinkDocumentById",
  "importPlan",
  "setPlanTasks",
  "setStep",
  "subscribeIssue",
  "unsubscribeIssue",
  "markNotificationsRead",
] as const;

// 第1引数に Database を取る操作
export const DB_OPS = [
  "initWorkspace",
  "removeWorkspace",
  "listWorkspaces",
  "getIssue",
  "queryIssues",
  "getInbox",
  "listTriage",
  "listProjects",
  "getProject",
  "getDocument",
  "listDocuments",
  "readDocument",
  "listViews",
  "createView",
  "updateView",
  "deleteView",
  "listNotifications",
] as const;

export type CtxOp = (typeof CTX_OPS)[number];
export type DbOp = (typeof DB_OPS)[number];
