import { expect, test } from "bun:test";
import { getIssueBranchName, createIssue, updateIssue } from "../src/ops/issues";
import { startIssue } from "../src/ops/agent";
import { initWorkspace } from "../src/ops/workspaces";
import { codeOf, setup } from "./helpers";

test("Issue IDだけから有効で決定的な名前を生成し、記録済みの場所やDBを変えない", () => {
  const { db, ws, me, llm } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "日本語🚀 / .. @{ [ ~ ^ : ? * \\" });
  startIssue(llm, issue.id, { location: { branch: "existing/work", worktree: "/tmp/existing" } });
  const before = db.serialize();
  const expected = { issueId: issue.id, suggestedBranch: `nod/${issue.id.toLowerCase()}` };
  expect(getIssueBranchName(db, issue.id)).toEqual(expected);
  expect(getIssueBranchName(db, issue.id.toLowerCase())).toEqual(expected);
  expect(db.serialize()).toEqual(before);
  expect(Bun.spawnSync(["git", "check-ref-format", "--branch", expected.suggestedBranch]).exitCode).toBe(0);
  updateIssue(me, issue.id, { title: "名前を変更" });
  expect(getIssueBranchName(db, issue.id)).toEqual(expected);
  const other = initWorkspace(db, { path: "/tmp/repos/other", key: "OTHER" }).workspace;
  const elsewhere = createIssue(me, { workspaceId: other.id, title: "別Workspace" });
  expect(getIssueBranchName(db, elsewhere.id).suggestedBranch).toBe("nod/other-1");
  expect(codeOf(() => getIssueBranchName(db, "../bad"))).toBe("INVALID_ARGS");
  expect(codeOf(() => getIssueBranchName(db, "API-99999"))).toBe("NOT_FOUND");
});
