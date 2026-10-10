import type { OpCtx } from "../ctx";
import { copyIssue } from "./issues";
import { runRecurringIssues } from "./recurring";
import { runAutomation } from "./automation";
import { assessCreatedIssue } from "./spec-assessment";
import { jevClient, type JevClient } from "./jev-client";

// 一括起票の外部要求は最大2件。保存済みIssueの失敗は他の起票へ波及させない。
export async function assessCreatedIssues(ctx: OpCtx, refs: string[], client: JevClient = jevClient): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(2, refs.length) }, async () => {
    while (next < refs.length) await assessCreatedIssue(ctx, refs[next++]!, client);
  }));
}

export async function copyIssueWithAssessment(ctx: OpCtx, ref: string, opts: Parameters<typeof copyIssue>[2] = {}, client: JevClient = jevClient) {
  const issue = copyIssue(ctx, ref, opts);
  return assessCreatedIssue(ctx, issue.id, client);
}

export async function runRecurringIssuesWithAssessment(ctx: OpCtx, key: string, opts: Parameters<typeof runRecurringIssues>[2] = {}, client: JevClient = jevClient) {
  const result = runRecurringIssues(ctx, key, opts);
  if (!result.dryRun) await assessCreatedIssues(ctx, result.items.flatMap(i => i.issueId ? [i.issueId] : []), client);
  return result;
}

export async function runAutomationWithAssessment(ctx: OpCtx, key: string, opts: Parameters<typeof runAutomation>[2] = {}, client: JevClient = jevClient) {
  const result = runAutomation(ctx, key, opts);
  if (!result.dryRun) await assessCreatedIssues(ctx, result.recurring.items.flatMap(i => i.issueId ? [i.issueId] : []), client);
  return result;
}
