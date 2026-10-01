import { describe, expect, test } from "bun:test";
import { askQuestion, completeIssue, failIssue, startIssue } from "../src/ops/agent";
import { answerQuestion, approveReview, rejectReview } from "../src/ops/human";
import { createIssue, getIssue, listIssues, queryIssues, updateIssue } from "../src/ops/issues";
import { issueQueryFromParams, validateIssueQuery } from "../src/issue-filter";
import { createView, getView } from "../src/ops/views";
import { eventsOf, setup } from "./helpers";

function started() {
  const s = setup();
  const llm = { db: s.db, actor: "codex" };
  const issue = createIssue(s.me, { workspaceId: s.ws.id, title: "対象" });
  startIssue(llm, issue.id, { location: { branch: "test", worktree: "/tmp/test" } });
  return { ...s, llm, id: issue.id };
}

describe("手動遷移の作業状況", () => {
  for (const state of ["working", "awaiting_input", "error"] as const) {
    for (const status of ["triage", "backlog", "todo", "in_review", "done", "canceled"] as const) {
      test(`${state} から ${status} で解除する`, () => {
        const { db, me, llm, id } = started();
        if (state === "awaiting_input") askQuestion(llm, id, "確認");
        if (state === "error") failIssue(llm, id, "失敗");
        const before = getIssue(db, id);
        const result = updateIssue(me, id, { status });
        expect(result.agentState).toBeNull();
        // 未回答の確認依頼が残っていても、手動の移動では needs_clarification にしない（#170）
        expect(result.status).toBe(status);
        expect([result.assignee, result.branch, result.worktree, result.startedAt]).toEqual([before.assignee, before.branch, before.worktree, before.startedAt]);
        expect(eventsOf(db, id).filter(e => e.type === "agent_state_changed").at(-1)?.data).toMatchObject({ from: state, to: null });
        db.close();
      });
    }
  }
  test("同じ状態・プロパティ変更は保持し、解除を重複記録しない", () => {
    const { db, me, id } = started();
    expect(updateIssue(me, id, { title: "変更" }).agentState).toBe("working");
    expect(updateIssue(me, id, { status: "in_progress" }).agentState).toBe("working");
    updateIssue(me, id, { status: "todo" });
    const count = eventsOf(db, id).length;
    updateIssue(me, id, { status: "todo" });
    expect(eventsOf(db, id)).toHaveLength(count);
    db.close();
  });
  test("レビューのdoneを保持し、再開はnullにする", () => {
    const { db, me, llm, id } = started();
    completeIssue(llm, id, { summary: "完了" });
    expect(updateIssue(me, id, { status: "in_review" }).agentState).toBe("done");
    expect(updateIssue(me, id, { status: "done" }).agentState).toBe("done");
    expect(updateIssue(me, id, { status: "in_review" }).agentState).toBe("done");
    expect(approveReview(me, id).agentState).toBe("done");
    updateIssue(me, id, { status: "in_review" });
    expect(rejectReview(me, id, "再確認").agentState).toBeNull();
    completeIssue(llm, id, { summary: "完了" });
    expect(updateIssue(me, id, { status: "in_progress" }).agentState).toBeNull();
    db.close();
  });
  test("Todo移動後の未決事項への回答でworkingへ戻さない", () => {
    const { db, me, llm, id } = started();
    askQuestion(llm, id, "確認");
    expect(updateIssue(me, id, { status: "todo" }).status).toBe("todo");
    expect(answerQuestion(me, id, "回答").issue).toMatchObject({ status: "todo", agentState: null });
    db.close();
  });
});

describe("説明を含む文字列検索", () => {
  test("qを正規化し、Viewに保持する", () => {
    expect(validateIssueQuery({ q: " users " })).toEqual({ q: "users" });
    expect(validateIssueQuery({ q: "  " })).toEqual({});
    for (const q of [null, 3, ["users"]]) expect(() => validateIssueQuery({ q })).toThrow();
    expect(issueQueryFromParams(new URLSearchParams("q=before&q=users"))).toEqual({ q: "users" });
    const { db } = setup();
    const view = createView(db, { name: "検索", filter: { q: "users" } });
    expect(getView(db, view.id).filter).toEqual({ q: "users" });
    db.close();
  });
  test("日本語、非ASCII大小文字、SQL記号を文字通り検索しcountsへ反映する", () => {
    const { db, me, ws } = setup();
    const target = createIssue(me, { workspaceId: ws.id, title: "対象", description: "Users 日本語 ÉCOLE % _ ' \\" });
    createIssue(me, { workspaceId: ws.id, title: "無関係" });
    for (const q of ["users", " 日本語 ", "école", "%", "_", "'", "\\", "api-1"]) {
      expect(listIssues(db, { query: q }).map(i => i.id)).toEqual([target.id]);
      const result = queryIssues(db, { q });
      expect(result.issues.map(i => i.id)).toEqual([target.id]);
      expect(result.counts).toEqual({ ready: 1, needsClarification: 0 });
    }
    expect(listIssues(db, { query: "  " })).toHaveLength(2);
    expect(queryIssues(db, { q: "users", workspace: ["NONE"] }).issues).toEqual([]);
    updateIssue(me, target.id, { status: "done" });
    expect(listIssues(db, { query: "users" })).toEqual([]);
    expect(queryIssues(db, { q: "users" }).issues).toHaveLength(1);
    expect(queryIssues(db, { q: "users", ready: true }).issues).toEqual([]);
    db.close();
  });
});

