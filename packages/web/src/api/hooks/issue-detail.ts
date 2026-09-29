import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { issuePath, queryKeys } from "../query-keys";
import type { DocKind, DocumentRef, AskResult, IssueAttachment, Comment, Issue, ProjectSummary, Question, UpdateIssueInput } from "../types";
import { useApiMutation, useWorkspaces } from "./shared";

// Issue 詳細の取得は H の useIssueDetail（hooks/shared.ts）を使う

export function useWorkspaceName(key: string): string {
  const { data } = useWorkspaces();
  return data?.find((w) => w.key === key)?.name ?? key;
}

// プロパティの Project の選択肢。完了と中止の Project に付いた Issue もあるため、閉じた Project も含める
export function useProjectChoices(): { id: number; name: string }[] {
  const { data } = useProjectChoicesQuery();
  return (data ?? []).map((p) => ({ id: p.id, name: p.name }));
}

export function useProjectChoicesQuery() {
  return useQuery({
    queryKey: queryKeys.projectList({ includeClosed: true }),
    queryFn: () => apiFetch<ProjectSummary[]>("/projects?includeClosed=true"),
  });
}

// 操作の後の読み直しは useApiMutation が行う（成否によらずすべてのクエリを無効にし、読み直しを待って解決する）
function useIssueOperation<TBody, TResult>(id: string, operation: string) {
  return useApiMutation((body: TBody) => apiFetch<TResult>(issuePath(id, operation), { method: "POST", body }));
}

export const useUpdateIssue = (id: string) => useIssueOperation<UpdateIssueInput, Issue>(id, "update");
export const useApproveReview = (id: string) => useIssueOperation<Record<string, never>, Issue>(id, "approve");
export const useAskQuestion = (id: string) => useIssueOperation<{ question: string }, AskResult>(id, "ask");
export const useAnswerQuestion = (id: string) =>
  useIssueOperation<{ answer: string; questionId?: number }, { issue: Issue; answered: Question[] }>(id, "answer");
export const useCopyIssue = (id: string) => useIssueOperation<{ title?: string }, Issue>(id, "copy");
export const useArchiveIssue = (id: string) => useIssueOperation<{ reason?: string }, Issue>(id, "archive");
export const useUnarchiveIssue = (id: string) => useIssueOperation<Record<string, never>, Issue>(id, "unarchive");
export const useCommentIssue = (id: string) => useIssueOperation<{ body: string; parentId?: number }, Comment>(id, "comment");
export const useResolveThread = (id: string) =>
  useIssueOperation<{ commentId: number; resolved: boolean }, Comment>(id, "resolve-thread");

export const useAttachDocument = (id: string) => useIssueOperation<{ path: string; title?: string; kind?: DocKind }, DocumentRef>(id, "doc-add");
export const useRemoveDocument = (id: string) => useIssueOperation<{ documentId: number }, { removed: number }>(id, "doc-remove");

// 添付。web から足せるのはリンクだけ（ファイルは CLI の nod issue attach add --file）
export const useAddAttachmentLink = (id: string) =>
  useApiMutation((body: { url: string; title?: string }) =>
    apiFetch<IssueAttachment>(issuePath(id, "attachments"), { method: "POST", body }));
export const useRemoveAttachment = (id: string) =>
  useApiMutation((attachmentId: number) =>
    apiFetch<{ removed: number }>(issuePath(id, `attachments/${attachmentId}`), { method: "DELETE" }));
