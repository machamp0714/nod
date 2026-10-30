import { expect, test } from "./fixtures";

test.use({ dataset: "sprint-history" });

test("選択Workspaceに現在Sprintがなければ、他Workspaceの現在とは分けて空を示す", async ({ page, nod }) => {
  await nod.me.initWorkspace({ path: nod.repo("idle"), key: "IDLE", name: "現在なしのWorkspace" });
  await page.goto("/issues?workspace=IDLE&sprint=current");
  await expect(page.getByText("現在のSprintはありません", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator("tr[data-issue-row]")).toHaveCount(0);
});
