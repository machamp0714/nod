import type { DocumentRef } from "../api/types";

export const DOCUMENTS: DocumentRef[] = [
  { id: 1, path: "/Users/me/repo/api-server/docs/specs/2026-09-20-search-performance.md", title: "検索 API の高速化 設計", kind: "spec" },
  { id: 2, path: "/Users/me/repo/api-server/docs/plans/2026-09-27-search-n1.md", title: "検索 API の N+1 解消 実装計画", kind: "plan" },
  { id: 3, path: "/Users/me/repo/nod/docs/specs/2026-09-27-nod-design.md", title: "nod 設計", kind: "spec" },
];

// 本文。null はファイルが見つからない Document を表す。
export const DOCUMENT_BODIES: Record<number, string | null> = {
  1: "# 検索 API の高速化 設計\n\n## 目的\n\n/search の p95 を 200ms 以下にする。\n\n## 方針\n\n- 結果ごとの workspace の取得をまとめる\n- (workspace_id, created_at) の複合インデックスを足す",
  2: "# 検索 API の N+1 解消 実装計画\n\n### Task 1: 調査\n\n### Task 2: インデックス設計\n\n### Task 3: 実装\n\n### Task 4: 計測",
  3: null,
};

export const PROJECT_DOCUMENTS: Record<number, number[]> = { 1: [1], 3: [3] };

export const ISSUE_DOCUMENTS: Record<string, number[]> = { "API-12": [1, 2] };

export function findDocument(id: number): DocumentRef | undefined {
  return DOCUMENTS.find((d) => d.id === id);
}
