import type { DocumentRef, IssueDetail, Plan, Relations } from "../api/types";
import { activityOf } from "./activity";
import { findDocument, ISSUE_DOCUMENTS } from "./documents";
import { findIssue, ISSUES, questionsOf } from "./issues";

const EMPTY_RELATIONS: Relations = { blocks: [], blockedBy: [], related: [], duplicateOf: [], duplicates: [] };

const PLANS: Record<string, Plan> = {
  "API-12": {
    source: "/Users/me/repo/api-server/docs/plans/2026-09-27-search-n1.md",
    tasks: [
      {
        title: "調査",
        status: "done",
        steps: [
          { title: "遅いクエリを洗い出す", status: "done" },
          { title: "N+1 の箇所を特定する", status: "done" },
        ],
      },
      {
        title: "インデックス設計",
        status: "doing",
        steps: [
          { title: "既存のインデックスを洗い出す", status: "done" },
          { title: "複合インデックスの案を作る", status: "doing" },
          { title: "移行の手順を書く", status: "pending" },
        ],
      },
      {
        title: "実装",
        status: "pending",
        steps: [
          { title: "取得を1回のクエリにまとめる", status: "pending" },
          { title: "インデックスを足すマイグレーションを書く", status: "pending" },
        ],
      },
      { title: "計測", status: "pending", steps: [{ title: "ステージングのダンプで p95 を測る", status: "pending" }] },
    ],
  },
};

const RELATIONS: Record<string, Relations> = {
  "API-12": { ...EMPTY_RELATIONS, blocks: ["API-13"], related: ["API-9"] },
  "API-13": { ...EMPTY_RELATIONS, blockedBy: ["API-12"] },
  "API-9": { ...EMPTY_RELATIONS, related: ["API-12"] },
};

// GET /api/issues/:id の応答のダミー。G で API に置き換える。
export function issueDetail(id: string): IssueDetail | undefined {
  const issue = findIssue(id);
  if (!issue) return undefined;
  const questions = questionsOf(id);
  return {
    ...issue,
    plan: PLANS[id] ?? { source: null, tasks: [] },
    documents: (ISSUE_DOCUMENTS[id] ?? []).map((docId) => findDocument(docId)).filter((d): d is DocumentRef => d !== undefined),
    children: ISSUES.filter((i) => i.parentId === id),
    relations: RELATIONS[id] ?? EMPTY_RELATIONS,
    openQuestions: questions.filter((q) => q.answer === null),
    questions,
    activity: activityOf(id),
  };
}
