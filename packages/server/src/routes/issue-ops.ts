import {
  acceptTriage,
  attachDocument,
  DOC_KINDS,
  type DocKind,
  answerQuestion,
  approveReview,
  askQuestion,
  commentIssue,
  copyIssue,
  declineTriage,
  duplicateTriage,
  NodError,
  type OpCtx,
  rejectReview,
  resolveThread,
  STATUSES,
  type Status,
  snoozeTriage,
  subscribeIssue,
  unsubscribeIssue,
  type UpdateIssueInput,
  unlinkDocumentById,
  updateIssue,
} from "@nod/core";
import type { Hono } from "hono";
import { isAbsolute } from "node:path";
import {
  type Body,
  invalid,
  optInt,
  optNullableInt,
  optNullableString,
  optString,
  optStringArray,
  readBody,
  reqString,
} from "../input";

interface Op {
  keys: readonly string[];
  run: (me: OpCtx, ref: string, body: Body) => unknown;
  created?: boolean; // true なら 201 で返す
}

const UPDATE_KEYS = [
  "title",
  "description",
  "priority",
  "estimate",
  "dueDate",
  "status",
  "assignee",
  "parentRef",
  "projectRef",
  "addLabels",
  "removeLabels",
  "reason",
] as const;

function toUpdateInput(b: Body): UpdateIssueInput {
  const status = optString(b, "status");
  if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
    throw invalid(`ステータス「${status}」は使えません（使えるもの: ${STATUSES.join(", ")}）`);
  }
  return {
    title: optString(b, "title"),
    description: optNullableString(b, "description"),
    priority: optInt(b, "priority"),
    estimate: optNullableInt(b, "estimate"),
    dueDate: optNullableString(b, "dueDate"),
    status: status as Status | undefined,
    assignee: optNullableString(b, "assignee"),
    parentRef: optNullableString(b, "parentRef"),
    projectRef: optNullableString(b, "projectRef"),
    addLabels: optStringArray(b, "addLabels"),
    removeLabels: optStringArray(b, "removeLabels"),
    reason: optString(b, "reason"),
  };
}

const OPS: Record<string, Op> = {
  ask: { keys: ["question"], run: (me, ref, b) => askQuestion(me, ref, reqString(b, "question")) },
  answer: {
    keys: ["answer", "questionId"],
    run: (me, ref, b) => answerQuestion(me, ref, reqString(b, "answer"), { questionId: optInt(b, "questionId") }),
  },
  accept: {
    keys: ["projectRef", "priority", "addLabels", "removeLabels", "assignee"],
    run: (me, ref, b) => acceptTriage(me, ref, {
      projectRef: optNullableString(b, "projectRef"), priority: optInt(b, "priority"),
      addLabels: optStringArray(b, "addLabels"), removeLabels: optStringArray(b, "removeLabels"),
      assignee: optNullableString(b, "assignee"),
    }),
  },
  "doc-add": {
    keys: ["path", "title", "kind"], created: true,
    run: (me, ref, b) => {
      const path = reqString(b, "path");
      const kind = optString(b, "kind");
      if (!isAbsolute(path) || !/\.(md|markdown)$/i.test(path)) throw invalid("Markdownファイルの絶対パスを指定してください");
      if (kind !== undefined && !(DOC_KINDS as readonly string[]).includes(kind)) throw invalid("種類は spec / plan / doc を指定してください");
      return attachDocument(me, { issueRef: ref }, { path, title: optString(b, "title")?.trim() || undefined, kind: kind as DocKind | undefined });
    },
  },
  "doc-remove": {
    keys: ["documentId"],
    run: (me, ref, b) => {
      const documentId = optInt(b, "documentId");
      if (documentId === undefined || documentId < 1) throw invalid("documentId は正の整数で指定してください");
      unlinkDocumentById(me, documentId, { issueRef: ref });
      return { removed: documentId };
    },
  },
  decline: { keys: ["reason"], run: (me, ref, b) => declineTriage(me, ref, optString(b, "reason")) },
  duplicate: { keys: ["original"], run: (me, ref, b) => duplicateTriage(me, ref, reqString(b, "original")) },
  snooze: { keys: ["until"], run: (me, ref, b) => snoozeTriage(me, ref, reqString(b, "until")) },
  approve: { keys: [], run: (me, ref) => approveReview(me, ref) },
  reject: { keys: ["reason"], run: (me, ref, b) => rejectReview(me, ref, reqString(b, "reason")) },
  update: { keys: UPDATE_KEYS, run: (me, ref, b) => updateIssue(me, ref, toUpdateInput(b)) },
  copy: { keys: ["title"], run: (me, ref, b) => copyIssue(me, ref, { title: optString(b, "title") }), created: true },
  "resolve-thread": {
    keys: ["commentId", "resolved"],
    run: (me, ref, b) => {
      const commentId = optInt(b, "commentId");
      if (commentId === undefined) throw invalid("commentId を指定してください");
      if (typeof b.resolved !== "boolean") throw invalid("resolved は true か false で指定してください");
      return resolveThread(me, ref, commentId, b.resolved);
    },
  },
  comment: {
    keys: ["body", "parentId"], created: true,
    run: (me, ref, b) => commentIssue(me, ref, reqString(b, "body"), { replyTo: optInt(b, "parentId") }),
  },
  subscribe: { keys: [], run: (me, ref) => subscribeIssue(me, ref) },
  unsubscribe: { keys: [], run: (me, ref) => unsubscribeIssue(me, ref) },
};

// web からの Issue の操作。書き手は me
export function registerIssueOps(app: Hono, me: OpCtx): void {
  app.post("/api/issues/:id/:op", async (c) => {
    const name = c.req.param("op");
    // "constructor" などの Object のプロパティを操作として拾わないよう、自身のキーだけを見る
    const op = Object.hasOwn(OPS, name) ? OPS[name] : undefined;
    if (!op) {
      throw new NodError("NOT_FOUND", `操作 ${name} はありません（使えるもの: ${Object.keys(OPS).join(", ")}）`);
    }
    const body = await readBody(c, op.keys);
    return c.json(op.run(me, c.req.param("id"), body), op.created ? 201 : 200);
  });
}