describe("ブロック元とFilter", () => {
  test("falseを保持し不正値を拒否する", () => {
    expect(validateIssueQuery({blocked:false})).toEqual({blocked:false});
    expect(issueQueryFromParams(new URLSearchParams("blocked=0"))).toEqual({blocked:false});
    expect(issueQueryFromParams(new URLSearchParams("blocked=1"))).toEqual({blocked:true});
    expect(() => issueQueryFromParams(new URLSearchParams("blocked=no"))).toThrow();
    expect(() => validateIssueQuery({blocked:"false"})).toThrow();
  });
  test("別Workspaceの複数元を並べ完了と再オープンを反映する", async () => {
    const { relateIssue } = await import("../src/ops/issues");
    const { initWorkspace } = await import("../src/ops/workspaces");
    const {db,me,ws}=setup();
    const web=initWorkspace(db,{path:"/tmp/other-web",key:"WEB"}).workspace;
    const target=createIssue(me,{workspaceId:ws.id,title:"対象"});
    const b=createIssue(me,{workspaceId:web.id,title:"依存"});
    const a=createIssue(me,{workspaceId:ws.id,title:"依存"});
    const other=createIssue(me,{workspaceId:ws.id,title:"関連"});
    relateIssue(me,b.id,{blocks:target.id}); relateIssue(me,a.id,{blocks:target.id});
    relateIssue(me,other.id,{related:target.id});
    expect(getIssue(db,target.id).blockedBy).toEqual([a.id,b.id]);
    expect(getIssue(db,a.id).blockedBy).toEqual([]);
    expect(queryIssues(db,{blocked:true}).issues.map(i=>i.id)).toEqual([target.id]);
    expect(queryIssues(db,{blocked:true}).counts.ready).toBe(0);
    expect(queryIssues(db,{blocked:true,ready:true}).issues).toEqual([]);
    expect(queryIssues(db,{blocked:false}).issues.map(i=>i.id)).not.toContain(target.id);
    updateIssue(me,a.id,{status:"done"});
    expect(getIssue(db,target.id).blockedBy).toEqual([b.id]);
    updateIssue(me,b.id,{status:"canceled"});
    expect(getIssue(db,target.id).blockedBy).toEqual([]);
    expect(queryIssues(db,{ready:true}).issues.map(i=>i.id)).toContain(target.id);
    updateIssue(me,b.id,{status:"todo"});
    expect(queryIssues(db,{blocked:true,q:"対象"}).issues.map(i=>i.id)).toEqual([target.id]);
    const view=createView(db,{name:"ブロックなし",filter:{blocked:false}});
    expect(getView(db,view.id).filter).toEqual({blocked:false});
    db.close();
  });
});

test("検索は既存のworkspace/project/label/status条件とANDになり件数はstatusに依存しない", async () => {
  const {createProject}=await import("../src/ops/projects");
  const {db,ws,me}=setup();
  const project=createProject(me,{name:"対象Project"});
  const issue=createIssue(me,{workspaceId:ws.id,title:"Users",labels:["検索"],projectRef:String(project.id)});
  createIssue(me,{workspaceId:ws.id,title:"Users 対象外"});
  const q={q:"users",project:String(project.id),label:["検索"],workspace:[ws.key]};
  expect(queryIssues(db,q).issues.map(i=>i.id)).toEqual([issue.id]);
  expect(queryIssues(db,{...q,status:["done"]})).toEqual({issues:[],counts:{ready:1,needsClarification:0}});
  expect(queryIssues(db,{...q,label:["別"]}).counts.ready).toBe(0);
  db.close();
});
