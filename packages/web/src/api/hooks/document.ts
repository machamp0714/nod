import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "../query-keys";
import type { DocumentContent } from "../types";

// spec：web が表示のたびにファイルを読む。server は登録済みの Document のパスだけを読む
export function useDocument(id: number | null) {
  return useQuery({
    // id が null のときは enabled で止めるため、キーの 0 は取得に使われない
    queryKey: queryKeys.document(id ?? 0),
    queryFn: () => apiFetch<DocumentContent>(`/documents/${id}`),
    enabled: id !== null,
  });
}
