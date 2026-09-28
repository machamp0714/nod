import { createIssue, initWorkspace, startIssue } from "@nod/core";
import type { Dataset } from "../support/dataset";

// e2e の土台のテスト（harness.e2e.ts）が使うデータ。Workspace 1つと、LLM が着手した Issue 1つだけを持つ
const dataset: Dataset = ({ db, repo }) => {
  const { workspace } = initWorkspace(db, { path: repo("api-server"), key: "API", name: "api-server" });
  const issue = createIssue({ db, actor: "me" }, { workspaceId: workspace.id, title: "土台の確認に使う Issue" });
  startIssue({ db, actor: "claude-code" }, issue.id);
};

export default dataset;
