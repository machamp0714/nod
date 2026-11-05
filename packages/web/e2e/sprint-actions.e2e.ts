import { expect, test } from "./fixtures";

test.use({ dataset: "sprint-history" });

test("Issue詳細はSprintの由来を表示し、旧Cycle直接所属を提供しない", async ({ page }) => {
  await page.goto("/issues/AAA-1");
  const properties = page.getByRole("region", { name: "プロパティ" });
  await expect(properties.getByRole("link", { name: "過去（移行履歴）", exact: true })).toBeVisible();
  await expect(properties.getByRole("link", { name: "実行 12（採択）", exact: true })).toBeVisible();
  await expect(properties.getByRole("button", { name: "Cycle" })).toHaveCount(0);
});

test("公開APIで実行中のSprintへ追加したIssueは、再読込後もSprint詳細・Issue詳細（由来「追加」）・Sprintの絞り込みに所属として出る", async ({ page, nod }) => {
  const issue = await nod.me.createIssue({ workspaceId: 1, title: "実行中への差し込み" });
  const row = page.locator(`tr[data-issue-row="${issue.id}"]`);
  await page.goto("/sprints/12");
  await expect(page.locator('tr[data-issue-row="AAA-1"]')).toBeVisible();
  await expect(row).toHaveCount(0);
  // Issue詳細のSprint選択UI（NOD-56）は前提にせず、公開のHTTPだけで追加する。合意・版・requestKeyは送らない
  const response = await page.request.post("/api/sprints/12/issues", { data: { issueRef: issue.id } });
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ added: true, item: { sourceIssueKey: issue.id, association: "added", addedBy: "me" } });
  await page.reload();
  await expect(row).toBeVisible();
  await page.goto(`/issues/${issue.id}`);
  const properties = page.getByRole("region", { name: "プロパティ" });
  await expect(properties.getByRole("link", { name: "実行 12（追加）", exact: true })).toBeVisible();
  await page.reload();
  await expect(properties.getByRole("link", { name: "実行 12（追加）", exact: true })).toBeVisible();
  for (const sprint of ["12", "current"]) {
    await page.goto(`/issues?sprint=${sprint}&columns=["status","sprint"]`);
    await expect(row).toBeVisible();
    await expect(row.locator('[title="実行 12（追加）"]')).toBeVisible();
    await page.reload();
    await expect(row).toBeVisible();
  }
  // 保存した現在Viewにも所属として出る。旧候補だけのIssueは追加し直すまで所属にならない
  await page.goto("/views/1");
  await expect(row).toBeVisible();
  await expect(page.getByText("候補のみ", { exact: true })).toHaveCount(0);
  await page.goto(`/issues?sprint=none`);
  await expect(page.locator('tr[data-issue-row]').first()).toBeVisible();
  await expect(row).toHaveCount(0);
});
