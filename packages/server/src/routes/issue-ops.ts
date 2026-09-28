import {
  acceptTriage,
  answerQuestion,
  approveReview,
  askQuestion,
  commentIssue,
  declineTriage,
  duplicateTriage,
  NodError,
  type OpCtx,
  rejectReview,
  STATUSES,
  type Status,
  snoozeTriage,
  type UpdateIssueInput,
  updateIssue,
} from "@nod/core";
import type { Hono } from "hono";
import {
  type Body,
  invalid,
  optInt,
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
  accept: { keys: [], run: (me, ref) => acceptTriage(me, ref) },
  decline: { keys: ["reason"], run: (me, ref, b) => declineTriage(me, ref, optString(b, "reason")) },
  duplicate: { keys: ["original"], run: (me, ref, b) => duplicateTriage(me, ref, reqString(b, "original")) },
  snooze: { keys: ["until"], run: (me, ref, b) => snoozeTriage(me, ref, reqString(b, "until")) },
  approve: { keys: [], run: (me, ref) => approveReview(me, ref) },
  reject: { keys: ["reason"], run: (me, ref, b) => rejectReview(me, ref, reqString(b, "reason")) },
  update: { keys: UPDATE_KEYS, run: (me, ref, b) => updateIssue(me, ref, toUpdateInput(b)) },
  comment: { keys: ["body"], run: (me, ref, b) => commentIssue(me, ref, reqString(b, "body")), created: true },
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
