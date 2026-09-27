import { useQuery } from "@tanstack/react-query";
import type { SidebarData } from "../../layout/useSidebarData";
import { workspaceNameOf } from "../../lib/decision";
import { type DecisionAction, fetchInbox, fetchTriage, postDecision } from "../decision";
import { queryKeys } from "../query-keys";
import { useApiMutation, useWorkspaces } from "./shared";

// queryFn は引数を取らない形で包む。TanStack Query が渡す文脈を fetchImpl として受けないためである
export function useInbox() {
  return useQuery({ queryKey: queryKeys.inbox(), queryFn: () => fetchInbox() });
}

export function useTriage() {
  return useQuery({ queryKey: queryKeys.triage(), queryFn: () => fetchTriage() });
}

export function useWorkspaceName(): (key: string) => string {
  const { data } = useWorkspaces();
  return (key) => workspaceNameOf(data, key);
}

export function useDecisionCounts(): SidebarData["counts"] {
  const inbox = useInbox();
  const triage = useTriage();
  return {
    inbox: inbox.data?.questions.length ?? 0,
    reviews: inbox.data?.reviews.length ?? 0,
    triage: triage.data?.length ?? 0,
  };
}

// 判断の操作。書き込みの後の無効化（成功でも失敗でもすべてのクエリ）は H の useApiMutation が行う
export function useDecision() {
  return useApiMutation((action: DecisionAction) => postDecision(action));
}
