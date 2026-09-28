import type { IssueDetail, Workspace } from "../src/api/types";
import type { NodClient, NodData } from "./support/nod";

export interface IssueRef {
  id: string;
  title: string;
}

export interface ApiWorkspace {
  workspace: Workspace;
  repo: string; // Workspace の path で、着手した Issue の実行場所（ワークツリー）にも使う
  // 私が起票し（todo）、LLM が着手した Issue（in_progress、実行場所は main）
  startedIssue(title: string, actor?: NodClient): Promise<IssueRef>;
  ask(id: string, question: string, actor?: NodClient): Promise<unknown>;
  // LLM が着手し、報告を残してレビューに回した Issue（in_review）
  inReview(title: string, summary: string, prUrl?: string): Promise<IssueRef>;
  // LLM が起票した Issue（triage）
  triageIssue(title: string, description?: string, actor?: NodClient): Promise<IssueRef>;
  show(id: string): Promise<IssueDetail>;
}

// Workspace API（api-server）を登録する。H の fixtures が各テストの前に DB を空にするため、テストの先頭で1回呼ぶ
export async function seedApiWorkspace(nod: NodData): Promise<ApiWorkspace> {
  const repo = nod.repo("api-server");
  const { workspace } = await nod.me.initWorkspace({ path: repo, key: "API", name: "api-server" });
  const startedIssue = async (title: string, actor: NodClient = nod.claude): Promise<IssueRef> => {
    const created = await nod.me.createIssue({ workspaceId: workspace.id, title });
    await actor.startIssue(created.id, { location: { branch: "main", worktree: repo } });
    return { id: created.id, title };
  };
  return {
    workspace,
    repo,
    startedIssue,
    ask: (id, question, actor = nod.claude) => actor.askQuestion(id, question),
    inReview: async (title, summary, prUrl) => {
      const issue = await startedIssue(title);
      await nod.claude.completeIssue(issue.id, { summary, prUrl });
      return issue;
    },
    triageIssue: async (title, description, actor = nod.claude) => {
      const created = await actor.createIssue({ workspaceId: workspace.id, title, description });
      return { id: created.id, title };
    },
    show: (id) => nod.me.getIssue(id),
  };
}
