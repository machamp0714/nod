import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// Board のカードを別の列（または Hidden columns の行）へドラッグして status を変える

const column = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const card = (page: Page, id: string) => page.getByRole("article").filter({ hasText: id });
const hiddenRow = (page: Page, name: string) => page.getByRole("region", { name: "Hidden columns" }).getByRole("listitem").filter({ hasText: name });
const statusOf = async (page: Page, id: string) => (await (await page.request.get(`/api/issues/${id}`)).json()).status as string;

async function seed(nod: import("./support/nod").NodData) {
  const ws = (await nod.me.initWorkspace({ path: nod.repo("api-server"), key: "API", name: "api-server" })).workspace;
  const todo = (await nod.me.createIssue({ workspaceId: ws.id, title: "D1 ドラッグする" })).id;
  await nod.me.updateIssue(todo, { status: "todo" });
  const doing = (await nod.me.createIssue({ workspaceId: ws.id, title: "D2 作業中" })).id;
  await nod.me.updateIssue(doing, { status: "in_progress" });
  return { todo, doing };
}

test("カードを別の列に落とすと status が変わり、その列に移る", async ({ page, nod }) => {
  const { todo } = await seed(nod);
  await page.goto("/issues?layout=board");
  await expect(card(page, todo)).toBeVisible();

  await card(page, todo).dragTo(column(page, "In Progress"));
  await expect(column(page, "In Progress").getByRole("article").filter({ hasText: todo })).toBeVisible();
  expect(await statusOf(page, todo)).toBe("in_progress");
});

test("カードを Hidden columns の行に落とすと status が変わり、その列が現れる", async ({ page, nod }) => {
  const { todo } = await seed(nod);
  await page.goto("/issues?layout=board");
  await expect(hiddenRow(page, "Done")).toBeVisible();

  await card(page, todo).dragTo(hiddenRow(page, "Done"));
  await expect(column(page, "Done").getByRole("article").filter({ hasText: todo })).toBeVisible();
  expect(await statusOf(page, todo)).toBe("done");
});

test.describe("遷移ルールで拒否されたとき", () => {
  test.use({ allowedConsoleErrors: [/status of 409/] });

  test("エラーを出し、カードは元の列に残る", async ({ page, nod }) => {
    const { todo } = await seed(nod);
    await nod.me.setTransitionRules("API", { forbidden: [{ from: "todo", to: "in_progress" }] });
    await page.goto("/issues?layout=board");

    await card(page, todo).dragTo(column(page, "In Progress"));
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(todo);
    await expect(column(page, "Todo").getByRole("article").filter({ hasText: todo })).toBeVisible();
    expect(await statusOf(page, todo)).toBe("todo");
  });
});
