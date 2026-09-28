import { expect, test } from "bun:test";
import { completeIssue, startIssue } from "../src/ops/agent";
import { createIssue, getIssue } from "../src/ops/issues";
import { rejectReview } from "../src/ops/human";
import { codeOf, eventsOf, setup } from "./helpers";

test("完了の遷移は同じtxで作った報告comment IDを記録し、再完了でも更新する", () => {
  const { db, ws, me, llm } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "報告" });
  startIssue(llm, issue.id);
  completeIssue(llm, issue.id, { summary: "一回目" });
  const reports = () => eventsOf(db, issue.id).filter(e => e.type === "status_changed" && e.data.to === "in_review");
  const first = reports()[0].data.report_comment_id;
  expect(db.query("SELECT body FROM comments WHERE id = ?").get(first ?? -1)).toEqual({ body: "一回目" });
  rejectReview(me, issue.id, "修正して");
  completeIssue(llm, issue.id, { summary: "二回目" });
  const last = reports().at(-1)!.data.report_comment_id;
  expect(last).not.toBe(first);
  expect(db.query("SELECT body FROM comments WHERE id = ?").get(last ?? -1)).toEqual({ body: "二回目" });
  db.close();
});

test("起票元と親は別に記録し、不正参照なら採番もeventも増えない", () => {
  const { db, ws, me, llm } = setup();
  const parent = createIssue(me, { workspaceId: ws.id, title: "親" });
  const source = createIssue(me, { workspaceId: ws.id, title: "起票元" });
  const before = db.query("SELECT next_number FROM workspaces WHERE id = ?").get(ws.id);
  const count = db.query("SELECT count(*) AS n FROM events").get();
  expect(codeOf(() => createIssue(llm, { workspaceId: ws.id, title: "失敗", discoveredFromRef: "API-999" }))).toBe("NOT_FOUND");
  expect(db.query("SELECT next_number FROM workspaces WHERE id = ?").get(ws.id)).toEqual(before);
  expect(db.query("SELECT count(*) AS n FROM events").get()).toEqual(count);
  const child = createIssue(llm, { workspaceId: ws.id, title: "発見", parentRef: parent.id, discoveredFromRef: source.id.toLowerCase() });
  expect(getIssue(db, child.id).parentId).toBe(parent.id);
  expect(eventsOf(db, child.id)[0].data).toEqual({ status: "triage", discovered_from: source.id });
  expect(eventsOf(db, parent.id)[0].data).toEqual({ status: "todo" });
  expect(codeOf(() => createIssue(llm, { workspaceId: ws.id, title: "空", discoveredFromRef: " " }))).toBe("INVALID_ARGS");
  db.close();
});
