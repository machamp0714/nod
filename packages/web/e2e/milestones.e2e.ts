import type { Page } from "@playwright/test";
import { expect, test, waitForServerEvents } from "./fixtures";

test.use({ dataset: "issue-list" });

const section = (page: Page) => page.getByRole("region", { name: "Milestones" });
const row = (page: Page, name: string) => section(page).getByRole("listitem", { name: `Milestone ${name}` });
const tableRows = (page: Page) => page.getByRole("table").locator("tbody tr");

async function addMilestone(page: Page, name: string, date?: string, description?: string) {
  await section(page).getByRole("button", { name: "Milestone を追加" }).click();
  const form = section(page).getByRole("form", { name: "Milestone の追加" });
  await form.getByLabel("名前").fill(name);
  if (date) await form.getByLabel("目標日").fill(date);
  if (description) await form.getByLabel("説明").fill(description);
  await form.getByRole("button", { name: "保存" }).click();
}

test.describe("Project 詳細", () => {
test.use({ allowedConsoleErrors: [/status of 409/] });
test("Project 詳細で Milestone を追加・編集・削除し、進捗（完了数/総数）を確かめられる", async ({ page, nod }) => {
  await page.goto("/projects/1?q=API");
  await expect(section(page).getByText("Milestone はありません")).toBeVisible();

  await addMilestone(page, "v1.0", "2026-10-15", "N+1 解消まで");
  await expect(row(page, "v1.0")).toContainText("2026-10-15");
  await expect(row(page, "v1.0")).toContainText("0/0");
  await expect(row(page, "v1.0")).toContainText("N+1 解消まで");
  await expect(section(page).getByRole("form")).toHaveCount(0);

  // 同じ名前は理由を出して入力を残す
  await section(page).getByRole("button", { name: "Milestone を追加" }).click();
  const form = section(page).getByRole("form", { name: "Milestone の追加" });
  await form.getByLabel("名前").fill("v1.0");
  await form.getByRole("button", { name: "保存" }).click();
  await expect(form.getByRole("alert")).toHaveText("保存できませんでした：同じ名前の Milestone「v1.0」があります");
  await expect(form.getByLabel("名前")).toHaveValue("v1.0");
  await expect(form.getByLabel("名前")).toHaveAttribute("aria-invalid", "true");
  await form.getByRole("button", { name: "キャンセル" }).click();

  const [m] = await nod.me.listMilestones("1");
  await nod.me.updateIssue("API-13", { milestoneRef: String(m!.id) });
  await nod.me.updateIssue("API-9", { milestoneRef: String(m!.id), status: "done" });
  await expect(row(page, "v1.0")).toContainText("1/2");
  await expect(row(page, "v1.0").getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");

  await row(page, "v1.0").getByRole("button", { name: "v1.0 を編集" }).click();
  const edit = section(page).getByRole("form", { name: "Milestone「v1.0」の編集" });
  await edit.getByLabel("名前").fill("v1.1");
  await edit.getByLabel("目標日").fill("");
  await edit.getByRole("button", { name: "保存" }).click();
  await expect(row(page, "v1.1")).toContainText("—");
  expect((await nod.me.listMilestones("1")).map((x) => [x.name, x.targetDate, x.description])).toEqual([["v1.1", null, "N+1 解消まで"]]);

  await row(page, "v1.1").getByRole("button", { name: "v1.1 を削除" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Milestone「v1.1」を削除しますか？" });
  await expect(dialog).toContainText("Issue の Milestone は外れます。Issue 自体は残ります。");
  await dialog.getByRole("button", { name: "削除する" }).click();
  await expect(section(page).getByText("Milestone はありません")).toBeVisible();
  const issue = await nod.me.getIssue("API-13");
  expect(issue.milestone).toBeNull();
  expect(issue.project?.id).toBe(1);
  await expect(page).toHaveURL(/q=API/);
});
});

test("Issue 詳細で同じ Project の Milestone だけを選べ、Project を外すと Milestone も外れる", async ({ page, nod }) => {
  await nod.me.createMilestone("1", { name: "v1.0" });
  await nod.me.createMilestone("2", { name: "別 Project の目標" });
  const loose = await nod.me.createIssue({ workspaceId: 1, title: "Project なし" });

  await page.goto(`/issues/${loose.id}`);
  const props = page.getByRole("region", { name: "プロパティ" });
  await expect(props.getByRole("combobox", { name: "Milestone" })).toBeDisabled();
  await expect(props.getByText("Project を設定すると選べます")).toBeVisible();

  await page.goto("/issues/API-13");
  await waitForServerEvents(page);
  const select = page.getByRole("region", { name: "プロパティ" }).getByRole("combobox", { name: "Milestone" });
  await expect(select.locator("option")).toHaveText(["なし", "v1.0"]);
  await select.selectOption({ label: "v1.0" });
  await expect(select).toHaveValue(/\d+/);
  expect((await nod.me.getIssue("API-13")).milestone?.name).toBe("v1.0");
  await expect(page.getByText("me が Milestone を なし から v1.0 に変えた")).toBeVisible();

  await page.getByRole("region", { name: "プロパティ" }).getByRole("combobox", { name: "Project" }).selectOption("");
  await expect(select).toBeDisabled();
  expect((await nod.me.getIssue("API-13")).milestone).toBeNull();
});

test("Issues を Milestone で絞り込み、URL と View に保存して復元できる", async ({ page, nod }) => {
  const m = await nod.me.createMilestone("1", { name: "v1.0" });
  await nod.me.updateIssue("API-13", { milestoneRef: String(m.id) });

  await page.goto("/issues?q=API");
  await page.getByText("Filter", { exact: true }).click();
  const group = page.getByRole("group", { name: "Milestone" });
  await expect(group).toContainText("検索 API の高速化");
  await group.getByText("v1.0", { exact: true }).click();
  await expect(group.getByRole("radio", { name: /v1\.0/ })).toBeChecked();
  // TanStack Router は数字だけの文字列を引用符つきで URL に書く（milestone=%221%22）
  await expect(page).toHaveURL(new RegExp(`milestone=(%22)?${m.id}(%22)?(&|$)`));
  await expect(page).toHaveURL(/q=API/);
  await expect(tableRows(page)).toHaveCount(1);
  await expect(tableRows(page).first()).toContainText("API-13");
  const chip = page.getByRole("button", { name: "Milestone の条件を外す" }).locator("..");
  await expect(chip).toHaveText("Milestoneisv1.0");

  await page.reload();
  await expect(tableRows(page)).toHaveCount(1);

  await page.getByText("Filter", { exact: true }).click();
  await page.getByRole("group", { name: "Milestone" }).getByText("Milestone なし", { exact: true }).click();
  await expect(page).toHaveURL(/milestone=none/);
  await expect(page.getByRole("table")).not.toContainText("API-13");

  await page.getByRole("button", { name: "View として保存" }).click();
  const dialog = page.getByRole("dialog", { name: "View として保存" });
  await dialog.getByRole("textbox", { name: "名前" }).fill("Milestone なし");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Milestone なし" })).toBeVisible();
  const views = (await (await page.request.get("/api/views")).json()) as { filter: unknown }[];
  expect(views.at(-1)?.filter).toMatchObject({ milestone: "none" });

  await page.getByRole("button", { name: "Milestone の条件を外す" }).click();
  await expect(page).not.toHaveURL(/milestone=/);
});
