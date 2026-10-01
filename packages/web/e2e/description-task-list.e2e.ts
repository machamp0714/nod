import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";
import { region } from "./helpers";

test("説明のチェックボックスを押すと、その項目の [ ] / [x] を書き換えて保存する", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await nod.me.createIssue({
    workspaceId: api.workspace.id, title: "受け入れ条件のある Issue", description: "## 受け入れ条件\n- [ ] 一つ目\n- [x] 二つ目\n\n- [ ] 空行のあと",
  });
  await page.goto(`/issues/${issue.id}`);
  const checkboxes = region(page, "説明").getByRole("checkbox");
  await expect(checkboxes).toHaveCount(3);

  await checkboxes.nth(0).check();
  await expect(checkboxes.nth(0)).toBeChecked();
  await expect.poll(async () => (await nod.me.getIssue(issue.id)).description).toBe("## 受け入れ条件\n- [x] 一つ目\n- [x] 二つ目\n\n- [ ] 空行のあと");

  await checkboxes.nth(1).uncheck();
  await checkboxes.nth(2).check();
  await expect.poll(async () => (await nod.me.getIssue(issue.id)).description).toBe("## 受け入れ条件\n- [x] 一つ目\n- [ ] 二つ目\n\n- [x] 空行のあと");
});
