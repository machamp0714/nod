import { useQuery } from "@tanstack/react-query";
import type { SidebarData } from "../../layout/useSidebarData";
import { workspaceNameOf } from "../../lib/decision";
import { type DecisionAction, fetchInbox, fetchTriage, fetchTriageProposalCounts, fetchTriageProposals, fetchTriageSuggestions, postDecision } from "../decision";
import { queryKeys } from "../query-keys";
import { useApiMutation, useWorkspaces } from "./shared";

// queryFn は引数を取らない形で包む。TanStack Query が渡す文脈を fetchImpl として受けないためである
export function useInbox(opts: { includeAnswered?: boolean } = {}) {
  return useQuery({ queryKey: opts.includeAnswered ? queryKeys.inboxHistory() : queryKeys.inbox(), queryFn: () => fetchInbox(undefined, opts) });
}

export function useTriage() {
  return useQuery({ queryKey: queryKeys.triage(), queryFn: () => fetchTriage() });
}

// 判断を送ったあとは Issue が Triage から外れ、取り直すと NOT_IN_TRIAGE になるため、enabled で止める
export function useTriageSuggestions(id: string, enabled = true) {
  return useQuery({ queryKey: queryKeys.triageSuggestions(id), queryFn: () => fetchTriageSuggestions(id), enabled });
}

// LLM の提案（#62）。人の確定後も残るが、Triage から外れた Issue は画面に出ないので候補と同じく判断後は止める
export function useTriageProposals(id: string, enabled = true) {
  return useQuery({ queryKey: queryKeys.triageProposals(id), queryFn: () => fetchTriageProposals(id), enabled });
}

// Triage 一覧のバッジ（#125）
export function useTriageProposalCounts() {
  return useQuery({ queryKey: queryKeys.triageProposalCounts(), queryFn: () => fetchTriageProposalCounts() });
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
