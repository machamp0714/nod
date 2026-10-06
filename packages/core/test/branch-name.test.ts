import { expect, test } from "bun:test";
import { issueHash, slugOf } from "../src/branch-naming";
import { findIssueRow } from "../src/issue-query";
import { startIssue } from "../src/ops/agent";
import { setWorkspaceGithubRepo } from "../src/ops/github-repo";
import { createIssue, getIssueBranchName, updateIssue } from "../src/ops/issues";
import { initWorkspace } from "../src/ops/workspaces";
import { codeOf, setup } from "./helpers";

test("slug は NFKC・小文字・英数字の語を - でつなぎ、40 文字まで。nod の ID に当たる部分は除く", () => {
  expect(slugOf("Fix Search N+1", ["API"])).toBe("fix-search-n-1");
  expect(slugOf("ＡＢＣ　テスト 123", ["API"])).toBe("abc-123");
  expect(slugOf("API-12 と NOD-4 の続き fix", ["API", "NOD"])).toBe("fix");
  expect(slugOf("日本語だけ", ["API"])).toBe("");
  expect(slugOf("a".repeat(39) + " bc", [])).toBe("a".repeat(39));
  expect(slugOf("x".repeat(50), []).length).toBe(40);
});

test("hash はキーと番号から決まる 8 桁", () => {
  expect(issueHash("api", 1)).toBe("a67fefb7");
  expect(issueHash("OTHER", 1)).toBe("ac3366a7");
});

test("未公開は <slug>-<hash>、slug がなければ hash だけ。DB と記録済みの場所を変えない", () => {
  const { db, ws, me, llm } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "日本語🚀 / .. @{ [ ~ ^ : ? * \\" });
  startIssue(llm, issue.id, { location: { branch: "existing/work", worktree: "/tmp/existing" } });
  const before = db.serialize();
  expect(getIssueBranchName(db, issue.id)).toEqual({ issueId: issue.id, suggestedBranch: "a67fefb7" });
  expect(getIssueBranchName(db, issue.id.toLowerCase()).suggestedBranch).toBe("a67fefb7");
  expect(db.serialize()).toEqual(before);
  updateIssue(me, issue.id, { title: "Fix search" });
  const named = getIssueBranchName(db, issue.id).suggestedBranch;
  expect(named).toBe("fix-search-a67fefb7");
  expect(Bun.spawnSync(["git", "check-ref-format", "--branch", named]).exitCode).toBe(0);
  const other = initWorkspace(db, { path: "/tmp/repos/other", key: "OTHER" }).workspace;
  const elsewhere = createIssue(me, { workspaceId: other.id, title: "別Workspace" });
  expect(getIssueBranchName(db, elsewhere.id).suggestedBranch).toBe("workspace-ac3366a7");
  expect(codeOf(() => getIssueBranchName(db, "../bad"))).toBe("INVALID_ARGS");
  expect(codeOf(() => getIssueBranchName(db, "API-99999"))).toBe("NOT_FOUND");
});

test("公開済み（今の公開先の対応がある）なら issue-<N>-<slug>。公開先が違う対応では使わない", () => {
  const { db, ws, me } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "Fix search" });
  const row = findIssueRow(db, issue.id);
  db.query("INSERT INTO issue_imports (workspace_id, source, source_key, issue_id, imported_by, imported_at, origin) VALUES (?, 'github', 'example/api-server#12', ?, 'me', 'x', 'publish')").run(ws.id, row.id);
  expect(getIssueBranchName(db, issue.id).suggestedBranch).toBe("fix-search-a67fefb7");
  setWorkspaceGithubRepo(me, "API", "example/api-server");
  expect(getIssueBranchName(db, issue.id).suggestedBranch).toBe("issue-12-fix-search");
  updateIssue(me, issue.id, { title: "日本語" });
  expect(getIssueBranchName(db, issue.id).suggestedBranch).toBe("issue-12");
});
