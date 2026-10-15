import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createIssue, listNotifications, setReminder, subscribeIssue, commentIssue, archiveIssue, deleteIssue, deleteNotifications, restoreNotifications, unarchiveIssue } from "@nod/core";
import { setup } from "./helpers";
afterEach(() => setSystemTime());
test("設定と原子的取得をAPI経由で使い、正常表示のackは指定通知だけ既読にする", async () => {
  setSystemTime(new Date("2026-10-15T00:00:00Z"));
  const { app, db, me, ws } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "API通知" });
  subscribeIssue(me, issue.id);
  commentIssue({ ...me, actor: "codex" }, issue.id, "他の通知");
  const post = (path: string, body: unknown) => app.request(`/api/desktop-notifications/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect((await post("settings", { enabled: true })).status).toBe(200);
  setReminder(me, issue.id, { at: "2026-10-15T00:00:01Z" });
  setSystemTime(new Date("2026-10-15T00:00:01Z"));
  const response = await post("claim", { permission: "granted" });
  expect(response.status).toBe(200);
  const [item] = await response.json();
  expect(item.issueId).toBe(issue.id);
  expect((await post("opened", { issueId: issue.id, notificationId: item.notificationId })).status).toBe(200);
  expect(listNotifications(db).map(n => n.kind)).toEqual(["issue_change"]);
});
test("別Issueの通知IDでは既読にせず、存在しないIssueの表示失敗でも通知を残す", async () => {
  const { app, db, me, ws } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "対象" });
  const another = createIssue(me, { workspaceId: ws.id, title: "別" });
  subscribeIssue(me, issue.id);
  commentIssue({ ...me, actor: "codex" }, issue.id, "残す通知");
  const notification = listNotifications(db)[0]!;
  const opened = (issueId: string) => app.request("/api/desktop-notifications/opened", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ issueId, notificationId: notification.id }) });
  expect((await opened(another.id)).status).toBe(400);
  expect((await opened("API-999")).status).toBe(404);
  expect(listNotifications(db)).toHaveLength(1);
});

test("永久削除の案内を表示した通知は、Issue消失の再確認後だけ遷移完了とし、別通知を既読にしない", async () => {
  setSystemTime(new Date("2026-10-15T00:00:00Z"));
  const { app, db, me, ws } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "削除先" });
  const keep = createIssue(me, { workspaceId: ws.id, title: "残すIssue" });
  subscribeIssue(me, keep.id);
  commentIssue({ ...me, actor: "codex" }, keep.id, "未読のまま残す");
  setReminder(me, issue.id, { at: "2026-10-15T00:00:01Z" });
  setSystemTime(new Date("2026-10-15T00:00:01Z"));
  const notification = listNotifications(db).find(n => n.issueId === issue.id)!;
  const opened = (missing: boolean) => app.request("/api/desktop-notifications/opened", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ issueId: issue.id, notificationId: notification.id, missing }) });
  expect((await opened(true)).status).toBe(400);
  expect(listNotifications(db)).toHaveLength(2);
  archiveIssue(me, issue.id);
  deleteIssue(me, issue.id);
  expect((await app.request(`/api/issues/${issue.id}`)).status).toBe(404);
  expect((await opened(false)).status).toBe(404);
  expect((await opened(true)).status).toBe(200);
  expect(listNotifications(db).map(n => n.issueId)).toEqual([keep.id]);
});

for (const target of ["アーカイブ済みIssue", "削除済み通知"] as const) test(`${target}のクリックでもIssueを参照し、当該以外の未読を維持する`, async () => {
  setSystemTime(new Date("2026-10-15T00:00:00Z"));
  const { app, db, me, ws } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "参照するIssue" });
  subscribeIssue(me, issue.id);
  commentIssue({ ...me, actor: "codex" }, issue.id, "残すコメント通知");
  setReminder(me, issue.id, { at: "2026-10-15T00:00:01Z" });
  setSystemTime(new Date("2026-10-15T00:00:01Z"));
  const notification = listNotifications(db).find(n => n.kind === "reminder")!;
  if (target === "アーカイブ済みIssue") archiveIssue(me, issue.id);
  else deleteNotifications(me, { ids: [notification.id] });
  const detail = await app.request(`/api/issues/${issue.id}`);
  expect(detail.status).toBe(200);
  expect((await detail.json()).archivedAt !== null).toBe(target === "アーカイブ済みIssue");
  const response = await app.request("/api/desktop-notifications/opened", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ issueId: issue.id, notificationId: notification.id }) });
  expect(response.status).toBe(200);
  if (target === "アーカイブ済みIssue") {
    unarchiveIssue(me, issue.id);
    expect(listNotifications(db).map(n => n.kind)).toEqual(["issue_change"]);
  } else {
    restoreNotifications(me, { ids: [notification.id] });
    expect(listNotifications(db).map(n => n.kind)).toEqual(["reminder", "issue_change"]);
  }
});
