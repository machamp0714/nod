import { expect, test } from "./fixtures";

test.use({ dataset: "issue-list" });

test("Web設定を保存し、対象外から判定失敗・待機・再試行・記録のみ再評価へ進める", async ({ page, nod }) => {
  await page.goto("/workspaces/API/settings");
  const setting = page.getByRole("region", { name: "仕様要否の自動判定", exact: true });
  await setting.getByRole("radio", { name: "有効", exact: true }).check();
  await expect(page.getByRole("status")).toHaveText("保存しました");
  await page.reload();
  await expect(setting.getByRole("radio", { name: "有効", exact: true })).toBeChecked();
  const workspaces = await nod.me.listWorkspaces();
  const ws = workspaces.find(w => w.key === "API")!;
  expect(ws.specAssessmentEnabled).toBe(true);
  const issue = await nod.me.createIssue({ workspaceId: ws.id, title: "判定の回復", description: "失敗例" });
  await page.goto(`/issues/${issue.id}`);
  const section = page.getByRole("region", { name: "仕様要否判定", exact: true });
  await expect(section.getByText("判定待ち", { exact: true })).toBeVisible();
  await section.getByRole("button", { name: "判定を再試行" }).click();
  await expect(section.getByRole("status")).toHaveText("判定の応答を待っています…");
  await expect(section.getByText("判定失敗：待機時間を超えました")).toBeVisible();
  await nod.me.updateIssue(issue.id, { description: "最新本文" });
  await section.getByRole("button", { name: "判定を再試行" }).click();
  await expect(section.getByText("判定済み：仕様整理が必要（確率 0.9）")).toBeVisible();
  await nod.me.updateIssue(issue.id, { removeLabels: ["needs-spec"] });
  await section.getByRole("button", { name: "判定を再評価（ラベルは変更しません）" }).click();
  await expect(section.getByRole("status")).toHaveCount(0);
  expect((await nod.me.getIssue(issue.id)).labels).not.toContain("needs-spec");
  await expect(section.getByText(/過去の判定記録/)).toBeVisible();
  await page.goto("/workspaces/API/settings");
  await setting.getByRole("radio", { name: "無効", exact: true }).check();
  await expect(page.getByRole("status")).toHaveText("保存しました");
  const excluded = await nod.me.createIssue({ workspaceId: ws.id, title: "対象外" });
  await page.goto(`/issues/${excluded.id}`);
  await expect(section.getByText("対象外（未判定）")).toBeVisible();
  await expect(section.getByRole("button")).toHaveCount(0);
});
