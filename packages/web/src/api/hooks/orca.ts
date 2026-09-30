import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { issuePath } from "../query-keys";
import type { OrcaOpenResult } from "../types";

// 記録済みの worktree を Orca で前面に出す（#52）。DB を変えないので読み直しはしない。
// 開けなかった理由は HTTP の失敗ではなく結果の failure で返る
export function useOpenInOrca(id: string) {
  return useMutation<OrcaOpenResult, Error, void>({
    mutationFn: () => apiFetch<OrcaOpenResult>(issuePath(id, "orca-open"), { method: "POST" }),
  });
}
