import type { Page } from "@playwright/test";
import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";

// OSクリック後のWebView境界。IPCのみ代替し、実画面・HTTP・DBで表示と既読範囲を確かめる。
async function installDesktopClick(page: Page, issueId: string, notificationId: number) {
  await page.addInitScript(({ issueId, notificationId }) => {
    const state = window as unknown as {
      __NOD_DESKTOP__: boolean;
      __TAURI_INTERNALS__: { invoke(command: string, args: { issueId: string; missing?: boolean }): Promise<unknown> };
      __notificationHandled: boolean;
    };
    state.__NOD_DESKTOP__ = true;
    state.__notificationHandled = false;
    state.__TAURI_INTERNALS__ = {
      async invoke(command, args) {
        if (command !== "notification_opened" || args.issueId !== issueId) throw new Error("想定外の通知IPCです");
        const response = await fetch("/api/desktop-notifications/opened", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...args, notificationId }),
        });
        if (!response.ok) throw new Error("通知の表示完了を保存できませんでした");
        state.__notificationHandled = true;
        return response.json();
      },
    };
  }, { issueId, notificationId });
}

async function expectClickHandled(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as unknown as { __notificationHandled: boolean }).__notificationHandled)).toBe(true);
}

for (const target of ["アーカイブ済みIssue", "削除済み通知"] as const) test(`${target}をクリックして参照し、当該以外のリマインダーとコメントを未読に保つ`, async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "クリックするIssue" });
  await nod.me.subscribeIssue(issue.id);
  await nod.claude.commentIssue(issue.id, "残すコメント通知");
  await nod.me.setReminder(issue.id, { at: new Date(Date.now() + 300).toISOString(), note: "クリックする通知" });
  await expect.poll(async () => (await nod.me.listNotifications()).length).toBe(2);
  const notification = (await nod.me.listNotifications()).find(n => n.kind === "reminder")!;
  await nod.me.setReminder(issue.id, { at: new Date(Date.now() + 300).toISOString(), note: "残すリマインダー" });
  await expect.poll(async () => (await nod.me.listNotifications()).length).toBe(3);
  if (target === "アーカイブ済みIssue") await nod.me.archiveIssue(issue.id);
  else expect((await page.request.post("/api/notifications/delete", { data: { ids: [notification.id] } })).ok()).toBe(true);
  await installDesktopClick(page, issue.id, notification.id);
  await page.goto(`/issues/${issue.id}`);
  await expect(page.getByRole("heading", { name: issue.title, exact: true })).toBeVisible();
  await expectClickHandled(page);
  if (target === "アーカイブ済みIssue") {
    await expect(page.getByRole("region", { name: "アーカイブ済み" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Status", exact: true })).toBeDisabled();
    await nod.me.unarchiveIssue(issue.id);
  }
  const unread = await nod.me.listNotifications();
  expect(unread.map(n => n.kind).sort()).toEqual(["issue_change", "reminder"]);
  expect(unread.find(n => n.kind === "reminder")!.data.note).toBe("残すリマインダー");
});

test.describe("永久削除されたIssueへの通知クリック", () => {
  test.use({ allowedConsoleErrors: [/status of 404/] });
  test("見つからない案内の表示後に遷移を完了し、ほかの通知は既読にしない", async ({ page, nod }) => {
    const api = await seedApiWorkspace(nod);
    const issue = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "クリック前に永久削除" });
    const keep = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "残すIssue" });
    await nod.me.subscribeIssue(keep.id);
    await nod.claude.commentIssue(keep.id, "未読のまま残す");
    await nod.me.setReminder(issue.id, { at: new Date(Date.now() + 300).toISOString() });
    await expect.poll(async () => (await nod.me.listNotifications()).length).toBe(2);
    const notification = (await nod.me.listNotifications()).find(n => n.issueId === issue.id)!;
    await nod.me.archiveIssue(issue.id);
    await nod.me.deleteIssue(issue.id);
    await installDesktopClick(page, issue.id, notification.id);
    await page.goto(`/issues/${issue.id}`);
    await expect(page.getByRole("heading", { name: "Issue が見つかりません" })).toBeVisible();
    await expectClickHandled(page);
    expect((await nod.me.listNotifications()).map(n => n.issueId)).toEqual([keep.id]);
  });
});
