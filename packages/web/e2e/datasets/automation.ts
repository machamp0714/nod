import { createIssue, findIssueRow, initWorkspace, type OpCtx, updateIssue } from "@nod/core";
import type { Dataset } from "../support/dataset";

const DAY_MS = 86_400_000;

// 自動化（#71・#72）の画面用。時刻は実行時の現在からさかのぼって書くので、経過日数は毎回同じになる
const dataset: Dataset = ({ db, repo }) => {
  const me: OpCtx = { db, actor: "me" };
  const codex: OpCtx = { db, actor: "codex" };
  const api = initWorkspace(db, { path: repo("api-server"), key: "API", name: "api-server" }).workspace;
  const nod = initWorkspace(db, { path: repo("nod"), key: "NOD", name: "nod" }).workspace;
  // status と、作成・更新・完了・event の時刻を days 日前にする
  const age = (id: string, status: string, days: number) => {
    const at = new Date(Date.now() - days * DAY_MS).toISOString();
    const row = findIssueRow(db, id);
    const closedAt = status === "done" || status === "canceled" ? at : null;
    db.query("UPDATE issues SET status = ?, created_at = ?, updated_at = ?, closed_at = ? WHERE id = ?").run(status, at, at, closedAt, row.id);
    db.query("UPDATE events SET created_at = ? WHERE issue_id = ?").run(at, row.id);
  };
  age(createIssue(me, { workspaceId: api.id, title: "放置された調査" }).id, "todo", 45); // API-1
  age(createIssue(me, { workspaceId: api.id, title: "古い下書き" }).id, "backlog", 40); // API-2
  createIssue(me, { workspaceId: api.id, title: "最近の作業" }); // API-3
  const released = createIssue(me, { workspaceId: api.id, title: "リリース済みの修正" }); // API-4
  updateIssue(me, released.id, { status: "done" });
  age(released.id, "done", 20);
  age(createIssue(codex, { workspaceId: api.id, title: "LLM が起票した古い Triage" }).id, "triage", 60); // API-5
  age(createIssue(me, { workspaceId: nod.id, title: "別 Workspace の放置" }).id, "todo", 90); // NOD-1
};
export default dataset;
