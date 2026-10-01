import { useMutation, useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { issuePath } from "../query-keys";
import type { AgentInstruction, AgentTargets, OrcaAgent, OrcaOpenResult, OrcaWorktreeResult, Workspace } from "../types";
import { useApiMutation } from "./shared";

// 記録済みの worktree を Orca で前面に出す（#52）。DB を変えないので読み直しはしない。
// 開けなかった理由は HTTP の失敗ではなく結果の failure で返る
export function useOpenInOrca(id: string) {
  return useMutation<OrcaOpenResult, Error, void>({
    mutationFn: () => apiFetch<OrcaOpenResult>(issuePath(id, "orca-open"), { method: "POST" }),
  });
}

// Orca に worktree を作ってエージェントを起動する（#210）。成功すると Issue に実行場所が記録されるため、終わったら読み直す。
// 作れなかった理由は HTTP の失敗ではなく結果の failure で返る
export function useCreateOrcaWorktree(id: string) {
  return useApiMutation((input: { feature: string; agent: OrcaAgent }) =>
    apiFetch<OrcaWorktreeResult>(issuePath(id, "orca-worktree"), { method: "POST", body: input }),
  );
}

// 「Orca で作業を始める」の既定のエージェントを Workspace に保存する（#210）
export function useSaveDefaultAgent(key: string) {
  return useApiMutation((agent: OrcaAgent) =>
    apiFetch<Workspace>(`/workspaces/${encodeURIComponent(key)}/default-agent`, { method: "PUT", body: { agent } }),
  );
}

// 追加指示の送信先の候補（#51）。確認画面を開くたびに orca で1回だけ調べ、古い一覧を使い回さない
export function useAgentTargets(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ["agent-targets", id],
    queryFn: () => apiFetch<AgentTargets>(issuePath(id, "agent-targets")),
    enabled,
    // 開いている間は、ほかの書き込みによる無効化やフォーカスで orca を呼び直さない（閉じると捨て、次に開くときに調べ直す）
    meta: { immutable: true },
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useRecordInstruction(id: string) {
  return useApiMutation((body: string) =>
    apiFetch<AgentInstruction>(issuePath(id, "instructions"), { method: "POST", body: { body } }),
  );
}

// 送信は確認画面の「送信」からだけ呼ぶ（自動送信はしない）
export function useSendInstruction(id: string) {
  return useApiMutation((input: { instructionId: number; terminal: string; confirmResend?: boolean }) =>
    apiFetch<AgentInstruction>(issuePath(id, `instructions/${input.instructionId}/send`), {
      method: "POST",
      body: { terminal: input.terminal, ...(input.confirmResend ? { confirmResend: true } : {}) },
    }),
  );
}
