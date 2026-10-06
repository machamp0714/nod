import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "../client";
import { queryKeys } from "../query-keys";
import type { DocKind, DocumentDetail, DocumentRef, DocumentSummary } from "../types";
import { useApiMutation } from "./shared";

// spec：web が表示のたびにファイルを読む。server は登録済みの Document のパスだけを読む
export function useDocument(id: number | null) {
  return useQuery({
    // id が null のときは enabled で止めるため、キーの 0 は取得に使われない
    queryKey: queryKeys.document(id ?? 0),
    queryFn: () => apiFetch<DocumentDetail>(`/documents/${id}`),
    enabled: id !== null,
  });
}

export function useDocuments() {
  return useQuery({ queryKey: queryKeys.documentList(), queryFn: () => apiFetch<DocumentSummary[]>("/documents") });
}

export interface CreateDocumentInput {
  path: string; // Documents ディレクトリからの相対パス
  title?: string;
  kind?: DocKind;
  body?: string;
  issueRefs?: string[];
}

export const useCreateDocument = () =>
  useApiMutation((body: CreateDocumentInput) => apiFetch<DocumentRef>("/documents", { method: "POST", body }));

export const useLinkDocument = (id: number) =>
  useApiMutation((body: { issueRef: string }) => apiFetch<DocumentDetail>(`/documents/${id}/link`, { method: "POST", body }));

export const useUnlinkDocument = (id: number) =>
  useApiMutation((body: { issueRef: string }) => apiFetch<DocumentDetail>(`/documents/${id}/unlink`, { method: "POST", body }));

// 本文の保存。useApiMutation は終わるたびに全 query を無効にして Document を読み直すため使わない。
// 返った詳細をそのまま入れ、タイトルが変わりうる一覧だけを読み直す
export function useUpdateDocumentContent(id: number) {
  const queryClient = useQueryClient();
  return useMutation<DocumentDetail, Error, { content: string; mtime: number }>({
    mutationFn: (body) => apiFetch<DocumentDetail>(`/documents/${id}/content`, { method: "PUT", body }),
    onSuccess: (doc) => {
      queryClient.setQueryData(queryKeys.document(id), doc);
      void queryClient.invalidateQueries({ queryKey: queryKeys.documentList() });
    },
  });
}

// 本文に貼る画像のアップロード。apiFetch は JSON 専用なので FormData で直接送る。失敗の読み方は apiFetch と同じ
export async function uploadDocumentAsset(id: number, file: File, pasted: boolean): Promise<{ path: string }> {
  const form = new FormData();
  form.append("file", file);
  if (pasted) form.append("pasted", "1");
  const res = await fetch(`/api/documents/${id}/assets`, { method: "POST", body: form });
  const body = (await res.json().catch(() => null)) as { path?: string; error?: { code?: string; message?: string } } | null;
  if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? "HTTP_ERROR", body?.error?.message ?? `HTTP ${res.status}`);
  return body as { path: string };
}

export function useDocumentsRoot() {
  return useQuery({ queryKey: queryKeys.documentsRoot(), queryFn: () => apiFetch<{ docsDir: string }>("/documents/root"), staleTime: Infinity });
}
