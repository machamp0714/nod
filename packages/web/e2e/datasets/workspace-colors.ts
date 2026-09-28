import { askQuestion, completeIssue, createIssue, createProject, createView, initWorkspace, startIssue, type OpCtx } from "@nod/core";
import type { Dataset } from "../support/dataset";

const dataset: Dataset = ({ db, repo }) => {
  const me: OpCtx = { db, actor: "me" };
  const codex: OpCtx = { db, actor: "codex" };
  const project = createProject(me, { name: "色の横断検証" });
  for (const key of ["API", "WEB", "NOD", "BLOG"]) {
    const workspace = initWorkspace(db, { path: repo(key), key, name: `${key}のリポジトリ` }).workspace;
    const input = { workspaceId: workspace.id, projectRef: String(project.id) };
    createIssue(me, { ...input, title: `${key} 通常課題` });
    createIssue(codex, { ...input, title: `${key} Triage課題` });
    const question = createIssue(me, { ...input, title: `${key} 回答待ち課題` });
    startIssue(codex, question.id);
    askQuestion(codex, question.id, "どの方式を使いますか");
    const review = createIssue(me, { ...input, title: `${key} レビュー課題` });
    startIssue(codex, review.id);
    completeIssue(codex, review.id, { summary: `${key} の実装を完了しました` });
  }
  createView(db, { name: "色の一覧", color: "#7C5CFF", filter: {} });
};
export default dataset;
