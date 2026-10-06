import { useMutation, useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { issuePath, queryKeys } from "../query-keys";
import type { GithubIssueState, GithubPublishPreview, GithubPublishResult, LeakFinding, WorkspaceGithubRepo, WorkspaceGithubRepoView } from "../types";
import { useApiMutation } from "./shared";

// nod の Issue の GitHub への作成。下見は gh を呼ぶので、ダイアログを開いたときにだけ実行する（query にしない）
export function useGithubState(id: string) {
  return useQuery({ queryKey: queryKeys.githubState(id), queryFn: () => apiFetch<GithubIssueState>(issuePath(id, "github")) });
}

export function useGithubPreview(id: string) {
  return useMutation({ mutationFn: () => apiFetch<GithubPublishPreview>(issuePath(id, "github/preview"), { method: "POST" }) });
}

// 編集のたびの再検査。gh は呼ばない
export function checkGithubText(id: string, input: { title: string; body: string }) {
  return apiFetch<{ findings: LeakFinding[] }>(issuePath(id, "github/check"), { method: "POST", body: input });
}

export function usePublishGithub(id: string) {
  return useApiMutation((input: { title: string; body: string; repo: string; ghLogin: string }) =>
    apiFetch<GithubPublishResult>(issuePath(id, "github/publish"), { method: "POST", body: input }),
  );
}

export function useClearGithubUnknown(id: string) {
  return useApiMutation(() => apiFetch<GithubIssueState>(issuePath(id, "github/clear-unknown"), { method: "POST" }));
}

export function useLinkGithub(id: string) {
  return useApiMutation((url: string) => apiFetch<GithubIssueState>(issuePath(id, "github/link"), { method: "POST", body: { url } }));
}

export function useUnlinkGithub(id: string) {
  return useApiMutation(() => apiFetch<GithubIssueState>(issuePath(id, "github/link"), { method: "DELETE" }));
}

const repoPath = (key: string) => `/workspaces/${encodeURIComponent(key)}/github-repo`;

export function useWorkspaceGithubRepo(key: string) {
  return useQuery({ queryKey: queryKeys.workspaceGithubRepo(key), queryFn: () => apiFetch<WorkspaceGithubRepoView>(repoPath(key)) });
}

export function useSetWorkspaceGithubRepo(key: string) {
  return useApiMutation((repo: string) => apiFetch<WorkspaceGithubRepo>(repoPath(key), { method: "PUT", body: { repo } }));
}

export function useClearWorkspaceGithubRepo(key: string) {
  return useApiMutation(() => apiFetch<WorkspaceGithubRepo>(repoPath(key), { method: "DELETE" }));
}

// 「Orca で作業を始める」で作られる worktree 名（hash を Web で計算しないため server に聞く）
export function useWorktreeName(id: string, feature: string) {
  return useQuery({
    queryKey: queryKeys.worktreeName(id, feature),
    queryFn: () => apiFetch<{ issueId: string; name: string }>(`${issuePath(id, "worktree-name")}?feature=${encodeURIComponent(feature)}`),
    enabled: feature !== "",
  });
}
